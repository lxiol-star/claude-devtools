/**
 * ServiceContext - Bundle of session-data services for a single workspace context.
 *
 * Responsibilities:
 * - Encapsulate all session-data services (ProjectScanner, SessionParser, etc.)
 * - Manage service lifecycle (creation, start, stop, dispose)
 * - Provide isolation between local and SSH contexts
 *
 * Each ServiceContext represents a complete service stack for one workspace:
 * - Local context: ~/.claude/projects/ on local filesystem
 * - SSH context: remote ~/.claude/projects/ over SFTP
 */

import { createBackend } from '@main/backends';
import { ChunkBuilder } from '@main/services/analysis/ChunkBuilder';
import { MemoryReader } from '@main/services/discovery/MemoryReader';
import { ProjectScanner } from '@main/services/discovery/ProjectScanner';
import { SubagentResolver } from '@main/services/discovery/SubagentResolver';
import { SessionParser } from '@main/services/parsing/SessionParser';
import {
  CACHE_CLEANUP_INTERVAL_MINUTES,
  CACHE_TTL_MINUTES,
  MAX_CACHE_SESSIONS,
} from '@shared/constants';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import { DataCache } from './DataCache';
import { FileWatcher } from './FileWatcher';

import type { FileSystemProvider } from './FileSystemProvider';
import type { DataBackend } from '@main/backends/DataBackend';
import type { DataBackendName } from '@shared/types/api';

const logger = createLogger('Infrastructure:ServiceContext');

/**
 * Configuration for creating a ServiceContext.
 */
export interface ServiceContextConfig {
  /** Unique identifier (e.g., 'local', 'ssh-myserver') */
  id: string;
  /** Context type */
  type: 'local' | 'ssh';
  /** Filesystem provider for this context */
  fsProvider: FileSystemProvider;
  /** Projects directory path (defaults to ~/.claude/projects) */
  projectsDir?: string;
  /** Todos directory path (defaults to ~/.claude/todos) */
  todosDir?: string;
  /** Optional display label for the context */
  label?: string;
  /** Optional backend identifier for local contexts (claude/kimi/codex) */
  backend?: 'claude' | 'kimi' | 'codex';
}

/**
 * ServiceContext - Isolated service bundle for one workspace context.
 *
 * Contains all session-data services configured for a specific workspace
 * (local or SSH). Services share the same FileSystemProvider and are
 * properly wired with dependencies.
 *
 * Lifecycle:
 * - Create: new ServiceContext(config)
 * - Start: context.start() — activates file watching and cache cleanup
 * - Pause: context.stopFileWatcher() — on context switch (SSH contexts only;
 *   local-type contexts keep watching so the aggregate "All" view stays live)
 * - Resume: context.startFileWatcher() — on context switch back
 * - Destroy: context.dispose() — cleans up all resources
 */
export class ServiceContext {
  /** Context identifier */
  readonly id: string;
  /** Context type */
  readonly type: 'local' | 'ssh';
  /** Display label (if provided) */
  readonly label?: string;
  /** Backend identifier (if provided) */
  readonly backendName?: DataBackendName;
  /** Filesystem provider */
  readonly fsProvider: FileSystemProvider;
  /** Data backend for this context (Claude or Kimi) */
  readonly backend: DataBackend;

  // Service instances
  readonly projectScanner: ProjectScanner;
  readonly memoryReader: MemoryReader;
  readonly sessionParser: SessionParser;
  readonly subagentResolver: SubagentResolver;
  readonly chunkBuilder: ChunkBuilder;
  readonly dataCache: DataCache;
  readonly fileWatcher: FileWatcher;

