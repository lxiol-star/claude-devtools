/**
 * KimiBackend - DataBackend implementation for Kimi Code.
 *
 * Layout:
 *   ~/.kimi-code/session_index.jsonl
 *   ~/.kimi-code/sessions/wd_<workdir>_<hash>/<sessionId>/
 *     ├── state.json
 *     ├── logs/kimi-code.log
 *     └── agents/
 *         ├── main/wire.jsonl
 *         └── <agent_name>/wire.jsonl
 */

import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import {
  analyzeKimiWireMetadata,
  parseKimiWireFile,
} from '@main/utils/kimiWireParser';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import type { DataBackend, DataBackendConfig, SessionFileInfo } from './DataBackend';
import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';
import type { Project, SessionFileMetadata } from '@main/types';
import type { ParsedMessage } from '@main/types/messages';

const logger = createLogger('Backend:Kimi');

interface KimiSessionIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

export class KimiBackend implements DataBackend {
  readonly name = 'kimi';
  readonly rootPath: string;
  readonly fsProvider: FileSystemProvider;
  private readonly sessionsDir: string;
  private readonly indexPath: string;
  private indexCache: Map<string, KimiSessionIndexEntry> | null = null;
  private indexMtimeMs: number | null = null;

  constructor(config: DataBackendConfig) {
    this.rootPath = config.rootPath;
    this.fsProvider = config.fsProvider ?? new LocalFileSystemProvider();
    this.sessionsDir = path.join(this.rootPath, 'sessions');
    this.indexPath = path.join(this.rootPath, 'session_index.jsonl');
  }

  static detect(rootPath: string, fsProvider?: FileSystemProvider): boolean {
    const fs = fsProvider ?? new LocalFileSystemProvider();
    return fs.existsSync?.(path.join(rootPath, 'session_index.jsonl')) ?? false;
  }

  // ========================================================================
  // Index loading
  // ========================================================================

