/**
 * HTTP route handlers for Aggregate (Cross-Backend) Operations.
 *
 * Routes:
 * - GET /api/all-projects - List projects merged across all local backend contexts
 * - GET /api/all-repository-groups - List repository groups merged across all local contexts
 * - GET /api/all-sessions?projectId=... - List sessions for a project across all local contexts
 * - GET /api/session-detail-by-context?contextId=...&sessionId=...&projectId=... - Session detail from a specific context
 * - GET /api/waterfall-data-by-context?contextId=...&sessionId=...&projectId=... - Execution timeline from a specific context
 *
 * These mirror the aggregate IPC handlers in src/main/ipc/aggregate.ts and
 * share the same query helpers (src/main/services/infrastructure/AggregateQueries.ts).
 */

import { createLogger } from '@shared/utils/logger';

import { validateProjectId, validateSessionId } from '../ipc/guards';
import {
  computeAggregateMetrics,
  fetchContextSessionDetail,
  fetchContextWaterfallData,
  listAllLocalSessions,
  listLocalContexts,
  resolveNativeProjectId,
  scanAllLocalProjects,
  scanAllLocalRepositoryGroups,
} from '../services/infrastructure/AggregateQueries';
import { ConfigManager } from '../services/infrastructure/ConfigManager';

import type {
  AggregateContext,
  ServiceContextRegistry,
  SessionDetailServices,
} from '../services';
import type { HttpServices } from './index';
import type { DataBackendName } from '@shared/types/api';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:aggregate');

/**
 * Resolves the local contexts to aggregate over. Falls back to a single
 * synthetic 'local' context built from the active-context services when no
 * registry is available — aggregate results then equal single-source results.
 */
function resolveLocalContexts(services: HttpServices): AggregateContext[] {
  if (services.contextRegistry) {
    return listLocalContexts(services.contextRegistry);
  }
  // Standalone fallback: tag the synthetic context with the active backend's
  // real name. Without this, resolveContextBackend() would default the
  // suffix-less 'local' id to 'claude' and mis-tag Kimi/Codex results.
  const backendName = services.projectScanner.getBackendName();
  return [
    {
      id: 'local',
      projectScanner: services.projectScanner,
      ...(isAggregateBackendName(backendName) ? { backendName } : {}),
    },
  ];
}

/** Narrows a backend name string to the DataBackendName union. */
function isAggregateBackendName(name: string): name is DataBackendName {
  return name === 'claude' || name === 'kimi' || name === 'codex';
}

/**
 * Resolves the services of a specific context by id. With a registry present,
 * any registered context can be addressed; without one, only the synthetic
 * 'local' context backed by the active-context services is available.
 */
function resolveContextServices(
  services: HttpServices,
  contextId: string
): SessionDetailServices | null {
  const registry: ServiceContextRegistry | undefined = services.contextRegistry;
  if (registry) {
    return registry.get(contextId) ?? null;
  }
  if (contextId === 'local') {
    return {
      projectScanner: services.projectScanner,
      sessionParser: services.sessionParser,
      subagentResolver: services.subagentResolver,
      chunkBuilder: services.chunkBuilder,
      dataCache: services.dataCache,
    };
  }
  return null;
}

