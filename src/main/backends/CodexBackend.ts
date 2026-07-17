/**
 * CodexBackend - DataBackend implementation for OpenAI Codex CLI.
 *
 * Layout:
 *   ~/.codex/session_index.jsonl
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
 *   ~/.codex/memories/   (optional git-backed memory)
 */

import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import {
  analyzeCodexWireMetadata,
  parseCodexWireFile,
} from '@main/utils/codexWireParser';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import type { DataBackend, DataBackendConfig, SessionFileInfo } from './DataBackend';
import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';
import type { Project, SessionFileMetadata } from '@main/types';
import type { ParsedMessage } from '@main/types/messages';

const logger = createLogger('Backend:Codex');

function hasCodexRolloutFiles(dirPath: string, fs: FileSystemProvider): boolean {
  if (!fs.readdirSync) {
    return false;
  }
  try {
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        return true;
      }
      if (entry.isDirectory()) {
        if (hasCodexRolloutFiles(entryPath, fs)) {
          return true;
        }
      }
    }
  } catch {
    // ignore
  }
  return false;
}

interface CodexSessionIndexEntry {
  id: string;
  thread_name: string;
  updated_at: string;
}

export class CodexBackend implements DataBackend {
  readonly name = 'codex';
  readonly rootPath: string;
  readonly fsProvider: FileSystemProvider;
  private readonly sessionsDir: string;
  private readonly indexPath: string;
  private indexCache: Map<string, CodexSessionIndexEntry & { filePath: string }> | null = null;
  private indexMtimeMs: number | null = null;

  constructor(config: DataBackendConfig) {
    this.rootPath = config.rootPath;
    this.fsProvider = config.fsProvider ?? new LocalFileSystemProvider();
    this.sessionsDir = path.join(this.rootPath, 'sessions');
    this.indexPath = path.join(this.rootPath, 'session_index.jsonl');
  }

  static detect(rootPath: string, fsProvider?: FileSystemProvider): boolean {
    const fs = fsProvider ?? new LocalFileSystemProvider();
    if (
      !(fs.existsSync?.(path.join(rootPath, 'session_index.jsonl')) ?? false) ||
      !(fs.existsSync?.(path.join(rootPath, 'sessions')) ?? false)
    ) {
      return false;
    }

    // Distinguish from Kimi Code: Codex stores sessions as rollout-*.jsonl
    // under sessions/YYYY/MM/DD, while Kimi uses wd_<workdir>_<hash>/sessionId/.
    return hasCodexRolloutFiles(path.join(rootPath, 'sessions'), fs);
  }

  // =======================================================================
  // Index loading
  // =======================================================================

  private async loadIndex(): Promise<Map<string, CodexSessionIndexEntry & { filePath: string }>> {
    if (!(await this.fsProvider.exists(this.indexPath))) {
      this.indexCache = new Map();
      this.indexMtimeMs = null;
      return this.indexCache;
    }

    try {
      const stats = await this.fsProvider.stat(this.indexPath);
      if (this.indexCache && this.indexMtimeMs === stats.mtimeMs) {
        return this.indexCache;
      }

      const index = new Map<string, CodexSessionIndexEntry & { filePath: string }>();
      const content = await this.fsProvider.readFile(this.indexPath);
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as CodexSessionIndexEntry;
          if (entry.id) {
            const filePath = await this.findSessionFile(entry.id);
            if (filePath) {
              index.set(entry.id, { ...entry, filePath });
            }
          }
        } catch {
          // Ignore malformed index lines
        }
      }