  private async loadIndex(): Promise<Map<string, KimiSessionIndexEntry>> {
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

      const index = new Map<string, KimiSessionIndexEntry>();
      const content = await this.fsProvider.readFile(this.indexPath);
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as KimiSessionIndexEntry;
          if (entry.sessionId && entry.sessionDir) {
            index.set(entry.sessionId, entry);
          }
        } catch {
          // Ignore malformed index lines
        }
      }

      this.indexCache = index;
      this.indexMtimeMs = stats.mtimeMs;
      return index;
    } catch (error) {
      logger.error(`Error reading Kimi session index ${this.indexPath}:`, error);
      this.indexCache = new Map();
      this.indexMtimeMs = null;
      return this.indexCache;
    }
  }

  private async findSessionEntry(sessionId: string): Promise<KimiSessionIndexEntry | null> {
    const index = await this.loadIndex();
    return index.get(sessionId) ?? null;
  }

  private getMainWirePath(sessionDir: string): string {
    return path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  }

  private getDisplayName(workDir: string): string {
    const segments = workDir.split(/[/\\]/).filter(Boolean);
    return segments[segments.length - 1] ?? workDir;
  }

  // ========================================================================
  // Discovery
  // ========================================================================

  async listProjects(): Promise<Project[]> {
    const index = await this.loadIndex();

    // Group sessions by workDir
    const projectsByWorkDir = new Map<string, { workDir: string; sessions: string[] }>();
    for (const entry of index.values()) {
      const existing = projectsByWorkDir.get(entry.workDir);
      if (existing) {
        existing.sessions.push(entry.sessionId);
      } else {
        projectsByWorkDir.set(entry.workDir, { workDir: entry.workDir, sessions: [entry.sessionId] });
      }
    }

    const projects: Project[] = [];
    for (const { workDir, sessions } of projectsByWorkDir.values()) {
      let mostRecentSession = 0;
      let createdAt = Date.now();

      for (const sessionId of sessions) {
        const entry = index.get(sessionId);
        if (!entry) continue;
        const wirePath = this.getMainWirePath(entry.sessionDir);
        try {
          const stats = await this.fsProvider.stat(wirePath);
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

      // Project ID is a safe encoding of the workDir
      const id = this.encodeProjectId(workDir);
      projects.push({
        id,
        path: workDir,
        name: this.getDisplayName(workDir),
        sessions,
        createdAt: Math.floor(createdAt),
        mostRecentSession: Math.floor(mostRecentSession),
      });
    }

    projects.sort((a, b) => (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0));
    return projects;
  }

  async listSessionFiles(projectId: string): Promise<SessionFileInfo[]> {
    const index = await this.loadIndex();
    const workDir = this.decodeProjectId(projectId);
    const result: SessionFileInfo[] = [];

    for (const entry of index.values()) {
      if (entry.workDir !== workDir) continue;
      const wirePath = this.getMainWirePath(entry.sessionDir);
      try {
        const stats = await this.fsProvider.stat(wirePath);
        result.push({
          sessionId: entry.sessionId,
          filePath: wirePath,
          mtimeMs: stats.mtimeMs,
          birthtimeMs: stats.birthtimeMs,
          size: stats.size,
          timestamp: stats.mtimeMs,
        });
      } catch {
        // Skip missing wire files
      }
    }

    return result;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const projects = await this.listProjects();
    return projects.find((p) => p.id === projectId) ?? null;
  }

  // ========================================================================
  // Path resolution
  // ========================================================================

  async getSessionPath(projectId: string, sessionId: string): Promise<string> {
    // projectId is ignored; sessionId is authoritative via the index.
    const entry = await this.findSessionEntry(sessionId);
    if (entry) {
      return this.getMainWirePath(entry.sessionDir);
    }
    // Fallback: construct path from sessions dir. projectId encodes workDir.
    const workDir = this.decodeProjectId(projectId);
    const encoded = this.encodeWorkDirForPath(workDir);
    return path.join(this.sessionsDir, encoded, sessionId, 'agents', 'main', 'wire.jsonl');
  }

  async extractCwd(filePath: string): Promise<string | null> {
    // Extract sessionDir from wire path and look up workDir in index.
    const sessionDir = this.inferSessionDirFromWirePath(filePath);
    if (!sessionDir) return null;

    const index = await this.loadIndex();
    for (const entry of index.values()) {
      if (entry.sessionDir === sessionDir) {
        return entry.workDir;
      }
    }
    return null;
  }

  // ========================================================================
  // Parsing
  // ========================================================================

  async parseSessionFile(filePath: string): Promise<ParsedMessage[]> {
    return parseKimiWireFile(filePath, this.fsProvider);
  }

  async analyzeSessionFileMetadata(filePath: string): Promise<SessionFileMetadata> {
    return analyzeKimiWireMetadata(filePath, this.fsProvider);
  }

  async hasDisplayableContent(filePath: string): Promise<boolean> {
    const metadata = await analyzeKimiWireMetadata(filePath, this.fsProvider);
    return metadata.hasDisplayableContent;
  }

  // ========================================================================
  // Auxiliary resources
  // ========================================================================

  async listSubagentFiles(projectId: string, sessionId: string): Promise<string[]> {
    const entry = await this.findSessionEntry(sessionId);
    if (!entry) {
      // Fallback path construction
      const fallback = await this.getSessionPath(projectId, sessionId);
      const sessionDir = path.dirname(path.dirname(fallback)); // agents/main/wire.jsonl -> sessionDir
      return this.scanAgentWires(sessionDir);
    }

    return this.scanAgentWires(entry.sessionDir);
  }

  private async scanAgentWires(sessionDir: string): Promise<string[]> {
    const agentsDir = path.join(sessionDir, 'agents');
    if (!(await this.fsProvider.exists(agentsDir))) {
      return [];
    }

    const files: string[] = [];
    try {
      const entries = await this.fsProvider.readdir(agentsDir);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'main') continue;
        const wirePath = path.join(agentsDir, entry.name, 'wire.jsonl');
        if (await this.fsProvider.exists(wirePath)) {
          files.push(wirePath);
        }
      }
    } catch (error) {
      logger.debug(`Error scanning agent wires in ${agentsDir}:`, error);
    }

    return files;
  }

  async hasMemory(): Promise<boolean> {
    // Kimi Code does not store per-project memory in the data directory.
    return false;
  }

  getMemoryDir(): string | null {
    return null;
  }

  getTodoPath(): string | null {
    return null;
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private encodeProjectId(workDir: string): string {
    // Use a URL-safe base64 encoding so project IDs remain path-safe.
    return Buffer.from(workDir, 'utf8').toString('base64url');
  }

  private decodeProjectId(projectId: string): string {
    try {
      return Buffer.from(projectId, 'base64url').toString('utf8');
    } catch {
      return projectId;
    }
  }

  private encodeWorkDirForPath(workDir: string): string {
    // session directories are named wd_<sanitized>_<hash> in Kimi Code.
    // We do not regenerate them; this is only used as a fallback.
    const sanitized = workDir.replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `wd_${sanitized}`;
  }

  private inferSessionDirFromWirePath(filePath: string): string | null {
    // wire path: .../<sessionDir>/agents/main/wire.jsonl
    const normalized = path.normalize(filePath);
    const parts = normalized.split(path.sep);
    const agentsIndex = parts.lastIndexOf('agents');
    if (agentsIndex <= 1) return null;
    return parts.slice(0, agentsIndex).join(path.sep);
  }
}