export function registerAggregateRoutes(app: FastifyInstance, services: HttpServices): void {
  // List projects merged across all local backend contexts
  app.get('/api/all-projects', async () => {
    try {
      return await scanAllLocalProjects(resolveLocalContexts(services));
    } catch (error) {
      logger.error('Error in GET /api/all-projects:', error);
      return [];
    }
  });

  // Cross-session aggregate metrics computed from cheap list data
  app.get('/api/aggregate-metrics', async () => {
    try {
      const annotations = ConfigManager.getInstance().getConfig().sessions.sessionAnnotations;
      return await computeAggregateMetrics(resolveLocalContexts(services), annotations);
    } catch (error) {
      logger.error('Error in GET /api/aggregate-metrics:', error);
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
  });

  // List repository groups merged across all local backend contexts
  app.get('/api/all-repository-groups', async () => {
    try {
      return await scanAllLocalRepositoryGroups(resolveLocalContexts(services));
    } catch (error) {
      logger.error('Error in GET /api/all-repository-groups:', error);
      return [];
    }
  });

  // List sessions for a project across all local backend contexts
  app.get<{ Querystring: { projectId?: string } }>('/api/all-sessions', async (request) => {
    try {
      const validated = validateProjectId(request.query.projectId);
      if (!validated.valid) {
        logger.error(`GET /api/all-sessions rejected: ${validated.error ?? 'missing projectId'}`);
        return [];
      }

      return await listAllLocalSessions(resolveLocalContexts(services), validated.value!);
    } catch (error) {
      logger.error('Error in GET /api/all-sessions:', error);
      return [];
    }
  });

  // Full session detail from a specific service context
  app.get<{ Querystring: { contextId?: string; sessionId?: string; projectId?: string } }>(
    '/api/session-detail-by-context',
    async (request) => {
      try {
        const { contextId, sessionId, projectId } = request.query;
        if (!contextId) {
          logger.error('GET /api/session-detail-by-context rejected: missing contextId');
          return null;
        }

        const contextServices = resolveContextServices(services, contextId);
        if (!contextServices) {
          logger.error(
            `GET /api/session-detail-by-context rejected: unknown context "${contextId}"`
          );
          return null;
        }

        const validatedSession = validateSessionId(sessionId);
        if (!validatedSession.valid) {
          logger.error(
            `GET /api/session-detail-by-context rejected: ${validatedSession.error ?? 'missing sessionId'}`
          );
          return null;
        }
        const safeSessionId = validatedSession.value!;

        // Resolve projectId: use the provided one when valid, otherwise locate
        // the session within the target context.
        let safeProjectId: string;
        if (projectId !== undefined) {
          const validatedProject = validateProjectId(projectId);
          if (!validatedProject.valid) {
            logger.error(
              `GET /api/session-detail-by-context rejected: ${validatedProject.error ?? 'Invalid projectId'}`
            );
            return null;
          }
          // Translate the canonical (cross-backend) id from the merged card to
          // this context's native project id so Claude's dash-encoded layout
          // resolves correctly.
          safeProjectId = await resolveNativeProjectId(contextServices, validatedProject.value!);
        } else {
          const found = await contextServices.projectScanner.findSessionById(safeSessionId);
          if (!found.found || !found.projectId) {
            logger.error(`Session not found in context "${contextId}": ${safeSessionId}`);
            return null;
          }
          safeProjectId = found.projectId;
        }

        return await fetchContextSessionDetail(contextServices, safeProjectId, safeSessionId);
      } catch (error) {
        logger.error('Error in GET /api/session-detail-by-context:', error);
        return null;
      }
    }
  );

  // Execution timeline (waterfall) from a specific service context
  app.get<{ Querystring: { contextId?: string; sessionId?: string; projectId?: string } }>(
    '/api/waterfall-data-by-context',
    async (request) => {
      try {
        const { contextId, sessionId, projectId } = request.query;
        if (!contextId) {
          logger.error('GET /api/waterfall-data-by-context rejected: missing contextId');
          return null;
        }

        const contextServices = resolveContextServices(services, contextId);
        if (!contextServices) {
          logger.error(
            `GET /api/waterfall-data-by-context rejected: unknown context "${contextId}"`
          );
          return null;
        }

        const validatedSession = validateSessionId(sessionId);
        if (!validatedSession.valid) {
          logger.error(
            `GET /api/waterfall-data-by-context rejected: ${validatedSession.error ?? 'missing sessionId'}`
          );
          return null;
        }
        const safeSessionId = validatedSession.value!;

        // Resolve projectId: use the provided one when valid, otherwise locate
        // the session within the target context.
        let safeProjectId: string;
        if (projectId !== undefined) {
          const validatedProject = validateProjectId(projectId);
          if (!validatedProject.valid) {
            logger.error(
              `GET /api/waterfall-data-by-context rejected: ${validatedProject.error ?? 'Invalid projectId'}`
            );
            return null;
          }
          // Translate the canonical (cross-backend) id from the merged card to
          // this context's native project id so Claude's dash-encoded layout
          // resolves correctly.
          safeProjectId = await resolveNativeProjectId(contextServices, validatedProject.value!);
        } else {
          const found = await contextServices.projectScanner.findSessionById(safeSessionId);
          if (!found.found || !found.projectId) {
            logger.error(`Session not found in context "${contextId}": ${safeSessionId}`);
            return null;
          }
          safeProjectId = found.projectId;
        }

        return await fetchContextWaterfallData(contextServices, safeProjectId, safeSessionId);
      } catch (error) {
        logger.error('Error in GET /api/waterfall-data-by-context:', error);
        return null;
      }
    }
  );
}
