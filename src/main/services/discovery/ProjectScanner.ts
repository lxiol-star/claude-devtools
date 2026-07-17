/**
 * ProjectScanner service - Scans ~/.claude/projects/ directory and lists all projects.
 *
 * Responsibilities:
 * - Read project directories from ~/.claude/projects/
 * - Decode directory names to original paths (with cwd fallback)
 * - List session files for each project
 * - Read task list data from ~/.claude/todos/
 * - Return sorted list of projects by recent activity
 *
 * Delegates to specialized services:
 * - SessionContentFilter: Noise detection and message filtering
 * - WorktreeGrouper: Git repository grouping
 * - SubagentLocator: Subagent file lookup
 * - SessionSearcher: Search functionality
 */

import { ClaudeBackend } from '@main/backends/ClaudeBackend';
import {
  type FindSessionByIdResult,
  type FindSessionsByPartialIdResult,
  type PaginatedSessionsResult,
  type ParsedMessage,
  type Project,
  type RepositoryGroup,
  type SearchSessionsResult,
  type Session,
  type SessionCursor,
  type SessionMetadataLevel,
  type SessionsByIdsOptions,
  type SessionsPaginationOptions,
} from '@main/types';
import { type analyzeSessionFileMetadata } from '@main/utils/jsonl';
import {
  buildSessionPath,
  extractBaseDir,
  extractSessionId,
  getProjectsBasePath,
  getTodosBasePath,
  isValidEncodedPath,
} from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import { LocalFileSystemProvider } from '../infrastructure/LocalFileSystemProvider';

import { ProjectPathResolver } from './ProjectPathResolver';
import { SessionContentFilter } from './SessionContentFilter';
import { SessionSearcher } from './SessionSearcher';
import { SubagentLocator } from './SubagentLocator';
import { subprojectRegistry } from './SubprojectRegistry';
import { WorktreeGrouper } from './WorktreeGrouper';

import type { FileSystemProvider, FsDirent } from '../infrastructure/FileSystemProvider';
import type { DataBackend, SessionFileInfo } from '@main/backends/DataBackend';

const logger = createLogger('Discovery:ProjectScanner');

/** How long to reuse the cached project list for search (ms) */
const SEARCH_PROJECT_CACHE_TTL_MS = 30_000;

export class ProjectScanner {
  private readonly projectsDir: string;
  private readonly todosDir: string;
  private readonly contentPresenceCache = new Map<
    string,
    { mtimeMs: number; size: number; hasContent: boolean }
  >();
  private readonly sessionMetadataCache = new Map<
    string,
    {
      mtimeMs: number;
      size: number;
      metadata: Awaited<ReturnType<typeof analyzeSessionFileMetadata>>;
    }
  >();

  /** Cached project list for search — avoids re-scanning disk on every query */
  private searchProjectCache: { projects: Project[]; timestamp: number } | null = null;

  // Data backend - abstracts Claude Code vs Kimi Code layout
  private readonly backend: DataBackend;

  // Delegated services
  private readonly fsProvider: FileSystemProvider;
  private readonly sessionContentFilter: typeof SessionContentFilter;
  private readonly worktreeGrouper: WorktreeGrouper;
  private readonly subagentLocator: SubagentLocator;
  private readonly sessionSearcher: SessionSearcher;
  private readonly projectPathResolver: ProjectPathResolver;

  constructor(
    projectsDir?: string,
    todosDir?: string,
    fsProvider?: FileSystemProvider,
    backend?: DataBackend
  ) {
    this.projectsDir = projectsDir ?? getProjectsBasePath();
    this.todosDir = todosDir ?? getTodosBasePath();
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();

    // Use provided backend or default to Claude backend for backward compatibility
    this.backend =
      backend ??
      new ClaudeBackend({
        rootPath: path.dirname(this.projectsDir),
        fsProvider: this.fsProvider,
        projectsDir: this.projectsDir,
        todosDir: this.todosDir,
      });

    // Initialize delegated services
    this.sessionContentFilter = SessionContentFilter;
    this.worktreeGrouper = new WorktreeGrouper(this.projectsDir, this.fsProvider);
    this.subagentLocator = new SubagentLocator(this.backend);
    this.sessionSearcher = new SessionSearcher(this.projectsDir, this.fsProvider);
    this.projectPathResolver = new ProjectPathResolver(this.projectsDir, this.fsProvider);
  }

  // ===========================================================================
  // Project Scanning
  // ===========================================================================

  /**
   * Scans the projects directory and returns a list of all projects.
   * @returns Promise resolving to projects sorted by most recent activity
   */
  async scan(): Promise<Project[]> {
    const startedAt = Date.now();
    try {
      // Delegate to the backend, which knows the concrete layout (Claude vs Kimi).
      subprojectRegistry.clear();
      const projects = await this.backend.listProjects();

      // A single encoded directory may contain sessions from multiple working
      // directories (e.g. Claude Code projects that moved). Split them into
      // subprojects so the UI shows distinct worktrees.
      const splitProjects = await this.splitProjectsByCwd(projects);
      splitProjects.sort((a, b) => (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0));

      if (this.fsProvider.type === 'ssh') {
        logger.debug(
          `SSH scan completed: ${splitProjects.length} projects in ${Date.now() - startedAt}ms`
        );
      }

      return splitProjects;
    } catch (error) {
      logger.error('Error scanning projects:', error);
      return [];
    }
  }

