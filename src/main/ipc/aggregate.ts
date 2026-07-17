/**
 * IPC Handlers for Aggregate (Cross-Backend) Operations.
 *
 * Handlers:
 * - get-all-projects: List projects merged across all local backend contexts
 * - get-all-repository-groups: List repository groups merged across all local contexts
 * - get-all-sessions: List sessions for a project across all local contexts
 * - get-session-detail-by-context: Get full session detail from a specific context
 * - get-waterfall-data-by-context: Get the execution timeline from a specific context
 *
 * These power the mixed/aggregate view: sessions from every data backend
 * (Claude, Kimi Code, Codex) shown together. Returned entities carry
 * `contextId` / `sourceBackend` origin tags where unambiguous.
 */

import { createLogger } from '@shared/utils/logger';
import { type IpcMain, type IpcMainInvokeEvent } from 'electron';

import {
  computeAggregateMetrics,
  fetchContextWaterfallData,
  listAllLocalSessions,
  listLocalContexts,
  resolveNativeProjectId,
  scanAllLocalProjects,
  scanAllLocalRepositoryGroups,
} from '../services/infrastructure/AggregateQueries';
import { ConfigManager } from '../services/infrastructure/ConfigManager';
import {
  type AggregateMetrics,
  type Project,
  type RepositoryGroup,
  type Session,
  type SessionDetailResponse,
} from '../types';

import { validateProjectId, validateSessionId } from './guards';
import { fetchSessionDetail } from './sessions';

import type { ServiceContextRegistry } from '../services';
import type { WaterfallData } from '@shared/types';

const logger = createLogger('IPC:aggregate');

// Service registry - set via initialize
let registry: ServiceContextRegistry;

/**
 * Parameters for the 'get-session-detail-by-context' IPC call.
 * projectId is optional — when omitted, the session is located within the
 * target context via findSessionById.
 */
export interface GetSessionDetailByContextParams {
  contextId: string;
  sessionId: string;
  projectId?: string;
}

/**
 * Parameters for the 'get-waterfall-data-by-context' IPC call.
 * projectId is optional — when omitted, the session is located within the
 * target context via findSessionById.
 */
export interface GetWaterfallDataByContextParams {
  contextId: string;
  sessionId: string;
  projectId?: string;
}

/**
 * Initializes aggregate handlers with service registry.
 */
export function initializeAggregateHandlers(contextRegistry: ServiceContextRegistry): void {
  registry = contextRegistry;
}

/**
 * Registers all aggregate IPC handlers.
 */
export function registerAggregateHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('get-all-projects', handleGetAllProjects);
  ipcMain.handle('get-all-repository-groups', handleGetAllRepositoryGroups);
  ipcMain.handle('get-all-sessions', handleGetAllSessions);
  ipcMain.handle('get-session-detail-by-context', handleGetSessionDetailByContext);
  ipcMain.handle('get-waterfall-data-by-context', handleGetWaterfallDataByContext);
  ipcMain.handle('get-aggregate-metrics', handleGetAggregateMetrics);

  logger.info('Aggregate handlers registered');
}

/**
 * Removes all aggregate IPC handlers.
 */
export function removeAggregateHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler('get-all-projects');
  ipcMain.removeHandler('get-all-repository-groups');
  ipcMain.removeHandler('get-all-sessions');
  ipcMain.removeHandler('get-session-detail-by-context');
  ipcMain.removeHandler('get-waterfall-data-by-context');
  ipcMain.removeHandler('get-aggregate-metrics');

  logger.info('Aggregate handlers removed');
}

// =============================================================================
// Handler Implementations
// =============================================================================

/**
 * Handler for 'get-all-projects' IPC call.
 * Lists projects from every local context, tagged and merged by project id.
 */
async function handleGetAllProjects(_event: IpcMainInvokeEvent): Promise<Project[]> {
  try {
    return await scanAllLocalProjects(listLocalContexts(registry));
  } catch (error) {
    logger.error('Error in get-all-projects:', error);
    return [];
  }
}

/** Builds an empty metrics payload for safe error fallbacks. */
function emptyAggregateMetrics(): AggregateMetrics {
  return {
    totals: { sessions: 0, messages: 0, tokens: 0, projects: 0 },
    daily: [],
    byBackend: [],
    byProject: [],
    annotations: {
      annotatedSessions: 0,
      scoredSessions: 0,
      avgScore: 0,
      scoreDistribution: [],
      byTag: [],
    },
    generatedAt: Date.now(),
  };
}

/**
 * Handler for 'get-aggregate-metrics' IPC call.
 * Computes cross-session dashboard metrics from cheap list data across every
 * local context. Returns an empty metrics object on failure.
 */
async function handleGetAggregateMetrics(_event: IpcMainInvokeEvent): Promise<AggregateMetrics> {
  try {
    const annotations = ConfigManager.getInstance().getConfig().sessions.sessionAnnotations;
    return await computeAggregateMetrics(listLocalContexts(registry), annotations);
  } catch (error) {
    logger.error('Error in get-aggregate-metrics:', error);
    return emptyAggregateMetrics();
  }
}

/**
 * Handler for 'get-all-repository-groups' IPC call.
 * Lists repository groups from every local context, tagged and merged by repo id.
 */
async function handleGetAllRepositoryGroups(_event: IpcMainInvokeEvent): Promise<RepositoryGroup[]> {
  try {
    return await scanAllLocalRepositoryGroups(listLocalContexts(registry));
  } catch (error) {
    logger.error('Error in get-all-repository-groups:', error);
    return [];
  }
}

