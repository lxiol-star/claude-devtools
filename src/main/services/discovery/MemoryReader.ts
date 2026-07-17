/**
 * MemoryReader - Reads the per-project memory directory.
 *
 * Memory lives at:
 *   ~/.claude/projects/<encoded-project-id>/memory/
 *     ├── MEMORY.md          (index)
 *     ├── <slug>.md          (layers)
 *     └── ...
 *
 * This is *not* in the user's source repo — it sits alongside session JSONL
 * files inside the Claude data directory, so we resolve the path the same
 * way SubagentLocator etc. do: relative to `getProjectsBasePath()` +
 * `extractBaseDir(projectId)`, not via `ProjectPathResolver.resolveProjectPath`.
 *
 * All reads are constrained to the resolved memory directory and `.md` files.
 */

import { ClaudeBackend } from '@main/backends/ClaudeBackend';
import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import { createLogger } from '@shared/utils/logger';
import { type MemoryIndex, parseMemoryIndex } from '@shared/utils/memoryIndex';
import * as path from 'path';

import type { DataBackend } from '@main/backends/DataBackend';
import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';

const logger = createLogger('Discovery:MemoryReader');

const INDEX_FILE_NAME = 'MEMORY.md';

export interface MemoryFile {
  fileName: string;
  absolutePath: string;
  content: string;
}

export class MemoryReader {
  private readonly backend: DataBackend;
  private readonly fsProvider: FileSystemProvider;

  constructor(projectsDir?: string, fsProvider?: FileSystemProvider, backend?: DataBackend) {
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
    this.backend =
      backend ??
      new ClaudeBackend({
        rootPath: projectsDir ? path.dirname(projectsDir) : '',
        fsProvider: this.fsProvider,
        projectsDir,
        todosDir: projectsDir ? path.join(path.dirname(projectsDir), 'todos') : undefined,
      });
  }

  getDirPath(projectId: string): string {
    const dir = this.backend.getMemoryDir(projectId);
    if (dir) {
      return dir;
    }
    // Fallback for backward compatibility (should not happen in practice).
    return path.join(this.backend.rootPath, projectId);
  }

  getFilePath(projectId: string, fileName: string): string {
    const dir = this.getDirPath(projectId);
    const safeName = this.assertSafeMarkdownName(fileName);
    const resolved = path.resolve(dir, safeName);
    // Containment check — prevent traversal via symlink-like names.
    if (resolved !== path.join(dir, safeName)) {
      throw new Error(`Memory file path escapes memory directory: ${fileName}`);
    }
    return resolved;
  }

  async hasMemory(projectId: string): Promise<boolean> {
    return this.backend.hasMemory(projectId);
  }

  async readIndex(projectId: string): Promise<MemoryIndex | null> {
    const dir = this.getDirPath(projectId);
    if (!(await this.fsProvider.exists(dir))) return null;

    let dirListing: string[] = [];
    try {
      const entries = await this.fsProvider.readdir(dir);
      dirListing = entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch (error) {
      logger.error(`Failed to list memory dir for ${projectId}:`, error);
      return null;
    }

    const indexPath = path.join(dir, INDEX_FILE_NAME);
    let raw = '';
    if (await this.fsProvider.exists(indexPath)) {
      try {
        raw = await this.fsProvider.readFile(indexPath);
      } catch (error) {
        logger.error(`Failed to read MEMORY.md for ${projectId}:`, error);
        raw = '';
      }
    }

    return parseMemoryIndex(raw, dirListing);
  }

  async readFile(projectId: string, fileName: string): Promise<MemoryFile> {
    const absolutePath = this.getFilePath(projectId, fileName);
    const content = await this.fsProvider.readFile(absolutePath);
    return { fileName, absolutePath, content };
  }

  private assertSafeMarkdownName(fileName: string): string {
    const trimmed = fileName.trim();
    if (!trimmed) throw new Error('Memory file name is empty');
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      throw new Error(`Memory file name must not contain path separators: ${fileName}`);
    }
    if (trimmed.includes('..')) {
      throw new Error(`Memory file name must not contain '..': ${fileName}`);
    }
    if (!trimmed.toLowerCase().endsWith('.md')) {
      throw new Error(`Memory file must end with .md: ${fileName}`);
    }
    return trimmed;
  }
}

export const memoryReader = new MemoryReader();