  /**
   * Splits backend projects when their sessions have distinct cwd values.
   * This preserves the original Claude Code behavior where one encoded project
   * directory can represent multiple worktrees.
   */
  private async splitProjectsByCwd(projects: Project[]): Promise<Project[]> {
    // Over SSH, avoid the extra per-session reads required for cwd extraction.
    if (this.fsProvider.type === 'ssh') {
      return projects;
    }

    const result: Project[] = [];

    for (const project of projects) {
      const fileInfos = await this.backend.listSessionFiles(project.id);
      if (fileInfos.length === 0) {
        continue;
      }

      // Extract cwd for each session file via the backend.
      const sessionInfos = await Promise.all(
        fileInfos.map(async (info) => ({
          ...info,
          cwd: await this.backend.extractCwd(info.filePath),
        }))
      );

      // Group sessions by cwd. Sessions without a cwd are grouped under a
      // fallback key so they stay with the decoded project path.
      const cwdGroups = new Map<string, typeof sessionInfos>();
      const decodedFallback = project.path;

      for (const info of sessionInfos) {
        const key = info.cwd ?? `__decoded__${decodedFallback}`;
        const group = cwdGroups.get(key) ?? [];
        group.push(info);
        cwdGroups.set(key, group);
      }

      const realCwdKeys = [...cwdGroups.keys()].filter((k) => !k.startsWith('__decoded__'));

      // If all sessions resolve to at most one real cwd, keep the project whole.
      if (realCwdKeys.length <= 1) {
        result.push(project);
        continue;
      }

      // Multiple distinct cwds: create one subproject per group.
      const rootCwd = realCwdKeys.reduce(
        (shortest, cwd) => (cwd.length <= shortest.length ? cwd : shortest),
        realCwdKeys[0] ?? ''
      );

      for (const [cwdKey, sessions] of cwdGroups) {
        const isDecodedFallback = cwdKey.startsWith('__decoded__');
        const actualCwd = isDecodedFallback ? null : cwdKey;
        const sessionIds = sessions.map((s) => s.sessionId);

        const compositeId = subprojectRegistry.register(
          project.id,
          actualCwd ?? decodedFallback,
          sessionIds
        );

        let mostRecentSession: number | undefined;
        let createdAt = Date.now();
        for (const info of sessions) {
          if (!mostRecentSession || info.mtimeMs > mostRecentSession) {
            mostRecentSession = info.mtimeMs;
          }
          if (info.birthtimeMs < createdAt) {
            createdAt = info.birthtimeMs;
          }
        }

        const displayName =
          !actualCwd || actualCwd === rootCwd
            ? project.name
            : `${project.name} (${path.basename(actualCwd)})`;

        result.push({
          id: compositeId,
          path: actualCwd ?? decodedFallback,
          name: displayName,
          sessions: sessionIds,
          createdAt: Math.floor(createdAt),
          mostRecentSession: mostRecentSession ? Math.floor(mostRecentSession) : undefined,
        });
      }
    }

    return result;
  }

  // ===========================================================================
  // Repository Grouping (Worktree Support)
  // ===========================================================================

  /**
   * Scans projects and groups them by git repository.
   * Projects belonging to the same git repository (main repo + worktrees)
   * are grouped together under a single RepositoryGroup.
   * Non-git projects are represented as single-worktree groups.
   *
   * Sessions are filtered to exclude noise-only sessions, so counts
   * accurately reflect visible sessions in the UI.
   *
   * @returns Promise resolving to RepositoryGroups sorted by most recent activity
   */
  async scanWithWorktreeGrouping(): Promise<RepositoryGroup[]> {
    try {
      // 1. Scan all projects using existing logic
      const projects = await this.scan();

      if (projects.length === 0) {
        return [];
      }

      // 2. Delegate to WorktreeGrouper
      return this.worktreeGrouper.groupByRepository(projects);
    } catch (error) {
      logger.error('Error scanning with worktree grouping:', error);
      return [];
    }
  }

  /**
   * Lists sessions for a specific worktree within a repository group.
   * This is a convenience method that delegates to listSessions since
   * worktree.id is the same as project.id.
   *
   * @param worktreeId - The worktree ID (same as project ID)
   */
  async listWorktreeSessions(worktreeId: string): Promise<Session[]> {
    return this.listSessions(worktreeId);
  }

  // ===========================================================================
  // Project Scanning (continued)
  // ===========================================================================

  /**
   * Scans a single project directory and returns project metadata.
   * If sessions have different cwd values, splits into multiple projects.
   */
  private async scanProject(projectId: string): Promise<Project[]> {
    try {
      const project = await this.backend.getProject(projectId);
      return project ? [project] : [];
    } catch (error) {
      logger.error(`Error scanning project ${projectId}:`, error);
      return [];
    }
  }

  /**
   * Gets details for a specific project by ID.
   * Handles composite IDs by scanning the base directory and finding the matching subproject.
   */
  async getProject(projectId: string): Promise<Project | null> {
    const baseDir = extractBaseDir(projectId);
    const projectPath = path.join(this.projectsDir, baseDir);

    if (!(await this.fsProvider.exists(projectPath))) {
      return null;
    }

    // For composite IDs, scan and find the matching subproject
    if (subprojectRegistry.isComposite(projectId)) {
      const projects = await this.scanProject(baseDir);
      return projects.find((p) => p.id === projectId) ?? null;
    }

    const projects = await this.scanProject(baseDir);
    return projects.find((p) => p.id === projectId) ?? projects[0] ?? null;
  }

  // ===========================================================================
  // Session Listing
  // ===========================================================================

