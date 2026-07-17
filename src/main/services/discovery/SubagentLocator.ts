/**
 * SubagentLocator - Locates and manages subagent files.
 *
 * Responsibilities:
 * - Check if sessions have subagent files
 * - List subagent files for a session
 * - Handle both NEW and OLD subagent directory structures:
 *   - NEW: {projectId}/{sessionId}/subagents/agent-{agentId}.jsonl
 *   - OLD: {projectId}/agent-{agentId}.jsonl (legacy, still supported)
 * - Determine subagent ownership for OLD structure
 */

import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import { createLogger } from '@shared/utils/logger';

import type { DataBackend } from '@main/backends/DataBackend';
import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';

const logger = createLogger('Discovery:SubagentLocator');

/**
 * SubagentLocator provides methods for locating subagent files.
 */
export class SubagentLocator {
  private readonly backend: DataBackend;
  private readonly fsProvider: FileSystemProvider;

  constructor(backend: DataBackend, fsProvider?: FileSystemProvider) {
    this.backend = backend;
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
  }

  /**
   * Checks if a session has subagent files (async).
   * Uses the FileSystemProvider for filesystem access.
   *
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @returns Promise resolving to true if subagents exist
   */
  async hasSubagents(projectId: string, sessionId: string): Promise<boolean> {
    const files = await this.listSubagentFiles(projectId, sessionId);
    if (files.length === 0) {
      return false;
    }

    // Check if at least one subagent file has content (not empty)
    for (const filePath of files) {
      try {
        const stats = await this.fsProvider.stat(filePath);
        if (stats.size > 0) {
          const content = await this.fsProvider.readFile(filePath);
          if (content.trim().length > 0) {
            return true;
          }
        }
      } catch (error) {
        logger.debug(`SubagentLocator: Could not read file ${filePath}:`, error);
      }
    }

    return false;
  }

  /**
   * Lists all subagent files for a session.
   * Delegates to the configured backend, which knows the agent-specific layout.
   *
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @returns Promise resolving to array of file paths
   */
  async listSubagentFiles(projectId: string, sessionId: string): Promise<string[]> {
    try {
      return await this.backend.listSubagentFiles(projectId, sessionId);
    } catch (error) {
      logger.error(`Error listing subagent files for session ${sessionId}:`, error);
      return [];
    }
  }
}