  private cleanupInterval: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(config: ServiceContextConfig) {
    this.id = config.id;
    this.type = config.type;
    this.label = config.label;
    this.backendName = config.backend;
    this.fsProvider = config.fsProvider;

    logger.info(`Creating ServiceContext: ${config.id} (${config.type})`);

    // Create services in dependency order
    const disableCache = process.env.CLAUDE_CONTEXT_DISABLE_CACHE === '1';

    // Derive root path from projectsDir (e.g. ~/.claude/projects -> ~/.claude).
    // An empty rootPath makes detectBackend('') return null and ClaudeBackend
    // fall back to the global getProjectsBasePath() — i.e. a secondary context
    // would silently scan the primary backend's directory (the exact bug the
    // dir-injection change fixed). Every real caller passes projectsDir, so
    // this is a guard against regressions, not an expected path.
    if (!config.projectsDir) {
      logger.warn(
        `ServiceContext "${config.id}" created without projectsDir; backend detection will fall back to the global default.`
      );
    }
    const rootPath = config.projectsDir ? path.dirname(config.projectsDir) : '';

    // 0. DataBackend - auto-detects Claude vs Kimi layout.
    // Must receive the context's own dirs: without them ClaudeBackend falls back
    // to the global getProjectsBasePath() (the primary root), which makes every
    // secondary context silently scan the primary backend's directory.
    this.backend = createBackend({
      rootPath,
      fsProvider: config.fsProvider,
      projectsDir: config.projectsDir,
      todosDir: config.todosDir,
      backend: config.backend,
    });

    // 1. ProjectScanner - delegates discovery to the backend
    this.projectScanner = new ProjectScanner(
      config.projectsDir,
      config.todosDir,
      config.fsProvider,
      this.backend
    );

    // 1b. MemoryReader - reads per-project memory via the backend
    this.memoryReader = new MemoryReader(config.projectsDir, config.fsProvider, this.backend);

    // 2. SessionParser - depends on ProjectScanner
    this.sessionParser = new SessionParser(this.projectScanner);

    // 3. SubagentResolver - depends on ProjectScanner
    this.subagentResolver = new SubagentResolver(this.projectScanner);

    // 4. ChunkBuilder - no dependencies
    this.chunkBuilder = new ChunkBuilder();

    // 5. DataCache - standalone service
    this.dataCache = new DataCache(MAX_CACHE_SESSIONS, CACHE_TTL_MINUTES, !disableCache);

    // 6. FileWatcher - uses fsProvider and dataCache
    this.fileWatcher = new FileWatcher(
      this.dataCache,
      config.projectsDir,
      config.todosDir,
      config.fsProvider
    );
    this.fileWatcher.setProjectScanner(this.projectScanner);

    logger.info(`ServiceContext created: ${config.id}`);
  }

  /**
   * Starts the file watcher and cache cleanup.
   * Call this after creating the context to activate monitoring.
   */
  start(): void {
    if (this.disposed) {
      logger.error(`Cannot start disposed context: ${this.id}`);
      return;
    }

    logger.info(`Starting ServiceContext: ${this.id}`);

    // Start file watcher
    this.fileWatcher.start();

    // Start cache auto-cleanup
    this.cleanupInterval = this.dataCache.startAutoCleanup(CACHE_CLEANUP_INTERVAL_MINUTES);
  }

  /**
   * Stops the file watcher (for pausing on context switch).
   * Does not dispose resources - can be resumed with startFileWatcher().
   */
  stopFileWatcher(): void {
    logger.info(`Stopping FileWatcher for context: ${this.id}`);
    this.fileWatcher.stop();
  }

  /**
   * Starts the file watcher (for resuming after context switch).
   */
  startFileWatcher(): void {
    if (this.disposed) {
      logger.error(`Cannot start FileWatcher on disposed context: ${this.id}`);
      return;
    }

    logger.info(`Starting FileWatcher for context: ${this.id}`);
    this.fileWatcher.start();
  }

  /**
   * Disposes all resources.
   * After calling dispose(), this context cannot be reused.
   */
  dispose(): void {
    if (this.disposed) {
      logger.warn(`ServiceContext already disposed: ${this.id}`);
      return;
    }

    logger.info(`Disposing ServiceContext: ${this.id}`);

    // Stop and dispose FileWatcher
    this.fileWatcher.dispose();

    // Dispose DataCache
    this.dataCache.dispose();

    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.disposed = true;

    logger.info(`ServiceContext disposed: ${this.id}`);
  }

  /**
   * Returns whether this context has been disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }
}