  /**
   * Lists all sessions for a given project with metadata.
   * Filters out sessions that contain only noise messages.
   */
  async listSessions(projectId: string): Promise<Session[]> {
    try {
      const sessionFilter = await this.getSessionFilterForProject(projectId);
      const shouldFilterNoise = this.fsProvider.type !== 'ssh';
      const metadataLevel: SessionMetadataLevel = 'light';

      let fileInfos = await this.backend.listSessionFiles(projectId);

      // Filter to only sessions belonging to this subproject
      if (sessionFilter) {
        fileInfos = fileInfos.filter((f) => sessionFilter.has(f.sessionId));
      }

      const sessionPaths = fileInfos.map((fileInfo) => fileInfo.filePath);
      const decodedPath = await this.resolveProjectPathForId(projectId, sessionPaths);

      const sessions = await Promise.all(
        fileInfos.map(async (fileInfo) => {
          const { sessionId, filePath, mtimeMs, size, birthtimeMs } = fileInfo;

          if (shouldFilterNoise) {
            // Check if session has non-noise messages (delegated to SessionContentFilter)
            const hasContent = await this.hasDisplayableContent(filePath, mtimeMs, size);
            if (!hasContent) {
              return null; // Filter out noise-only sessions
            }
          }

          return this.buildSessionForListing(
            metadataLevel,
            projectId,
            sessionId,
            filePath,
            decodedPath,
            mtimeMs,
            size,
            birthtimeMs
          );
        })
      );

      // Filter out null results (noise-only sessions)
      const validSessions = sessions.filter((s): s is Session => s !== null);

      // Sort by created date (most recent first)
      validSessions.sort((a, b) => b.createdAt - a.createdAt);

      return validSessions;
    } catch (error) {
      logger.error(`Error listing sessions for project ${projectId}:`, error);
      return [];
    }
  }

  /**
   * Lists sessions for a project with cursor-based pagination.
   * Efficiently fetches only the sessions needed for the current page.
   *
   * @param projectId - The project ID to list sessions for
   * @param cursor - Base64-encoded cursor from previous page (null for first page)
   * @param limit - Number of sessions to return (default 20)
   * @returns Paginated result with sessions, cursor, and metadata
   */
  async listSessionsPaginated(
    projectId: string,
    cursor: string | null,
    limit: number = 20,
    options?: SessionsPaginationOptions
  ): Promise<PaginatedSessionsResult> {
    const startedAt = Date.now();
    try {
      const includeTotalCount = options?.includeTotalCount ?? false;
      const prefilterAll = options?.prefilterAll ?? false;
      const sessionFilter = await this.getSessionFilterForProject(projectId);
      const metadataLevel: SessionMetadataLevel =
        options?.metadataLevel ?? (this.fsProvider.type === 'ssh' ? 'light' : 'deep');
      const shouldFilterNoise = this.fsProvider.type !== 'ssh' && metadataLevel === 'deep';

      // Step 1: Get all session files with their timestamps from the backend
      let fileInfos = await this.backend.listSessionFiles(projectId);

      // Filter to only sessions belonging to this subproject
      if (sessionFilter) {
        fileInfos = fileInfos.filter((f) => sessionFilter.has(f.sessionId));
      }

      // Step 2: Sort by timestamp descending (most recent first)
      fileInfos.sort((a, b) => {
        if (b.timestamp !== a.timestamp) {
          return b.timestamp - a.timestamp;
        }
        // Tie-breaker: sort by sessionId alphabetically
        return a.sessionId.localeCompare(b.sessionId);
      });

      // Step 3: Optionally pre-filter all sessions for accurate total count
      // This is slower but provides exact totalCount.
      let validSessionIds: Set<string> | null = null;
      let totalCount = 0;
      if (prefilterAll && shouldFilterNoise && metadataLevel === 'deep') {
        const contentResults = await Promise.allSettled(
          fileInfos.map(async (fileInfo) => ({
            sessionId: fileInfo.sessionId,
            hasContent: await this.hasDisplayableContent(
              fileInfo.filePath,
              fileInfo.mtimeMs,
              fileInfo.size
            ),
          }))
        );
        validSessionIds = new Set<string>();
        for (const result of contentResults) {
          if (result.status === 'fulfilled' && result.value.hasContent) {
            validSessionIds.add(result.value.sessionId);
          }
        }
        totalCount = validSessionIds.size;
      }

      // Step 4: Apply cursor filter to find starting position
      let startIndex = 0;
      if (cursor) {
        try {
          const decoded = JSON.parse(
            Buffer.from(cursor, 'base64').toString('utf8')
          ) as SessionCursor;
          startIndex = fileInfos.findIndex((info) => {
            // Find the first item that comes AFTER the cursor
            if (info.timestamp < decoded.timestamp) return true;
            if (info.timestamp === decoded.timestamp && info.sessionId > decoded.sessionId)
              return true;
            return false;
          });
          // If cursor not found, start from beginning
          if (startIndex === -1) startIndex = fileInfos.length;
        } catch {
          // Invalid cursor, start from beginning
          startIndex = 0;
        }
      }

      // Step 5: Fetch sessions for this page
      const decodedPath = await this.resolveProjectPathForId(
        projectId,
        fileInfos.map((fileInfo) => fileInfo.filePath)
      );
      const sessions: Session[] = [];
      let scannedCandidates = 0;

      // Fetch page items in parallel batches for SSH performance.
      // Process candidates in chunks, checking content + building metadata concurrently.
      const BATCH_SIZE = limit + 1; // One extra to detect hasMore
      let batchStart = startIndex;

      while (sessions.length < limit + 1 && batchStart < fileInfos.length) {
        // Take a batch of candidates (overshoot to account for filtered-out items)
        const batchEnd = Math.min(batchStart + BATCH_SIZE * 2, fileInfos.length);
        const batch = fileInfos.slice(batchStart, batchEnd);
        scannedCandidates += batch.length;

        // Step 5a: Check content in parallel
        let contentBatch: { fileInfo: SessionFileInfo; hasContent: boolean }[];
        if (validSessionIds) {
          contentBatch = batch.map((fileInfo) => ({
            fileInfo,
            hasContent: validSessionIds.has(fileInfo.sessionId),
          }));
        } else if (!shouldFilterNoise) {
          contentBatch = batch.map((fileInfo) => ({ fileInfo, hasContent: true }));
        } else {
          const contentResults = await Promise.allSettled(
            batch.map(async (fileInfo) => ({
              fileInfo,
              hasContent: await this.hasDisplayableContent(
                fileInfo.filePath,
                fileInfo.mtimeMs,
                fileInfo.size
              ),
            }))
          );
          contentBatch = contentResults
            .filter(
              (
                r
              ): r is PromiseFulfilledResult<{ fileInfo: SessionFileInfo; hasContent: boolean }> =>
                r.status === 'fulfilled'
            )
            .map((r) => r.value);
        }

        // Step 5b: Build metadata in parallel for items with content
        const withContent = contentBatch.filter((c) => c.hasContent);
        const needed = limit + 1 - sessions.length;
        const toBuild = withContent.slice(0, needed);

        const builtSessions = await this.collectFulfilledInBatches(
          toBuild,
          this.fsProvider.type === 'ssh' ? 4 : 16,
          async ({ fileInfo }) =>
            this.buildSessionForListing(
              metadataLevel,
              projectId,
              fileInfo.sessionId,
              fileInfo.filePath,
              decodedPath,
              fileInfo.mtimeMs,
              fileInfo.size,
              fileInfo.birthtimeMs
            )
        );
        sessions.push(...builtSessions);

        batchStart = batchEnd;
      }

      // Step 6: Build next cursor
      let nextCursor: string | null = null;
      const hasMore = sessions.length > limit || startIndex + scannedCandidates < fileInfos.length;

      const pageSessions = hasMore ? sessions.slice(0, limit) : sessions;

      // If total count wasn't precomputed, keep UI-safe lower bound
      if (!includeTotalCount) {
        // Lightweight mode: return a lower-bound count to avoid full scans.
        totalCount = pageSessions.length + (hasMore ? 1 : 0);
      }

      if (pageSessions.length > 0 && hasMore) {
        const lastSession = pageSessions[pageSessions.length - 1];
        const lastFileInfo = fileInfos.find((f) => f.sessionId === lastSession.id);
        if (lastFileInfo) {
          const cursorData: SessionCursor = {
            timestamp: lastFileInfo.timestamp,
            sessionId: lastFileInfo.sessionId,
          };
          nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
        }
      }

      const result: PaginatedSessionsResult = {
        sessions: pageSessions,
        nextCursor,
        hasMore: nextCursor !== null,
        totalCount,
      };

      if (this.fsProvider.type === 'ssh') {
        logger.debug(
          `SSH listSessionsPaginated(${projectId}) returned ${result.sessions.length} sessions in ${Date.now() - startedAt}ms (hasMore=${result.hasMore})`
        );
      }

      return result;
    } catch (error) {
      logger.error(`Error listing paginated sessions for project ${projectId}:`, error);
      return { sessions: [], nextCursor: null, hasMore: false, totalCount: 0 };
    }
  }

