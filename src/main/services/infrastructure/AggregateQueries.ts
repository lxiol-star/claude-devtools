/**
 * AggregateQueries - Cross-context (multi-backend) query helpers.
 *
 * Powers the "mixed/aggregate view": projects, repository groups, and sessions
 * collected from EVERY local ServiceContext (primary 'local' plus secondary
 * 'local-{backend}' contexts), tagged with their origin and merged where the
 * same entity appears in multiple backends.
 *
 * This module is intentionally Electron-free so both the IPC handlers
 * (src/main/ipc/aggregate.ts) and the HTTP routes (src/main/http/aggregate.ts)
 * can share it — including in standalone (non-Electron) mode.
 *
 * Robustness contract: a single broken context must never break an aggregate
 * call. Per-context failures are logged and skipped.
 */

import { buildAnnotationKey } from '@shared/utils/annotationKey';
import { createLogger } from '@shared/utils/logger';

import { DataCache } from './DataCache';

import type { ChunkBuilder } from '../analysis/ChunkBuilder';
import type { ProjectScanner } from '../discovery/ProjectScanner';
import type { SubagentResolver } from '../discovery/SubagentResolver';
import type { SessionParser } from '../parsing/SessionParser';
import type { SessionAnnotation } from './ConfigManager';
import type { ServiceContext } from './ServiceContext';
import type { ServiceContextRegistry } from './ServiceContextRegistry';
import type {
  AggregateBackendStat,
  AggregateMetrics,
  AggregateMetricsBucket,
  AggregateProjectStat,
  Project,
  RepositoryGroup,
  Session,
  SessionDetail,
  Worktree,
} from '@main/types';
import type { DataBackendName } from '@shared/types/api';
import type { WaterfallData } from '@shared/types/visualization';

const logger = createLogger('Infrastructure:AggregateQueries');

/**
 * Minimal shape of a context participating in aggregate queries.
 * ServiceContext satisfies this structurally; HTTP routes can also build
 * a synthetic single context from plain services (standalone fallback).
 */
export interface AggregateContext {
  id: string;
  backendName?: DataBackendName;
  projectScanner: ProjectScanner;
}

/**
 * Services needed to fetch a full session detail, taken from a ServiceContext.
 */
export interface SessionDetailServices {
  projectScanner: ProjectScanner;
  sessionParser: SessionParser;
  subagentResolver: SubagentResolver;
  chunkBuilder: ChunkBuilder;
  dataCache: DataCache;
}

const DATA_BACKEND_NAMES: readonly string[] = ['claude', 'kimi', 'codex'];

function isDataBackendName(value: string): value is DataBackendName {
  return DATA_BACKEND_NAMES.includes(value);
}

// =============================================================================
// Cross-backend canonical project id
// =============================================================================

/**
 * Normalizes a project filesystem path for cross-backend comparison: strips a
 * single trailing separator and applies Unicode NFC. Case is intentionally
 * preserved (case-sensitive filesystems are the common case here).
 */