      this.indexCache = index;
      this.indexMtimeMs = stats.mtimeMs;
      return index;
    } catch (error) {
      logger.error(`Error reading Codex session index ${this.indexPath}:`, error);
      this.indexCache = new Map();
      this.indexMtimeMs = null;
      return this.indexCache;
    }
  }

  private async findSessionFile(sessionId: string): Promise<string | null> {
    // Codex filenames look like rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl.
    // Walk the directory tree looking for any .jsonl file whose name ends
    // with the session UUID.
    if (!(await this.fsProvider.exists(this.sessionsDir))) {
      return null;
    }

    const suffix = `-${sessionId}.jsonl`;

    try {
      const found = await this.findFileBySuffix(this.sessionsDir, suffix);
      if (found) return found;
    } catch (error) {
      logger.debug(`Error searching for Codex session ${sessionId}:`, error);
    }

    return null;
  }

  private async findFileBySuffix(dirPath: string, suffix: string): Promise<string | null> {
    const entries = await this.fsProvider.readdir(dirPath);
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const found = await this.findFileBySuffix(entryPath, suffix);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return entryPath;
      }
    }
    return null;
  }

  private async resolveFilePath(filePathOrSessionId: string): Promise<string | null> {
    if (path.isAbsolute(filePathOrSessionId) && filePathOrSessionId.includes('sessions')) {
      return filePathOrSessionId;
    }
    return this.findSessionFile(filePathOrSessionId);
  }

  private getDisplayName(threadName: string): string {
    return threadName || 'Untitled';
  }

  // =======================================================================
  // Discovery
  // =======================================================================

  async listProjects(): Promise<Project[]> {
    const index = await this.loadIndex();

    // Codex CLI does not expose a stable project/worktree grouping in the index.
    // Group sessions by cwd extracted from the session file's session_meta payload.
    const cwdGroups = new Map<string, { sessions: string[]; threadNames: string[] }>();

    for (const [sessionId, entry] of index) {
      const cwd = await this.extractCwd(entry.filePath);
      const key = cwd ?? '__unknown__';
      const existing = cwdGroups.get(key);
      if (existing) {
        existing.sessions.push(sessionId);
        existing.threadNames.push(entry.thread_name);
      } else {
        cwdGroups.set(key, { sessions: [sessionId], threadNames: [entry.thread_name] });
      }
    }

    const projects: Project[] = [];
    for (const [cwd, group] of cwdGroups) {
      let mostRecentSession = 0;
      let createdAt = Date.now();

      for (const sessionId of group.sessions) {
        const entry = index.get(sessionId);
        if (!entry) continue;
        try {
          const stats = await this.fsProvider.stat(entry.filePath);
          if (stats.mtimeMs > mostRecentSession) {
            mostRecentSession = stats.mtimeMs;
          }
          if (stats.birthtimeMs < createdAt) {
            createdAt = stats.birthtimeMs;
          }
        } catch {
          // Ignore missing files
        }
      }

      const id = this.encodeProjectId(cwd);
      const displayName =
        cwd === '__unknown__'
          ? group.threadNames[0] || 'Unknown'
          : this.getDisplayName(path.basename(cwd));

      projects.push({
        id,
        path: cwd === '__unknown__' ? '' : cwd,
        name: displayName,
        sessions: group.sessions,
        createdAt: Math.floor(createdAt),
        mostRecentSession: Math.floor(mostRecentSession),
      });
    }

    projects.sort((a, b) => (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0));
    return projects;
  }

  async listSessionFiles(projectId: string): Promise<SessionFileInfo[]> {
    const index = await this.loadIndex();
    const cwd = this.decodeProjectId(projectId);
    const result: SessionFileInfo[] = [];

    for (const [sessionId, entry] of index) {
      const sessionCwd = await this.extractCwd(entry.filePath);
      const matches = cwd === '__unknown__' ? sessionCwd == null : sessionCwd === cwd;
      if (!matches) continue;
      try {
        const stats = await this.fsProvider.stat(entry.filePath);
        result.push({
          sessionId,
          filePath: entry.filePath,
          mtimeMs: stats.mtimeMs,
          birthtimeMs: stats.birthtimeMs,
          size: stats.size,
          timestamp: stats.mtimeMs,
        });
      } catch {
        // Skip missing files
      }
    }

    return result;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const projects = await this.listProjects();
    return projects.find((p) => p.id === projectId) ?? null;
  }

  // =======================================================================
  // Path resolution
  // =======================================================================

  async getSessionPath(projectId: string, sessionId: string): Promise<string> {
    const index = await this.loadIndex();
    const entry = index.get(sessionId);
    if (entry) {
      return entry.filePath;
    }
    // Fallback: construct a sessions dir path with the UUID as filename.
    return path.join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  async extractCwd(filePath: string): Promise<string | null> {
    const resolved = await this.resolveFilePath(filePath);
    if (!resolved) return null;

    try {
      const content = await this.fsProvider.readFile(resolved);
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { type?: string; payload?: { cwd?: string } };
          if (event.type === 'session_meta' && event.payload?.cwd) {
            return event.payload.cwd;
          }
        } catch {
          // Ignore malformed lines
        }
      }
    } catch (error) {
      logger.debug(`Error extracting cwd from ${filePath}:`, error);
    }
    return null;
  }

  // =======================================================================
  // Parsing
  // =======================================================================

  async parseSessionFile(filePath: string): Promise<ParsedMessage[]> {
    const resolved = await this.resolveFilePath(filePath);
    if (!resolved) {
      return [];
    }
    return parseCodexWireFile(resolved, this.fsProvider);
  }

  async analyzeSessionFileMetadata(filePath: string): Promise<SessionFileMetadata> {
    const resolved = await this.resolveFilePath(filePath);
    if (!resolved) {
      return {
        firstUserMessage: null,
        messageCount: 0,
        isOngoing: false,
        gitBranch: null,
        hasDisplayableContent: false,
      };
    }
    return analyzeCodexWireMetadata(resolved, this.fsProvider);
  }

  async hasDisplayableContent(filePath: string): Promise<boolean> {
    const metadata = await this.analyzeSessionFileMetadata(filePath);
    return metadata.hasDisplayableContent;
  }

  // =======================================================================
  // Auxiliary resources
  // =======================================================================

  async listSubagentFiles(_projectId: string, _sessionId: string): Promise<string[]> {
    // Codex CLI does not store subagent sessions as separate JSONL files.
    return [];
  }

  async hasMemory(_projectId: string): Promise<boolean> {
    const memoriesDir = path.join(this.rootPath, 'memories');
    if (!(await this.fsProvider.exists(memoriesDir))) return false;
    try {
      const entries = await this.fsProvider.readdir(memoriesDir);
      return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'));
    } catch {
      return false;
    }
  }

  getMemoryDir(_projectId: string): string | null {
    return path.join(this.rootPath, 'memories');
  }

  getTodoPath(_sessionId: string): string | null {
    return null;
  }

  // =======================================================================
  // Helpers
  // =======================================================================

  private encodeProjectId(cwd: string): string {
    return Buffer.from(cwd, 'utf8').toString('base64url');
  }

  private decodeProjectId(projectId: string): string {
    try {
      return Buffer.from(projectId, 'base64url').toString('utf8');
    } catch {
      return projectId;
    }
  }
}