  /**
   * Build session metadata from a session file.
   */
  private async buildSessionMetadata(
    projectId: string,
    sessionId: string,
    filePath: string,
    projectPath: string,
    prefetchedMtimeMs?: number,
    prefetchedSize?: number,
    prefetchedBirthtimeMs?: number
  ): Promise<Session> {
    const hasPrefetchedCoreStats =
      typeof prefetchedMtimeMs === 'number' && typeof prefetchedSize === 'number';
    const needsBirthtimeStat = typeof prefetchedBirthtimeMs !== 'number';
    const stats =
      hasPrefetchedCoreStats && !needsBirthtimeStat ? null : await this.fsProvider.stat(filePath);
    const effectiveMtime = prefetchedMtimeMs ?? stats?.mtimeMs ?? Date.now();
    const effectiveSize = prefetchedSize ?? stats?.size ?? -1;
    const birthtimeMs = prefetchedBirthtimeMs ?? stats?.birthtimeMs ?? effectiveMtime;
    const cachedMetadata = this.sessionMetadataCache.get(filePath);
    const metadata =
      cachedMetadata?.mtimeMs === effectiveMtime && cachedMetadata.size === effectiveSize
        ? cachedMetadata.metadata
        : await this.backend.analyzeSessionFileMetadata(filePath);
    if (cachedMetadata?.mtimeMs !== effectiveMtime || cachedMetadata.size !== effectiveSize) {
      this.sessionMetadataCache.set(filePath, {
        mtimeMs: effectiveMtime,
        size: effectiveSize,
        metadata,
      });
    }

    // Check for subagents and load task list data in parallel
    const [hasSubagents, todoData] = await Promise.all([
      this.subagentLocator.hasSubagents(projectId, sessionId),
      this.loadTodoData(sessionId),
    ]);
    const metadataLevel: SessionMetadataLevel = 'deep';
    const firstMessageTimestampMs = this.parseTimestampMs(metadata.firstUserMessage?.timestamp);
    const createdAt =
      firstMessageTimestampMs !== null && Number.isFinite(firstMessageTimestampMs)
        ? firstMessageTimestampMs
        : birthtimeMs;

    // If messages suggest ongoing but the file hasn't been written to in 5+ minutes,
    // the session likely crashed/was killed — mark as dead (issue #94)
    const STALE_SESSION_THRESHOLD_MS = 5 * 60 * 1000;
    const isOngoing =
      metadata.isOngoing && Date.now() - effectiveMtime < STALE_SESSION_THRESHOLD_MS;

    return {
      id: sessionId,
      projectId,
      projectPath,
      todoData,
      createdAt: Math.floor(createdAt),
      updatedAt: Math.floor(effectiveMtime),
      firstMessage: metadata.firstUserMessage?.text,
      messageTimestamp: metadata.firstUserMessage?.timestamp,
      hasSubagents,
      messageCount: metadata.messageCount,
      isOngoing,
      gitBranch: metadata.gitBranch ?? undefined,
      metadataLevel,
      contextConsumption: metadata.contextConsumption,
      compactionCount: metadata.compactionCount,
      phaseBreakdown: metadata.phaseBreakdown,
    };
  }