export function normalizeProjectPath(projectPath: string): string {
  const normalized = projectPath.normalize('NFC');
  // Drop a trailing '/' or '\' but never reduce a root ('/' or 'C:\') to empty.
  if (normalized.length > 1 && /[/\\]$/.test(normalized)) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Backend-independent project id used to merge the same repo across backends.
 * Every backend reports an accurate `Project.path`, so base64url(path) gives a
 * stable key that is identical across Claude/Kimi/Codex for one directory.
 * For Kimi and Codex this canonical id equals their native project id
 * (both already base64url(path)); only Claude's dash-encoded id differs.
 */
export function canonicalProjectId(projectPath: string): string {
  return Buffer.from(normalizeProjectPath(projectPath), 'utf8').toString('base64url');
}

/**
 * Translates a canonical (base64url path) project id back to the native project
 * id understood by a specific context's backend, so session listing/detail
 * calls route correctly.
 *
 * A single scan() of the context handles every case:
 * - Kimi/Codex: their native id already equals the canonical id, so the exact
 *   id is present in the scan and returned unchanged.
 * - Claude: no dash id matches the canonical, so we decode the canonical to a
 *   path and match a scanned project by normalized path — this also resolves
 *   Claude composite subproject ids (`-dir::hash`), which the scan produces
 *   with their true per-cwd path.
 * - No match (e.g. the id is not canonical, or the repo isn't in this context):
 *   the id is returned unchanged as a safe fallback.
 */
export async function resolveNativeProjectId(
  context: { projectScanner: ProjectScanner },
  projectId: string
): Promise<string> {
  let projects: Project[];
  try {
    projects = await context.projectScanner.scan();
  } catch {
    return projectId;
  }

  // Already a native id for this backend (Kimi/Codex canonical == native, or a
  // Claude dash/composite id passed through directly).
  if (projects.some((project) => project.id === projectId)) {
    return projectId;
  }

  // Decode the canonical id to a path and match a scanned project by path.
  const decodedPath = normalizeProjectPath(Buffer.from(projectId, 'base64url').toString('utf8'));
  const match = projects.find(
    (project) => normalizeProjectPath(project.path) === decodedPath
  );
  return match?.id ?? projectId;
}

// =============================================================================
// Context enumeration and tagging
// =============================================================================

/**
 * Lists all local-type contexts registered in the registry (primary 'local'
 * plus secondary 'local-{backend}' contexts). SSH contexts are excluded.
 */
export function listLocalContexts(registry: ServiceContextRegistry): ServiceContext[] {
  const contexts: ServiceContext[] = [];
  for (const info of registry.list()) {
    if (info.type !== 'local') {
      continue;
    }
    const context = registry.get(info.id);
    if (context) {
      contexts.push(context);
    }
  }
  return contexts;
}

/**
 * Resolves the backend tag for a context: explicit backendName first, then the
 * 'local-{backend}' id suffix, falling back to 'claude' for the primary root.
 */
export function resolveContextBackend(context: {
  id: string;
  backendName?: DataBackendName;
}): DataBackendName {
  if (context.backendName) {
    return context.backendName;
  }
  const suffix = context.id.startsWith('local-') ? context.id.slice('local-'.length) : '';
  return isDataBackendName(suffix) ? suffix : 'claude';
}

/** Tags an entity with its source context + backend (aggregate views only). */
function tagEntity<
  T extends {
    contextId?: string;
    sourceBackend?: DataBackendName;
    sourceBackends?: DataBackendName[];
  },
>(entity: T, context: AggregateContext): T {
  const backend = resolveContextBackend(context);
  return {
    ...entity,
    contextId: context.id,
    sourceBackend: backend,
    // Single-source entry: one-element union. Merges union these below.
    sourceBackends: [backend],
  };
}

/** Orders a backend set into the canonical claude/kimi/codex sequence. */
function orderedBackends(backends: Set<DataBackendName>): DataBackendName[] {
  return DATA_BACKEND_NAMES.filter((name): name is DataBackendName =>
    backends.has(name as DataBackendName)
  );
}

/**
 * Computes the origin tags for an entity merged from multiple sources.
 * contextId is only kept for a single source; sourceBackend (singular) is kept
 * only when every source agrees on it. sourceBackends (plural) is always the
 * ordered union of every source's backends, so a cross-backend-merged card
 * still exposes all of its origins for client-side source filtering.
 */
function mergeTags(
  sources: {
    contextId?: string;
    sourceBackend?: DataBackendName;
    sourceBackends?: DataBackendName[];
  }[]
): {
  contextId?: string;
  sourceBackend?: DataBackendName;
  sourceBackends: DataBackendName[];
} {
  const contextIds = new Set<string>();
  const backends = new Set<DataBackendName>();
  for (const source of sources) {
    if (source.contextId !== undefined) {
      contextIds.add(source.contextId);
    }
    // Prefer the explicit union; fall back to the singular tag.
    const sourceUnion = source.sourceBackends ?? (source.sourceBackend ? [source.sourceBackend] : []);
    for (const backend of sourceUnion) {
      backends.add(backend);
    }
  }
  const contextId = contextIds.size === 1 ? [...contextIds][0] : undefined;
  const sourceBackend = backends.size === 1 ? [...backends][0] : undefined;
  // Always return all keys so spreading overrides the base entity's tags
  // (ambiguous merges must end up with the singular tags cleared).
  return { contextId, sourceBackend, sourceBackends: orderedBackends(backends) };
}

/** Max of the defined mostRecentSession values, or undefined when none exist. */
function maxMostRecentSession(items: { mostRecentSession?: number }[]): number | undefined {
  const values = items
    .map((item) => item.mostRecentSession)
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

// =============================================================================
// Merging (pure functions — unit tested directly)
// =============================================================================

/**
 * Merges tagged projects that share the same id. Callers pass ids that are
 * comparable across backends — scanAllLocalProjects rewrites each project's id
 * to canonicalProjectId(path) first, so the same repo under Claude and
 * Kimi/Codex groups together here. Session id lists are unioned,
 * mostRecentSession takes the max, createdAt takes the min. Origin tags are
 * kept only when unambiguous (see mergeTags). Result is sorted by
 * mostRecentSession desc, mirroring ProjectScanner.scan().
 */
export function mergeTaggedProjects(projects: Project[]): Project[] {
  const byId = new Map<string, Project[]>();
  for (const project of projects) {
    const group = byId.get(project.id);
    if (group) {
      group.push(project);
    } else {
      byId.set(project.id, [project]);
    }
  }

  const merged: Project[] = [];
  for (const group of byId.values()) {
    const base = group[0];
    const mostRecentSession = maxMostRecentSession(group);
    merged.push({
      ...base,
      ...mergeTags(group),
      sessions: [...new Set(group.flatMap((project) => project.sessions))],
      createdAt: Math.min(...group.map((project) => project.createdAt)),
      ...(mostRecentSession !== undefined ? { mostRecentSession } : {}),
    });
  }

  merged.sort((a, b) => (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0));
  return merged;
}

/**
 * Merges tagged worktrees that share the same id. Sessions are unioned,
 * mostRecentSession takes the max, createdAt takes the min; origin tags are
 * kept only when unambiguous. Worktrees are sorted main-first then by most
 * recent activity, mirroring WorktreeGrouper.
 */
function mergeTaggedWorktrees(worktrees: Worktree[]): Worktree[] {
  const byId = new Map<string, Worktree[]>();
  for (const worktree of worktrees) {
    const group = byId.get(worktree.id);
    if (group) {
      group.push(worktree);
    } else {
      byId.set(worktree.id, [worktree]);
    }
  }

  const merged: Worktree[] = [];
  for (const group of byId.values()) {
    const base = group[0];
    const mostRecentSession = maxMostRecentSession(group);
    merged.push({
      ...base,
      ...mergeTags(group),
      sessions: [...new Set(group.flatMap((worktree) => worktree.sessions))],
      createdAt: Math.min(...group.map((worktree) => worktree.createdAt)),
      isMainWorktree: group.some((worktree) => worktree.isMainWorktree),
      ...(mostRecentSession !== undefined ? { mostRecentSession } : {}),
    });
  }

  merged.sort((a, b) => {
    if (a.isMainWorktree && !b.isMainWorktree) return -1;
    if (!a.isMainWorktree && b.isMainWorktree) return 1;
    return (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0);
  });
  return merged;
}

/**
 * Merges tagged repository groups that share the same repo id. Worktrees are
 * merged per id, totalSessions is recomputed from the merged worktrees, and
 * mostRecentSession takes the max. Origin tags are kept only when unambiguous.
 * Result is sorted by mostRecentSession desc, mirroring WorktreeGrouper.
 */
export function mergeTaggedRepositoryGroups(groups: RepositoryGroup[]): RepositoryGroup[] {
  const byId = new Map<string, RepositoryGroup[]>();
  for (const group of groups) {
    const existing = byId.get(group.id);
    if (existing) {
      existing.push(group);
    } else {
      byId.set(group.id, [group]);
    }
  }

  const merged: RepositoryGroup[] = [];
  for (const group of byId.values()) {
    const base = group[0];
    const worktrees = mergeTaggedWorktrees(group.flatMap((g) => g.worktrees));
    const mostRecentSession = maxMostRecentSession(group);
    merged.push({
      ...base,
      ...mergeTags(group),
      identity: base.identity ?? group.find((g) => g.identity !== null)?.identity ?? null,
      worktrees,
      totalSessions: worktrees.reduce((sum, worktree) => sum + worktree.sessions.length, 0),
      ...(mostRecentSession !== undefined ? { mostRecentSession } : {}),
    });
  }

  merged.sort((a, b) => (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0));
  return merged;
}

// =============================================================================
// Aggregate queries (per-context scan + tag + merge)
// =============================================================================

/**
 * Scans projects in every given context, tags them with their origin, and
 * merges projects shared across contexts. A failing context is skipped.
 */
export async function scanAllLocalProjects(contexts: AggregateContext[]): Promise<Project[]> {
  const results = await Promise.all(
    contexts.map(async (context) => {
      try {
        const projects = await context.projectScanner.scan();
        // Rewrite each id to the backend-independent canonical id so the same
        // repo across Claude/Kimi/Codex merges into one card. The native id is
        // recovered on demand via resolveNativeProjectId when routing sessions.
        return projects.map((project) =>
          tagEntity({ ...project, id: canonicalProjectId(project.path) }, context)
        );
      } catch (error) {
        logger.warn(`Aggregate project scan failed for context "${context.id}":`, error);
        return [];
      }
    })
  );
  return mergeTaggedProjects(results.flat());
}

/**
 * Scans repository groups in every given context, tags groups and their
 * worktrees with their origin, and merges groups shared across contexts.
 * A failing context is skipped.
 */
export async function scanAllLocalRepositoryGroups(
  contexts: AggregateContext[]
): Promise<RepositoryGroup[]> {
  const results = await Promise.all(
    contexts.map(async (context) => {
      try {
        const groups = await context.projectScanner.scanWithWorktreeGrouping();
        return groups.map((group) => {
          const worktrees = group.worktrees.map((worktree) =>
            tagEntity({ ...worktree, id: canonicalProjectId(worktree.path) }, context)
          );
          // Git-identified groups already share a cross-backend id (the git
          // identity). Non-git groups (identity null, single worktree) key on
          // the project id, which differs per backend — rewrite it to the
          // worktree's canonical id so the same repo merges across backends.
          const id =
            group.identity !== null ? group.id : (worktrees[0]?.id ?? group.id);
          return tagEntity({ ...group, id, worktrees }, context);
        });
      } catch (error) {
        logger.warn(`Aggregate repository-group scan failed for context "${context.id}":`, error);
        return [];
      }
    })
  );
  return mergeTaggedRepositoryGroups(results.flat());
}

/**
 * Lists sessions for a project in every given context and concatenates the
 * tagged results, sorted by createdAt desc (mirroring ProjectScanner.listSessions).
 *
 * `projectId` is the canonical (cross-backend) id from the merged project card.
 * Each context translates it back to its own native project id before listing,
 * so a Claude context resolves the dash-encoded id for the same path. Sessions
 * keep their backend-native `projectId` and are NOT content-merged — the same
 * session id in two backends stays two entries with their own origin tags, then
 * deduped on contextId+id. A failing context is skipped.
 */
export async function listAllLocalSessions(
  contexts: AggregateContext[],
  projectId: string
): Promise<Session[]> {
  const results = await Promise.all(
    contexts.map(async (context) => {
      try {
        const nativeId = await resolveNativeProjectId(context, projectId);
        const sessions = await context.projectScanner.listSessions(nativeId);
        return sessions.map((session) => tagEntity(session, context));
      } catch (error) {
        logger.warn(
          `Aggregate session listing failed for context "${context.id}" (project ${projectId}):`,
          error
        );
        return [];
      }
    })
  );
  // Dedupe on contextId+id: the same session id can (rarely) surface from two
  // backends, and the renderer keys tab identity / detail routing on
  // contextId+id. Keeping both would yield duplicate React keys and ambiguous
  // detail loads. Two entries with the same id but different contextId are
  // legitimately distinct and both kept.
  const seen = new Set<string>();
  const sessions: Session[] = [];
  for (const session of results.flat()) {
    const key = `${session.contextId ?? ''}:${session.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sessions.push(session);
  }
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  return sessions;
}

// =============================================================================
// Cross-session aggregate metrics
// =============================================================================

/** A session paired with the canonical project it belongs to and its origin. */
interface TaggedSession {
  session: Session;
  backend: DataBackendName;
  projectId: string;
  projectName: string;
  projectPath: string;
  /**
   * Native annotation key (contextId:nativeProjectId:sessionId) so aggregate
   * metrics can join local user annotations, which are stored under the native
   * identity — not the canonical project id used for volume rollups.
   */
  annotationKey: string;
}

/**
 * Collects every session from a single context, tagged with its backend and
 * canonical project identity. Mirrors the aggregate robustness contract: a
 * failing context (or a failing project within it) is logged and skipped so a
 * single broken source never breaks the whole dashboard.
 */
async function collectContextSessions(context: AggregateContext): Promise<TaggedSession[]> {
  try {
    const backend = resolveContextBackend(context);
    const projects = await context.projectScanner.scan();
    const perProject = await Promise.all(
      projects.map(async (project) => {
        try {
          // List data only — contextConsumption is a deep-metadata token proxy
          // already returned by listSessions; no per-session detail parse here.
          const sessions = await context.projectScanner.listSessions(project.id);
          return sessions.map((session) => ({
            session,
            backend,
            // Canonical (cross-backend) id so the same repo under Claude and
            // Kimi/Codex rolls up into one project bucket.
            projectId: canonicalProjectId(project.path),
            projectName: project.name,
            projectPath: project.path,
            // Native identity key for joining local annotations (stored under
            // contextId:nativeProjectId:sessionId).
            annotationKey: buildAnnotationKey(context.id, project.id, session.id),
          }));
        } catch (error) {
          logger.warn(
            `Aggregate metrics session listing failed for context "${context.id}" (project ${project.id}):`,
            error
          );
          return [];
        }
      })
    );
    return perProject.flat();
  } catch (error) {
    logger.warn(`Aggregate metrics scan failed for context "${context.id}":`, error);
    return [];
  }
}

/**
 * Computes cross-session dashboard metrics across every given local context.
 *
 * Built exclusively from cheap session-list data — projectScanner.scan() plus
 * listSessions() per project — never per-session detail/metrics. Aggregates
 * session counts, message counts, and contextConsumption (token proxy) into
 * daily buckets, per-backend and per-project rollups, and top-line totals.
 * Cost and precise latency are intentionally out of scope. A failing context
 * is logged and skipped.
 */
export async function computeAggregateMetrics(
  contexts: AggregateContext[],
  annotations: Record<string, SessionAnnotation> = {}
): Promise<AggregateMetrics> {
  const perContext = await Promise.all(contexts.map((context) => collectContextSessions(context)));
  const tagged = perContext.flat();

  let totalSessions = 0;
  let totalMessages = 0;
  let totalTokens = 0;

  const dailyMap = new Map<string, AggregateMetricsBucket>();
  const backendMap = new Map<DataBackendName, AggregateBackendStat>();
  const projectMap = new Map<string, AggregateProjectStat>();

  // Annotation rollups (local user scores/tags joined onto aggregated sessions).
  let annotatedSessions = 0;
  let scoredSessions = 0;
  let scoreSum = 0;
  const scoreCounts = new Map<number, number>();
  const tagCounts = new Map<string, number>();

  for (const { session, backend, projectId, projectName, projectPath, annotationKey } of tagged) {
    const messages = session.messageCount ?? 0;
    const tokens = session.contextConsumption ?? 0;

    totalSessions += 1;
    totalMessages += messages;
    totalTokens += tokens;

    // Daily bucket keyed by UTC calendar date from createdAt.
    const date = new Date(session.createdAt).toISOString().slice(0, 10);
    const dayBucket = dailyMap.get(date);
    if (dayBucket) {
      dayBucket.sessions += 1;
      dayBucket.messages += messages;
      dayBucket.tokens += tokens;
    } else {
      dailyMap.set(date, { date, sessions: 1, messages, tokens });
    }

    // Per-backend rollup.
    const backendStat = backendMap.get(backend);
    if (backendStat) {
      backendStat.sessions += 1;
      backendStat.messages += messages;
      backendStat.tokens += tokens;
    } else {
      backendMap.set(backend, { backend, sessions: 1, messages, tokens });
    }

    // Per-project rollup (keyed by canonical id so cross-backend repos merge).
    const projectStat = projectMap.get(projectId);
    if (projectStat) {
      projectStat.sessions += 1;
      projectStat.messages += messages;
      projectStat.tokens += tokens;
    } else {
      projectMap.set(projectId, {
        projectId,
        name: projectName,
        path: projectPath,
        sessions: 1,
        messages,
        tokens,
      });
    }

    // Join the local annotation for this session (if any).
    const annotation = annotations[annotationKey];
    if (annotation) {
      const hasTags = annotation.tags.length > 0;
      const hasScore = annotation.score !== null;
      const hasNote = annotation.note.trim().length > 0;
      if (hasTags || hasScore || hasNote) {
        annotatedSessions += 1;
      }
      if (hasScore) {
        const score = annotation.score!;
        scoredSessions += 1;
        scoreSum += score;
        scoreCounts.set(score, (scoreCounts.get(score) ?? 0) + 1);
      }
      for (const tag of annotation.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
  }

  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const byBackend = [...backendMap.values()].sort((a, b) => b.sessions - a.sessions);
  const byProject = [...projectMap.values()]
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);

  const scoreDistribution = [1, 2, 3, 4, 5]
    .map((score) => ({ score, sessions: scoreCounts.get(score) ?? 0 }))
    .filter((s) => s.sessions > 0);
  const byTag = [...tagCounts.entries()]
    .map(([tag, sessions]) => ({ tag, sessions }))
    .sort((a, b) => b.sessions - a.sessions);

  return {
    totals: {
      sessions: totalSessions,
      messages: totalMessages,
      tokens: totalTokens,
      projects: projectMap.size,
    },
    daily,
    byBackend,
    byProject,
    annotations: {
      annotatedSessions,
      scoredSessions,
      avgScore: scoredSessions > 0 ? scoreSum / scoredSessions : 0,
      scoreDistribution,
      byTag,
    },
    generatedAt: Date.now(),
  };
}

// =============================================================================
// Session detail from explicit context services
// =============================================================================

/**
 * Fetches full session detail from an explicit set of context services.
 * Mirrors the HTTP session-detail route: cache-first, raw messages retained
 * (HTTP transport is not IPC-bound). The IPC aggregate handler uses the
 * IPC-flavored fetchSessionDetail from src/main/ipc/sessions.ts instead.
 *
 * A file-state fingerprint (`${mtimeMs}-${size}`) is computed and paired with
 * every cache get/set so a dropped FileWatcher event can't serve a stale entry
 * for up to the 10-minute TTL — matching the IPC path's guarantee. When the
 * stat fails the fingerprint is left undefined and behavior falls back to
 * TTL-only caching.
 */
export async function fetchContextSessionDetail(
  services: SessionDetailServices,
  projectId: string,
  sessionId: string
): Promise<SessionDetail | null> {
  const cacheKey = DataCache.buildKey(projectId, sessionId);

  // Fingerprint the session file so a missed FileWatcher event can't leave a
  // stale cache entry alive for the whole TTL.
  let fingerprint: string | undefined;
  try {
    const filePath = await services.projectScanner.getSessionPath(projectId, sessionId);
    const stats = await services.projectScanner.getFileSystemProvider().stat(filePath);
    fingerprint = `${stats.mtimeMs}-${stats.size}`;
  } catch {
    // Stat failure is non-fatal — fall through with an undefined fingerprint.
  }

  // Check cache first (returns undefined if the fingerprint mismatches).
  let sessionDetail = services.dataCache.get(cacheKey, fingerprint);
  if (sessionDetail) {
    return sessionDetail;
  }

  const fsType = services.projectScanner.getFileSystemProvider().type;
  // In SSH mode, avoid an extra deep metadata scan before full parse.
  const session = await services.projectScanner.getSessionWithOptions(projectId, sessionId, {
    metadataLevel: fsType === 'ssh' ? 'light' : 'deep',
  });
  if (!session) {
    logger.error(`Session not found: ${sessionId}`);
    return null;
  }

  // Parse session messages
  const parsedSession = await services.sessionParser.parseSession(projectId, sessionId);

  // Resolve subagents
  const subagents = await services.subagentResolver.resolveSubagents(
    projectId,
    sessionId,
    parsedSession.taskCalls,
    parsedSession.messages
  );
  session.hasSubagents = subagents.length > 0;

  // Build session detail with chunks
  sessionDetail = services.chunkBuilder.buildSessionDetail(
    session,
    parsedSession.messages,
    subagents
  );

  // Cache the result, paired with the fingerprint observed pre-parse.
  services.dataCache.set(cacheKey, sessionDetail, fingerprint);

  return sessionDetail;
}

/**
 * Builds the execution waterfall (Gantt) data for a session from an explicit
 * set of context services. Mirrors the active-context waterfall path, but
 * routes against a caller-chosen context so the aggregate "All" view can render
 * a timeline for a Kimi/Codex session even while the active context is Claude.
 *
 * Reuses fetchContextSessionDetail to build the detail (same cache-first,
 * fingerprint-guarded parse), then derives the waterfall from its chunks and
 * processes. Returns null when the session detail cannot be built.
 */
export async function fetchContextWaterfallData(
  services: SessionDetailServices,
  projectId: string,
  sessionId: string
): Promise<WaterfallData | null> {
  const detail = await fetchContextSessionDetail(services, projectId, sessionId);
  if (!detail) {
    return null;
  }
  return services.chunkBuilder.buildWaterfallData(detail.chunks, detail.processes);
}
