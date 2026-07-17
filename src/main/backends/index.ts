/**
 * Backend registry - auto-detects the correct DataBackend for a root directory.
 */

import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import { ClaudeBackend } from './ClaudeBackend';
import { CodexBackend } from './CodexBackend';
import { KimiBackend } from './KimiBackend';

import type { DataBackend, DataBackendConfig } from './DataBackend';
import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';
import type { DataBackendName } from '@shared/types/api';

const logger = createLogger('Backends');

export interface BackendConfig extends DataBackendConfig {
  /** Optional explicit backend name ('claude' | 'kimi' | 'codex'). When omitted, auto-detect. */
  backend?: DataBackendName;
}

/**
 * Detect which backend should handle the given root directory.
 * Returns the backend name or null if no known layout is found.
 */
export function detectBackend(
  rootPath: string,
  fsProvider?: FileSystemProvider
): 'claude' | 'kimi' | 'codex' | null {
  const fs = fsProvider ?? new LocalFileSystemProvider();

  // Codex CLI has a session_index.jsonl plus a sessions/ tree with rollout-*.jsonl files.
  if (CodexBackend.detect(rootPath, fs)) {
    return 'codex';
  }

  // Kimi Code has a session_index.jsonl at the root and session dirs named wd_*.sessionsDir
  if (KimiBackend.detect(rootPath, fs)) {
    return 'kimi';
  }

  // Claude Code uses projects/ or sessions/ at the root.
  if (
    fs.existsSync?.(path.join(rootPath, 'projects')) ||
    fs.existsSync?.(path.join(rootPath, 'sessions'))
  ) {
    return 'claude';
  }

  return null;
}

/**
 * Create a DataBackend for the given configuration.
 * Auto-detects the backend type when not explicitly specified.
 */
export function createBackend(config: BackendConfig): DataBackend {
  const fs = config.fsProvider ?? new LocalFileSystemProvider();
  const backendName = config.backend ?? detectBackend(config.rootPath, fs);

  if (backendName === 'codex') {
    logger.info(`Using CodexBackend for ${config.rootPath}`);
    return new CodexBackend(config);
  }

  if (backendName === 'kimi') {
    logger.info(`Using KimiBackend for ${config.rootPath}`);
    return new KimiBackend(config);
  }

  if (backendName === 'claude') {
    logger.info(`Using ClaudeBackend for ${config.rootPath}`);
    return new ClaudeBackend(config);
  }

  // Fallback to Claude backend for compatibility when detection fails.
  logger.warn(
    `Could not detect backend for ${config.rootPath}, falling back to ClaudeBackend`
  );
  return new ClaudeBackend(config);
}

export { ClaudeBackend, CodexBackend, KimiBackend };
export type { DataBackend, DataBackendConfig };