  /**
   * Build a lightweight session record using filesystem metadata only.
   * Used as SSH fallback when deep parsing fails transiently.
   */
  private async buildLightSessionMetadata(
    projectId: string,
    sessionId: string,
    filePath: string,
    projectPath: string,
    prefetchedMtimeMs?: number,
    prefetchedSize?: number,
    prefetchedBirthtimeMs?: number
  ): Promise<Session> {
    const hasPrefetchedCoreStats =
      typeof prefetchedMtimeMs === 'number' && typeof prefetchedSize === 'number';
    const needsBirthtimeStat = typeof prefetchedBirthtimeMs !== 'number';
    const stats =
      hasPrefetchedCoreStats && !needsBirthtimeStat ? null : await this.fsProvider.stat(filePath);
    const effectiveMtime = prefetchedMtimeMs ?? stats?.mtimeMs ?? Date.now();
    const effectiveSize = prefetchedSize ?? stats?.size ?? -1;
    const birthtimeMs = prefetchedBirthtimeMs ?? stats?.birthtimeMs ?? effectiveMtime;
    let metadata: Awaited<ReturnType<typeof analyzeSessionFileMetadata>>;
    const cachedMetadata = this.sessionMetadataCache.get(filePath);
    if (cachedMetadata?.mtimeMs === effectiveMtime && cachedMetadata.size === effectiveSize) {
      metadata = cachedMetadata.metadata;
    } else {
      try {
        metadata = await this.backend.analyzeSessionFileMetadata(filePath);
        this.sessionMetadataCache.set(filePath, {
          mtimeMs: effectiveMtime,
          size: effectiveSize,
          metadata,
        });
      } catch (error) {
        logger.debug(`Failed to analyze session metadata for ${filePath}:`, error);
        metadata = {
          firstUserMessage: null,
          messageCount: 0,
          isOngoing: false,
          gitBranch: null,
          hasDisplayableContent: false,
        };
      }
    }

    const metadataLevel: SessionMetadataLevel = 'light';
    const previewTimestampMs = this.parseTimestampMs(metadata.firstUserMessage?.timestamp);
    const createdAt =
      previewTimestampMs !== null && Number.isFinite(previewTimestampMs)
        ? previewTimestampMs
        : birthtimeMs;

    return {
      id: sessionId,
      projectId,
      projectPath,
      createdAt: Math.floor(createdAt),
      updatedAt: Math.floor(effectiveMtime),
      firstMessage: metadata.firstUserMessage?.text,
      messageTimestamp: metadata.firstUserMessage?.timestamp,
      hasSubagents: false,
      messageCount: metadata.messageCount,
      // Pass through token/compaction figures when the backend's metadata
      // analyzer already computed them (Claude does; Kimi/Codex leave them
      // undefined). This is free here — analyzeSessionFileMetadata already ran —
      // and lets the cross-session analytics dashboard show real token volume
      // without an extra deep parse.
      contextConsumption: metadata.contextConsumption,
      compactionCount: metadata.compactionCount,
      metadataLevel,
    };
  }

  /**
   * Build session metadata according to requested listing depth.
   * In SSH mode, deep parse failures degrade gracefully to light metadata.
   */
  private async buildSessionForListing(
    metadataLevel: SessionMetadataLevel,
    projectId: string,
    sessionId: string,
    filePath: string,
    projectPath: string,
    prefetchedMtimeMs?: number,
    prefetchedSize?: number,
    prefetchedBirthtimeMs?: number
  ): Promise<Session> {
    if (metadataLevel === 'light') {
      return this.buildLightSessionMetadata(
        projectId,
        sessionId,
        filePath,
        projectPath,
        prefetchedMtimeMs,
        prefetchedSize,
        prefetchedBirthtimeMs
      );
    }

    try {
      return await this.buildSessionMetadata(
        projectId,
        sessionId,
        filePath,
        projectPath,
        prefetchedMtimeMs,
        prefetchedSize,
        prefetchedBirthtimeMs
      );
    } catch (error) {
      // In SSH mode, never drop a visible session row due to transient deep-parse failures.
      if (this.fsProvider.type !== 'ssh') {
        throw error;
      }

      logger.debug(`SSH metadata parse failed for ${sessionId}, using light fallback`, error);
      return this.buildLightSessionMetadata(
        projectId,
        sessionId,
        filePath,
        projectPath,
        prefetchedMtimeMs,
        prefetchedSize,
        prefetchedBirthtimeMs
      );
    }
  }