/**
 * Handler for 'get-all-sessions' IPC call.
 * Lists sessions for a project from every local context (no pagination),
 * each tagged with its origin context/backend, sorted by recency desc.
 */
async function handleGetAllSessions(
  _event: IpcMainInvokeEvent,
  params: { projectId: string }
): Promise<Session[]> {
  try {
    const validatedProject = validateProjectId(params?.projectId);
    if (!validatedProject.valid) {
      logger.error(`get-all-sessions rejected: ${validatedProject.error ?? 'Invalid projectId'}`);
      return [];
    }

    return await listAllLocalSessions(listLocalContexts(registry), validatedProject.value!);
  } catch (error) {
    logger.error('Error in get-all-sessions:', error);
    return [];
  }
}

/**
 * Handler for 'get-session-detail-by-context' IPC call.
 * Resolves the target context via the registry (NOT getActive) and runs the
 * same detail fetch as 'get-session-detail' against that context's services.
 */
async function handleGetSessionDetailByContext(
  _event: IpcMainInvokeEvent,
  params: GetSessionDetailByContextParams
): Promise<SessionDetailResponse | null> {
  try {
    if (!params || typeof params.contextId !== 'string' || params.contextId.length === 0) {
      logger.error('get-session-detail-by-context rejected: missing contextId');
      return null;
    }

    const context = registry.get(params.contextId);
    if (!context) {
      logger.error(
        `get-session-detail-by-context rejected: unknown context "${params.contextId}"`
      );
      return null;
    }

    const validatedSession = validateSessionId(params.sessionId);
    if (!validatedSession.valid) {
      logger.error(
        `get-session-detail-by-context rejected: ${validatedSession.error ?? 'Invalid sessionId'}`
      );
      return null;
    }
    const safeSessionId = validatedSession.value!;

    // Resolve projectId: use the provided one when valid, otherwise locate the
    // session within the target context.
    let safeProjectId: string;
    if (params.projectId !== undefined) {
      const validatedProject = validateProjectId(params.projectId);
      if (!validatedProject.valid) {
        logger.error(
          `get-session-detail-by-context rejected: ${validatedProject.error ?? 'Invalid projectId'}`
        );
        return null;
      }
      // The renderer passes the canonical (cross-backend) id from the merged
      // card. Translate it to this context's native project id so Claude's
      // dash-encoded layout resolves correctly.
      safeProjectId = await resolveNativeProjectId(context, validatedProject.value!);
    } else {
      const found = await context.projectScanner.findSessionById(safeSessionId);
      if (!found.found || !found.projectId) {
        logger.error(`Session not found in context "${params.contextId}": ${params.sessionId}`);
        return null;
      }
      safeProjectId = found.projectId;
    }

    return await fetchSessionDetail(context, safeProjectId, safeSessionId);
  } catch (error) {
    logger.error('Error in get-session-detail-by-context:', error);
    return null;
  }
}

/**
 * Handler for 'get-waterfall-data-by-context' IPC call.
 * Resolves the target context via the registry (NOT getActive) and builds the
 * execution timeline against that context's services, so the aggregate "All"
 * view renders a Kimi/Codex session's timeline even while Claude is active.
 * A ServiceContext structurally satisfies SessionDetailServices, so it is
 * passed straight through, mirroring handleGetSessionDetailByContext.
 */
async function handleGetWaterfallDataByContext(
  _event: IpcMainInvokeEvent,
  params: GetWaterfallDataByContextParams
): Promise<WaterfallData | null> {
  try {
    if (!params || typeof params.contextId !== 'string' || params.contextId.length === 0) {
      logger.error('get-waterfall-data-by-context rejected: missing contextId');
      return null;
    }

    const context = registry.get(params.contextId);
    if (!context) {
      logger.error(
        `get-waterfall-data-by-context rejected: unknown context "${params.contextId}"`
      );
      return null;
    }

    const validatedSession = validateSessionId(params.sessionId);
    if (!validatedSession.valid) {
      logger.error(
        `get-waterfall-data-by-context rejected: ${validatedSession.error ?? 'Invalid sessionId'}`
      );
      return null;
    }
    const safeSessionId = validatedSession.value!;

    // Resolve projectId: use the provided one when valid, otherwise locate the
    // session within the target context.
    let safeProjectId: string;
    if (params.projectId !== undefined) {
      const validatedProject = validateProjectId(params.projectId);
      if (!validatedProject.valid) {
        logger.error(
          `get-waterfall-data-by-context rejected: ${validatedProject.error ?? 'Invalid projectId'}`
        );
        return null;
      }
      // The renderer passes the canonical (cross-backend) id from the merged
      // card. Translate it to this context's native project id so Claude's
      // dash-encoded layout resolves correctly.
      safeProjectId = await resolveNativeProjectId(context, validatedProject.value!);
    } else {
      const found = await context.projectScanner.findSessionById(safeSessionId);
      if (!found.found || !found.projectId) {
        logger.error(`Session not found in context "${params.contextId}": ${params.sessionId}`);
        return null;
      }
      safeProjectId = found.projectId;
    }

    return await fetchContextWaterfallData(context, safeProjectId, safeSessionId);
  } catch (error) {
    logger.error('Error in get-waterfall-data-by-context:', error);
    return null;
  }
}
