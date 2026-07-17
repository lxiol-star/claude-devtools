/**
 * ClaudeBackend - DataBackend implementation for Claude Code.
 *
 * Mirrors the original ~/.claude layout:
 *   ~/.claude/projects/<encoded_path>/<session_uuid>.jsonl
 *   ~/.claude/projects/<encoded_path>/<session_uuid>/subagents/agent-*.jsonl
 *   ~/.claude/projects/<encoded_path>/memory/
 *   ~/.claude/todos/<session_uuid>.json
 */

import { SessionContentFilter } from '@main/services/discovery/SessionContentFilter';
import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import {
  analyzeSessionFileMetadata as analyzeJsonlMetadata,
  extractCwd as extractJsonlCwd,
  parseJsonlFile,
} from '@main/utils/jsonl';
import {
  buildSessionPath,
  buildSubagentsPath,
  decodePath,
  extractBaseDir,
  extractProjectName,
  extractSessionId,
  getProjectsBasePath,
  getTodosBasePath,
  isValidEncodedPath,
} from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import type { DataBackend, DataBackendConfig, SessionFileInfo } from './DataBackend';
import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';
import type { Project, SessionFileMetadata } from '@main/types';
import type { ParsedMessage } from '@main/types/messages';

const logger = createLogger('Backend:Claude');

export class ClaudeBackend implements DataBackend {
  readonly name = 'claude';
  readonly rootPath: string;
  readonly fsProvider: FileSystemProvider;
  private readonly projectsDir: string;
  private readonly todosDir: string;

  constructor(config: DataBackendConfig) {
    this.rootPath = config.rootPath;
    this.fsProvider = config.fsProvider ?? new LocalFileSystemProvider();
    this.projectsDir = config.projectsDir ?? getProjectsBasePath();
    this.todosDir = config.todosDir ?? getTodosBasePath();
  }

  static detect(rootPath: string, fsProvider?: FileSystemProvider): boolean {
    const fs = fsProvider ?? new LocalFileSystemProvider();
    // Claude Code is detected by the presence of projects/ or sessions/ (legacy).
    return (
      (fs.existsSync?.(path.join(rootPath, 'projects')) ?? false) ||
      (fs.existsSync?.(path.join(rootPath, 'sessions')) ?? false)
    );
  }

  // ========================================================================
  // Discovery
  // ========================================================================

  async listProjects(): Promise<Project[]> {
    if (!(await this.fsProvider.exists(this.projectsDir))) {
      return [];
    }

    const entries = await this.fsProvider.readdir(this.projectsDir);
    const projectDirs = entries.filter(
      (entry) => entry.isDirectory() && isValidEncodedPath(entry.name)
    );

    const projects: Project[] = [];
    for (const dir of projectDirs) {
      const project = await this.scanProject(dir.name);
      if (project) {
        projects.push(project);
      }
    }

    projects.sort((a, b) => (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0));
    return projects;
  }

  private async scanProject(encodedName: string): Promise<Project | null> {
    const projectPath = path.join(this.projectsDir, encodedName);
    if (!(await this.fsProvider.exists(projectPath))) {
      return null;
    }

    const entries = await this.fsProvider.readdir(projectPath);
    const sessionFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith('.jsonl')
    );

    if (sessionFiles.length === 0) {
      return null;
    }

    let mostRecentSession = 0;
    let createdAt = Date.now();
    const sessionIds: string[] = [];
    let resolvedCwd: string | null = null;

    for (const file of sessionFiles) {
      const sessionId = extractSessionId(file.name);
      const filePath = path.join(projectPath, file.name);
      sessionIds.push(sessionId);

      try {
        const stats = await this.fsProvider.stat(filePath);
        if (stats.mtimeMs > mostRecentSession) {
          mostRecentSession = stats.mtimeMs;
        }
        if (stats.birthtimeMs < createdAt) {
          createdAt = stats.birthtimeMs;
        }

        if (!resolvedCwd) {
          resolvedCwd = await extractJsonlCwd(filePath, this.fsProvider);
        }
      } catch {
        // Ignore unreadable files
      }
    }

    const decodedPath = resolvedCwd ?? decodePath(encodedName);
    const name = extractProjectName(encodedName, resolvedCwd ?? undefined);