  /**
   * Gets a single session's metadata.
   */
  async getSession(projectId: string, sessionId: string): Promise<Session | null> {
    const filePath = await this.getSessionPath(projectId, sessionId);

    if (!(await this.fsProvider.exists(filePath))) {
      return null;
    }

    const metadataLevel: SessionMetadataLevel = 'deep';
    const decodedPath = await this.resolveProjectPathForId(projectId);
    return this.buildSessionForListing(metadataLevel, projectId, sessionId, filePath, decodedPath);
  }

  /**
   * Gets a single session's metadata with optional depth override.
   */
  async getSessionWithOptions(
    projectId: string,
    sessionId: string,
    options?: SessionsByIdsOptions
  ): Promise<Session | null> {
    const filePath = await this.getSessionPath(projectId, sessionId);

    if (!(await this.fsProvider.exists(filePath))) {
      return null;
    }

    const metadataLevel: SessionMetadataLevel =
      options?.metadataLevel ?? (this.fsProvider.type === 'ssh' ? 'light' : 'deep');
    const decodedPath = await this.resolveProjectPathForId(projectId);
    return this.buildSessionForListing(metadataLevel, projectId, sessionId, filePath, decodedPath);
  }

  // ===========================================================================
  // Task List Data
  // ===========================================================================

  /**
   * Loads task list data for a session from ~/.claude/todos/{sessionId}.json
   */
  async loadTodoData(sessionId: string): Promise<unknown> {
    try {
      const todoPath = this.backend.getTodoPath(sessionId);
      if (!todoPath) {
        return undefined;
      }

      if (!(await this.fsProvider.exists(todoPath))) {
        return undefined;
      }

      const content = await this.fsProvider.readFile(todoPath);
      return JSON.parse(content) as unknown;
    } catch (error) {
      // Log but continue - task list data is non-critical
      logger.debug(`Failed to load task list data for session ${sessionId}:`, error);
      return undefined;
    }
  }

  // ===========================================================================
  // Path Helpers
  // ===========================================================================

  /**
   * Gets the path to the session JSONL file.
   */
  async getSessionPath(projectId: string, sessionId: string): Promise<string> {
    return this.backend.getSessionPath(projectId, sessionId);
  }

  /**
   * Lists all session file paths for a project.
   */
  async listSessionFiles(projectId: string): Promise<string[]> {
    try {
      const fileInfos = await this.backend.listSessionFiles(projectId);
      return fileInfos.map((info) => info.filePath);
    } catch (error) {
      logger.error(`Error listing session files for project ${projectId}:`, error);
      return [];
    }
  }

  /**
   * Parse a session file using the configured backend.
   */
  async parseSessionFile(filePath: string): Promise<ParsedMessage[]> {
    return this.backend.parseSessionFile(filePath);
  }

  /**
   * Returns the session filter set for a project.
   * In local mode, composite IDs are refreshed from disk first so newly created
   * sessions are not hidden by stale registry entries.
   */
  private async getSessionFilterForProject(projectId: string): Promise<Set<string> | null> {
    if (this.fsProvider.type === 'local' && subprojectRegistry.isComposite(projectId)) {
      const baseDir = extractBaseDir(projectId);
      await this.scanProject(baseDir);
    }
    return subprojectRegistry.getSessionFilter(projectId);
  }

  // ===========================================================================
  // Subagent Detection (delegated to SubagentLocator)
  // ===========================================================================

  /**
   * Checks if a session has a subagents directory (async).
   */
  async hasSubagents(projectId: string, sessionId: string): Promise<boolean> {
    return this.subagentLocator.hasSubagents(projectId, sessionId);
  }

