/**
 * DataBackend - Abstract interface for agent-specific session data layouts.
 *
 * Each backend knows how to discover projects/sessions, resolve paths,
 * parse session files, and locate auxiliary resources (subagents, memory, todos)
 * for one agent implementation (e.g. Claude Code, Kimi Code).
 */

import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';
import type { Project, SessionFileMetadata } from '@main/types';
import type { ParsedMessage } from '@main/types/messages';

/**
 * Configuration passed to every backend constructor.
 */
export interface DataBackendConfig {
  /** Root data directory (e.g. ~/.claude or ~/.kimi-code) */
  rootPath: string;
  /** Filesystem provider for all I/O */
  fsProvider: FileSystemProvider;
  /** Optional override for the projects directory. Defaults to root/projects. */
  projectsDir?: string;
  /** Optional override for the todos directory. Defaults to root/todos. */
  todosDir?: string;
}

/**
 * Options for listing sessions.
 */
export interface ListSessionsOptions {
  /** Filter out sessions that contain only noise */
  filterNoise?: boolean;
  /** Maximum number of sessions to return */
  limit?: number;
}

/**
 * Raw session file information returned by backends.
 */
export interface SessionFileInfo {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  birthtimeMs: number;
  size: number;
  /** Alias for mtimeMs, used by paginated listings */
  timestamp: number;
}

/**
 * Abstract backend interface.
 */
export interface DataBackend {
  /** Human-readable backend name */
  readonly name: string;
  /** Root data directory */
  readonly rootPath: string;
  /** Filesystem provider */
  readonly fsProvider: FileSystemProvider;

  // ========================================================================
  // Discovery
  // ========================================================================

  /**
   * List all projects/worktrees known to this backend.
   */
  listProjects(): Promise<Project[]>;

  /**
   * List all session files for a project.
   */
  listSessionFiles(projectId: string): Promise<SessionFileInfo[]>;

  /**
   * Get a single project's metadata if it exists.
   */
  getProject(projectId: string): Promise<Project | null>;

  // ========================================================================
  // Path resolution
  // ========================================================================

  /**
   * Resolve the path to a session JSONL/wire file.
   */
  getSessionPath(projectId: string, sessionId: string): Promise<string>;

  /**
   * Extract the working directory from a session file.
   */
  extractCwd(filePath: string): Promise<string | null>;

  // ========================================================================
  // Parsing
  // ========================================================================

  /**
   * Parse a session file into the application's internal message model.
   */
  parseSessionFile(filePath: string): Promise<ParsedMessage[]>;

  /**
   * Analyze a session file for lightweight metadata (used in listings).
   */
  analyzeSessionFileMetadata(filePath: string): Promise<SessionFileMetadata>;

  /**
   * Check whether a session file contains any displayable (non-noise) content.
   */
  hasDisplayableContent(filePath: string): Promise<boolean>;

  // ========================================================================
  // Auxiliary resources
  // ========================================================================

  /**
   * List subagent session files for a session.
   */
  listSubagentFiles(projectId: string, sessionId: string): Promise<string[]>;

  /**
   * Check whether a project has a memory directory.
   */
  hasMemory(projectId: string): Promise<boolean>;

  /**
   * Return the memory directory for a project, or null if none.
   * Synchronous because callers use it in synchronous path helpers.
   */
  getMemoryDir(projectId: string): string | null;

  /**
   * Return the task-list file path for a session, or null if none.
   */
  getTodoPath(sessionId: string): string | null;
}