    return {
      id: encodedName,
      path: decodedPath,
      name,
      sessions: sessionIds,
      createdAt: Math.floor(createdAt),
      mostRecentSession: Math.floor(mostRecentSession),
    };
  }

  async listSessionFiles(projectId: string): Promise<SessionFileInfo[]> {
    const baseDir = extractBaseDir(projectId);
    const projectPath = path.join(this.projectsDir, baseDir);

    if (!(await this.fsProvider.exists(projectPath))) {
      return [];
    }

    const entries = await this.fsProvider.readdir(projectPath);
    const sessionFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith('.jsonl')
    );

    const result: SessionFileInfo[] = [];
    for (const file of sessionFiles) {
      const filePath = path.join(projectPath, file.name);
      try {
        const stats = await this.fsProvider.stat(filePath);
        result.push({
          sessionId: extractSessionId(file.name),
          filePath,
          mtimeMs: stats.mtimeMs,
          birthtimeMs: stats.birthtimeMs,
          size: stats.size,
          timestamp: stats.mtimeMs,
        });
      } catch {
        // Ignore unreadable files
      }
    }

    return result;
  }

  async getProject(projectId: string): Promise<Project | null> {
    return this.scanProject(extractBaseDir(projectId));
  }

  // ========================================================================
  // Path resolution
  // ========================================================================

  async getSessionPath(projectId: string, sessionId: string): Promise<string> {
    return buildSessionPath(this.projectsDir, projectId, sessionId);
  }

  async extractCwd(filePath: string): Promise<string | null> {
    return extractJsonlCwd(filePath, this.fsProvider);
  }

  // ========================================================================
  // Parsing
  // ========================================================================

  async parseSessionFile(filePath: string): Promise<ParsedMessage[]> {
    return parseJsonlFile(filePath, this.fsProvider);
  }

  async analyzeSessionFileMetadata(filePath: string): Promise<SessionFileMetadata> {
    return analyzeJsonlMetadata(filePath, this.fsProvider);
  }

  async hasDisplayableContent(filePath: string): Promise<boolean> {
    return SessionContentFilter.hasNonNoiseMessages(filePath, this.fsProvider);
  }

  // ========================================================================
  // Auxiliary resources
  // ========================================================================

  async listSubagentFiles(projectId: string, sessionId: string): Promise<string[]> {
    const allFiles: string[] = [];

    // NEW structure: {project}/{session}/subagents/agent-*.jsonl
    const newSubagentsPath = buildSubagentsPath(this.projectsDir, projectId, sessionId);
    if (await this.fsProvider.exists(newSubagentsPath)) {
      try {
        const entries = await this.fsProvider.readdir(newSubagentsPath);
        const newFiles = entries
          .filter(
            (entry) =>
              entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')
          )
          .map((entry) => path.join(newSubagentsPath, entry.name));
        allFiles.push(...newFiles);
      } catch (error) {
        logger.debug(`Error scanning NEW subagent structure for ${sessionId}:`, error);
      }
    }

    // OLD structure: {project}/agent-*.jsonl (filter by sessionId)
    const baseDir = extractBaseDir(projectId);
    const projectPath = path.join(this.projectsDir, baseDir);
    if (await this.fsProvider.exists(projectPath)) {
      try {
        const entries = await this.fsProvider.readdir(projectPath);
        const oldFiles = entries
          .filter(
            (entry) => entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')
          )
          .map((entry) => path.join(projectPath, entry.name));

        for (const filePath of oldFiles) {
          if (await this.subagentBelongsToSession(filePath, sessionId)) {
            allFiles.push(filePath);
          }
        }
      } catch (error) {
        logger.debug(`Error scanning OLD subagent structure for ${projectId}:`, error);
      }
    }

    return allFiles;
  }

  private async subagentBelongsToSession(filePath: string, sessionId: string): Promise<boolean> {
    try {
      const content = await this.fsProvider.readFile(filePath);
      const firstNewline = content.indexOf('\n');
      const firstLine = firstNewline > 0 ? content.slice(0, firstNewline) : content;
      if (!firstLine.trim()) {
        return false;
      }
      const entry = JSON.parse(firstLine) as { sessionId?: string };
      return entry.sessionId === sessionId;
    } catch {
      return false;
    }
  }

  async hasMemory(projectId: string): Promise<boolean> {
    const dir = this.getMemoryDir(projectId);
    if (!dir || !(await this.fsProvider.exists(dir))) return false;
    try {
      const entries = await this.fsProvider.readdir(dir);
      return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'));
    } catch {
      return false;
    }
  }

  getMemoryDir(projectId: string): string | null {
    return path.join(this.projectsDir, extractBaseDir(projectId), 'memory');
  }

  getTodoPath(sessionId: string): string | null {
    // Use the injected todosDir directly rather than re-deriving it from
    // rootPath. For all current call paths todosDir === rootPath/todos, but
    // honoring the configured value keeps this correct if todosDir is ever
    // pointed somewhere independent of rootPath.
    return path.join(this.todosDir, `${sessionId}.json`);
  }
}