  /**
   * Lists all subagent files for a session from both NEW and OLD structures.
   * Returns NEW structure files first, then OLD structure files.
   */
  async listSubagentFiles(projectId: string, sessionId: string): Promise<string[]> {
    return this.subagentLocator.listSubagentFiles(projectId, sessionId);
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Gets the base projects directory path.
   */
  getProjectsDir(): string {
    return this.projectsDir;
  }

  /**
   * Gets the base todos directory path.
   */
  getTodosDir(): string {
    return this.todosDir;
  }

  /**
   * Gets the FileSystemProvider instance used by this scanner.
   */
  getFileSystemProvider(): FileSystemProvider {
    return this.fsProvider;
  }

  /**
   * Name of the data backend this scanner delegates to ('claude' | 'kimi' | 'codex').
   * Used by the standalone HTTP aggregate fallback to tag results with the
   * real active backend instead of defaulting to 'claude'.
   */
  getBackendName(): string {
    return this.backend.name;
  }

  /**
   * Invalidate internal caches for a project.
   * Called by FileWatcher when session files change so stale cache entries
   * (e.g. sessions previously flagged as empty) are re-evaluated.
   */
  invalidateCachesForProject(projectId: string): void {
    // projectId is URL-encoded; the cache keys are absolute file paths containing the decoded dir
    const decoded = decodeURIComponent(projectId);
    const prefix = path.join(this.projectsDir, decoded);
    for (const key of this.contentPresenceCache.keys()) {
      if (key.startsWith(prefix)) this.contentPresenceCache.delete(key);
    }
    for (const key of this.sessionMetadataCache.keys()) {
      if (key.startsWith(prefix)) this.sessionMetadataCache.delete(key);
    }
  }

  /**
   * Checks if the projects directory exists.
   */
  async projectsDirExists(): Promise<boolean> {
    return this.fsProvider.exists(this.projectsDir);
  }

  // ===========================================================================
  // Search (delegated to SessionSearcher)
  // ===========================================================================

  /**
   * Searches sessions in a project for a query string.
   * Filters out noise messages and returns matching content.
   *
   * @param projectId - The project ID to search in
   * @param query - Search query string
   * @param maxResults - Maximum number of results to return (default 50)
   */
  async searchSessions(
    projectId: string,
    query: string,
    maxResults: number = 50
  ): Promise<SearchSessionsResult> {
    return this.sessionSearcher.searchSessions(projectId, query, maxResults);
  }

  /**
   * Searches sessions across all projects for a query string.
   * Filters out noise messages and returns matching content.
   *
   * @param query - Search query string
   * @param maxResults - Maximum number of results to return (default 50)
   */
  async searchAllProjects(query: string, maxResults: number = 50): Promise<SearchSessionsResult> {
    const startedAt = Date.now();
    try {
      if (!query || query.trim().length === 0) {
        return { results: [], totalMatches: 0, sessionsSearched: 0, query };
      }

      // Use cached project list to avoid re-scanning disk on every keystroke
      let projects: Project[];
      if (
        this.searchProjectCache &&
        Date.now() - this.searchProjectCache.timestamp < SEARCH_PROJECT_CACHE_TTL_MS
      ) {
        projects = this.searchProjectCache.projects;
      } else {
        projects = await this.scan();
        this.searchProjectCache = { projects, timestamp: Date.now() };
      }

      if (projects.length === 0) {
        return { results: [], totalMatches: 0, sessionsSearched: 0, query };
      }

      // Search across all projects with bounded concurrency
      const allResults: SearchSessionsResult[] = [];
      const searchBatchSize = this.fsProvider.type === 'ssh' ? 2 : 8;

      for (let i = 0; i < projects.length; i += searchBatchSize) {
        const batch = projects.slice(i, i + searchBatchSize);
        const batchResults = await Promise.allSettled(
          batch.map((project) => this.sessionSearcher.searchSessions(project.id, query, maxResults))
        );

        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            allResults.push(result.value);
          }
        }

        // Check if we have enough results already
        const totalMatches = allResults.reduce((sum, r) => sum + r.totalMatches, 0);
        if (totalMatches >= maxResults) {
          break;
        }
      }

      // Merge results from all projects
      const mergedResults = allResults.flatMap((r) => r.results);
      const totalSessionsSearched = allResults.reduce((sum, r) => sum + r.sessionsSearched, 0);

      // Sort by timestamp (most recent first) and limit to maxResults
      mergedResults.sort((a, b) => b.timestamp - a.timestamp);
      const limitedResults = mergedResults.slice(0, maxResults);

      logger.debug(
        `Global search completed: ${limitedResults.length} results from ${totalSessionsSearched} sessions across ${projects.length} projects in ${Date.now() - startedAt}ms`
      );

      return {
        results: limitedResults,
        totalMatches: limitedResults.length,
        sessionsSearched: totalSessionsSearched,
        query,
      };
    } catch (error) {
      logger.error('Error searching all projects:', error);
      return { results: [], totalMatches: 0, sessionsSearched: 0, query };
    }
  }

  /**
   * Finds a session by its UUID across all projects.
   * Scans all project directories for a matching .jsonl file.
   *
   * @param sessionId - UUID of the session to find
   * @returns FindSessionByIdResult with projectId and session metadata if found
   */
  async findSessionById(sessionId: string): Promise<FindSessionByIdResult> {
    try {
      const entries = await this.fsProvider.readdir(this.projectsDir).catch(() => []);
      const projectDirs = entries.filter(
        (entry) => entry.isDirectory() && isValidEncodedPath(entry.name)
      );

      // Check project directories in batches, stopping as soon as a match is found
      const batchSize = this.fsProvider.type === 'ssh' ? 8 : 24;
      for (let i = 0; i < projectDirs.length; i += batchSize) {
        const batch = projectDirs.slice(i, i + batchSize);
        const settled = await Promise.allSettled(
          batch.map(async (dir) => {
            const sessionPath = buildSessionPath(this.projectsDir, dir.name, sessionId);
            return (await this.fsProvider.exists(sessionPath)) ? dir.name : null;
          })
        );
        for (const result of settled) {
          if (result.status === 'fulfilled' && result.value) {
            const matchedProjectId = result.value;
            const session = await this.getSessionWithOptions(matchedProjectId, sessionId, {
              metadataLevel: 'light',
            });
            if (session) {
              return { found: true, projectId: matchedProjectId, session };
            }
          }
        }
      }

      return { found: false };
    } catch (error) {
      logger.error(`Error finding session by ID ${sessionId}:`, error);
      return { found: false };
    }
  }

  /**
   * Finds sessions whose IDs contain the given fragment (case-insensitive).
   * Scans all project directories in parallel and returns matches sorted by recency.
   *
   * @param fragment - Partial session ID fragment (min 3 chars, hex-dash chars only)
   * @returns FindSessionsByPartialIdResult with matching sessions sorted by createdAt desc
   */
  async findSessionsByPartialId(
    fragment: string,
    maxResults: number = 50
  ): Promise<FindSessionsByPartialIdResult> {
    try {
      const lowerFragment = fragment.toLowerCase();
      const entries = await this.fsProvider.readdir(this.projectsDir).catch(() => []);
      const projectDirs = entries.filter(
        (entry) => entry.isDirectory() && isValidEncodedPath(entry.name)
      );

      // Scan all project dirs in parallel, collecting matching session filenames
      const perProjectMatches = await this.collectFulfilledInBatches(
        projectDirs,
        this.fsProvider.type === 'ssh' ? 8 : 24,
        async (dir) => {
          const projectPath = path.join(this.projectsDir, dir.name);
          const sessionEntries = await this.fsProvider.readdir(projectPath);
          const matchingIds = sessionEntries
            .filter(
              (e) => e.name.endsWith('.jsonl') && e.name.toLowerCase().includes(lowerFragment)
            )
            .map((e) => extractSessionId(e.name));
          return { projectId: dir.name, sessionIds: matchingIds };
        }
      );

      // Flatten and cap filename matches before loading metadata
      const allMatches: { projectId: string; sessionId: string }[] = [];
      for (const { projectId, sessionIds } of perProjectMatches) {
        for (const sessionId of sessionIds) {
          allMatches.push({ projectId, sessionId });
          if (allMatches.length >= maxResults) break;
        }
        if (allMatches.length >= maxResults) break;
      }

      if (allMatches.length === 0) {
        return { found: false, results: [] };
      }

      const sessions = await this.collectFulfilledInBatches(
        allMatches,
        this.fsProvider.type === 'ssh' ? 4 : 16,
        async (match) => {
          const session = await this.getSessionWithOptions(match.projectId, match.sessionId, {
            metadataLevel: 'light',
          });
          return session ? { projectId: match.projectId, session } : null;
        }
      );

      const results = sessions
        .filter((s): s is { projectId: string; session: Session } => s !== null)
        .sort((a, b) => b.session.createdAt - a.session.createdAt);

      return { found: results.length > 0, results };
    } catch (error) {
      logger.error(`Error finding sessions by partial ID ${fragment}:`, error);
      return { found: false, results: [] };
    }
  }

  /**
   * Resolve best-available file timestamps from directory entry metadata or stat fallback.
   */
  private async resolveFileDetails(
    entry: FsDirent | undefined,
    filePath: string
  ): Promise<{ mtimeMs: number; birthtimeMs: number; size: number }> {
    if (
      entry &&
      typeof entry.mtimeMs === 'number' &&
      typeof entry.birthtimeMs === 'number' &&
      typeof entry.size === 'number'
    ) {
      return {
        mtimeMs: entry.mtimeMs,
        birthtimeMs: entry.birthtimeMs,
        size: entry.size,
      };
    }

    const stats = await this.fsProvider.stat(filePath);
    return {
      mtimeMs: stats.mtimeMs,
      birthtimeMs: stats.birthtimeMs,
      size: stats.size,
    };
  }

  private parseTimestampMs(timestamp: string | undefined): number | null {
    if (!timestamp) {
      return null;
    }
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Runs async mapping in bounded batches and returns only fulfilled results.
   * This prevents overwhelming SFTP servers with unbounded parallel requests.
   */
  private async collectFulfilledInBatches<T, R>(
    items: T[],
    batchSize: number,
    mapper: (item: T) => Promise<R>
  ): Promise<R[]> {
    const safeBatchSize = Math.max(1, batchSize);
    const results: R[] = [];

    for (let i = 0; i < items.length; i += safeBatchSize) {
      const batch = items.slice(i, i + safeBatchSize);
      const settled = await Promise.allSettled(batch.map((item) => mapper(item)));
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
      }
    }

    return results;
  }

  private getErrorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'number') {
        return String(code);
      }
      if (typeof code === 'string') {
        return code;
      }
    }
    return '';
  }

  private isTransientFsError(error: unknown): boolean {
    const code = this.getErrorCode(error);
    return (
      code === '4' ||
      code === 'EAGAIN' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'EPIPE'
    );
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Resolves the project path for a given project ID.
   * For composite IDs, uses the registry's cwd directly.
   * For plain IDs, delegates to ProjectPathResolver.
   */
  private async resolveProjectPathForId(
    projectId: string,
    sessionPaths?: string[]
  ): Promise<string> {
    const registryCwd = subprojectRegistry.getCwd(projectId);
    if (registryCwd) {
      return registryCwd;
    }

    // Ask the backend first (Kimi backend knows the workDir directly).
    const project = await this.backend.getProject(projectId);
    if (project?.path) {
      return project.path;
    }

    const baseDir = extractBaseDir(projectId);
    return this.projectPathResolver.resolveProjectPath(baseDir, {
      sessionPaths,
    });
  }

  /**
   * Checks whether a session file has non-noise displayable content.
   * Uses mtime+size memoization to avoid expensive re-parsing on repeated requests.
   */
  private async hasDisplayableContent(
    filePath: string,
    mtimeMs?: number,
    size?: number
  ): Promise<boolean> {
    try {
      const hasPrefetched = typeof mtimeMs === 'number' && typeof size === 'number';
      const stats = hasPrefetched ? null : await this.fsProvider.stat(filePath);
      const effectiveMtime = mtimeMs ?? stats?.mtimeMs ?? Date.now();
      const effectiveSize = size ?? stats?.size ?? -1;
      const cached = this.contentPresenceCache.get(filePath);
      if (cached?.mtimeMs === effectiveMtime && cached.size === effectiveSize) {
        return cached.hasContent;
      }

      const hasContent = await this.backend.hasDisplayableContent(filePath);
      this.contentPresenceCache.set(filePath, {
        mtimeMs: effectiveMtime,
        size: effectiveSize,
        hasContent,
      });
      return hasContent;
    } catch {
      return false;
    }
  }
}
