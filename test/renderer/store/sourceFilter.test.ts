/**
 * Source filter (aggregate "All" view) unit tests.
 *
 * Covers:
 * - isAggregateSourceMode gating (single-source installs never hit aggregate APIs)
 * - fetchSessionsInitial / fetchProjects / fetchRepositoryGroups aggregate paths
 * - Filter-scoped session cache keys
 * - selectSession / fetchSessionDetail contextId routing
 * - setSourceFilter orchestration (context switch reuse + refetch)
 * - Tab identity including contextId
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { contextStorage } from '@renderer/services/contextStorage';

import { installMockElectronAPI, type MockElectronAPI } from '../../mocks/electronAPI';

import { createTestStore, type TestStore } from './storeTestUtils';

import type { Session } from '../../src/renderer/types/data';
import type { ContextInfo } from '@shared/types/api';

vi.mock('@renderer/services/contextStorage', () => ({
  contextStorage: {
    isAvailable: vi.fn().mockResolvedValue(true),
    saveSnapshot: vi.fn().mockResolvedValue(undefined),
    loadSnapshot: vi.fn().mockResolvedValue(null),
    cleanupExpired: vi.fn().mockResolvedValue(undefined),
  },
}));

const MULTI_CONTEXTS: ContextInfo[] = [
  { id: 'local', type: 'local', backend: 'claude' },
  { id: 'local-kimi', type: 'local', backend: 'kimi' },
];

function makeSession(id: string, extra?: Partial<Session>): Session {
  return {
    id,
    projectId: 'project-1',
    projectPath: '/home/testuser/project-1',
    createdAt: 1700000000,
    hasSubagents: false,
    messageCount: 1,
    ...extra,
  };
}

describe('sourceFilter (aggregate view)', () => {
  let store: TestStore;
  let mockAPI: MockElectronAPI;

  beforeEach(() => {
    mockAPI = installMockElectronAPI();
    store = createTestStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('single-source gating', () => {
    it('uses the single-context endpoints even with the "all" filter when only one local context exists', async () => {
      // Default store state: sourceFilter 'all', one local context.
      await store.getState().fetchProjects();
      await store.getState().fetchRepositoryGroups();
      await store.getState().fetchSessionsInitial('project-1');

      expect(mockAPI.getProjects).toHaveBeenCalledOnce();
      expect(mockAPI.getRepositoryGroups).toHaveBeenCalledOnce();
      expect(mockAPI.getSessionsPaginated).toHaveBeenCalledOnce();
      expect(mockAPI.getAllProjects).not.toHaveBeenCalled();
      expect(mockAPI.getAllRepositoryGroups).not.toHaveBeenCalled();
      expect(mockAPI.getAllSessions).not.toHaveBeenCalled();
    });
  });

  describe('aggregate fetching', () => {
    beforeEach(() => {
      store.setState({ availableContexts: MULTI_CONTEXTS });
    });

    it('fetchProjects uses getAllProjects in aggregate mode', async () => {
      await store.getState().fetchProjects();

      expect(mockAPI.getAllProjects).toHaveBeenCalledOnce();
      expect(mockAPI.getProjects).not.toHaveBeenCalled();
    });

    it('fetchRepositoryGroups uses getAllRepositoryGroups in aggregate mode', async () => {
      await store.getState().fetchRepositoryGroups();

      expect(mockAPI.getAllRepositoryGroups).toHaveBeenCalledOnce();
      expect(mockAPI.getRepositoryGroups).not.toHaveBeenCalled();
    });

    it('fetchSessionsInitial loads the full aggregate list without pagination', async () => {
      const sessions = [
        makeSession('s1', { contextId: 'local', sourceBackend: 'claude' }),
        makeSession('s2', { contextId: 'local-kimi', sourceBackend: 'kimi' }),
      ];
      mockAPI.getAllSessions.mockResolvedValue(sessions);
      store.setState({ selectedProjectId: 'project-1' });

      await store.getState().fetchSessionsInitial('project-1');

      expect(mockAPI.getAllSessions).toHaveBeenCalledWith('project-1');
      expect(mockAPI.getSessionsPaginated).not.toHaveBeenCalled();
      expect(store.getState().sessions).toHaveLength(2);
      expect(store.getState().sessionsHasMore).toBe(false);
      expect(store.getState().sessionsCursor).toBeNull();
      expect(store.getState().sessionsTotalCount).toBe(2);
    });

    it('never paginates in aggregate mode', async () => {
      store.setState({
        selectedProjectId: 'project-1',
        sessionsCursor: 'cursor-1',
        sessionsHasMore: true,
      });

      await store.getState().fetchSessionsMore();

      expect(mockAPI.getSessionsPaginated).not.toHaveBeenCalled();
    });

    it('keys the session cache by filter so All-mode and single-mode lists stay separate', async () => {
      mockAPI.getAllSessions.mockResolvedValue([makeSession('s1')]);
      store.setState({ selectedProjectId: 'project-1' });

      await store.getState().fetchSessionsInitial('project-1');

      expect(store.getState()._sessionCache.has('all:project-1')).toBe(true);
      expect(store.getState()._sessionCache.has('project-1')).toBe(false);
    });

    it('selectProject reads only the cache entry for the current filter', async () => {
      // Keep the background refresh pending so cache consumption is observable.
      let resolveSessions!: (sessions: Session[]) => void;
      mockAPI.getAllSessions.mockImplementation(
        () =>
          new Promise<Session[]>((resolve) => {
            resolveSessions = resolve;
          })
      );
      store.setState({ availableContexts: MULTI_CONTEXTS, sourceFilter: 'all' });
      store.getState()._sessionCache.set('all:project-1', {
        sessions: [makeSession('cached')],
        cursor: null,
        hasMore: false,
        totalCount: 1,
        timestamp: Date.now(),
      });
      store.getState()._sessionCache.set('kimi:project-1', {
        sessions: [makeSession('other')],
        cursor: null,
        hasMore: false,
        totalCount: 1,
        timestamp: Date.now(),
      });

      store.getState().selectProject('project-1');

      expect(store.getState().selectedProjectId).toBe('project-1');
      // Only the current filter's entry is consumed; the other stays cached.
      expect(store.getState()._sessionCache.has('all:project-1')).toBe(false);
      expect(store.getState()._sessionCache.has('kimi:project-1')).toBe(true);

      // Background refresh uses the aggregate endpoint and re-caches under 'all:'.
      expect(mockAPI.getAllSessions).toHaveBeenCalledWith('project-1');
      resolveSessions([makeSession('fresh')]);
      await vi.waitFor(() => expect(store.getState().sessions[0]?.id).toBe('fresh'));
      expect(store.getState()._sessionCache.has('all:project-1')).toBe(true);
    });
  });

  describe('context-aware session detail', () => {
    beforeEach(() => {
      store.setState({
        availableContexts: MULTI_CONTEXTS,
        selectedProjectId: 'project-1',
        sessions: [makeSession('s1', { contextId: 'local-kimi', sourceBackend: 'kimi' })],
      });
    });

    it('selectSession routes detail loading through the session origin context', async () => {
      store.getState().selectSession('s1');

      await vi.waitFor(() => expect(mockAPI.getSessionDetailByContext).toHaveBeenCalledOnce());
      expect(mockAPI.getSessionDetailByContext).toHaveBeenCalledWith({
        contextId: 'local-kimi',
        sessionId: 's1',
        projectId: 'project-1',
      });
      expect(mockAPI.getSessionDetail).not.toHaveBeenCalled();
    });

    it('selectSession honors an explicit contextId argument', async () => {
      store.getState().selectSession('s1', 'local');

      await vi.waitFor(() => expect(mockAPI.getSessionDetailByContext).toHaveBeenCalledOnce());
      expect(mockAPI.getSessionDetailByContext).toHaveBeenCalledWith({
        contextId: 'local',
        sessionId: 's1',
        projectId: 'project-1',
      });
    });

    it('fetchSessionDetail falls back to the active-context endpoint without contextId', async () => {
      store.setState({ sessions: [makeSession('s1')] });

      store.getState().selectSession('s1');

      await vi.waitFor(() => expect(mockAPI.getSessionDetail).toHaveBeenCalledOnce());
      expect(mockAPI.getSessionDetailByContext).not.toHaveBeenCalled();
    });

    it('fetchSessionDetail passes contextId through to the by-context endpoint', async () => {
      await store.getState().fetchSessionDetail('project-1', 's1', undefined, 'local-kimi');

      expect(mockAPI.getSessionDetailByContext).toHaveBeenCalledWith({
        contextId: 'local-kimi',
        sessionId: 's1',
        projectId: 'project-1',
      });
      expect(mockAPI.getSessionDetail).not.toHaveBeenCalled();
    });
  });

  describe('setSourceFilter', () => {
    it('is a no-op when the filter is unchanged', () => {
      store.setState({ availableContexts: MULTI_CONTEXTS, sourceFilter: 'all' });

      store.getState().setSourceFilter('all');

      expect(mockAPI.getAllRepositoryGroups).not.toHaveBeenCalled();
      expect(mockAPI.getAllProjects).not.toHaveBeenCalled();
      expect(mockAPI.context.switch).not.toHaveBeenCalled();
    });

    it('sets a backend filter as a pure client-side view — no context switch, no refetch', async () => {
      store.setState({
        availableContexts: MULTI_CONTEXTS,
        activeContextId: 'local',
        sourceFilter: 'all',
        selectedProjectId: 'project-1',
      });

      store.getState().setSourceFilter('kimi');

      expect(store.getState().sourceFilter).toBe('kimi');
      // No context switch, no snapshot, no refetch of any kind.
      expect(mockAPI.context.switch).not.toHaveBeenCalled();
      expect(contextStorage.saveSnapshot).not.toHaveBeenCalled();
      expect(mockAPI.getRepositoryGroups).not.toHaveBeenCalled();
      expect(mockAPI.getAllRepositoryGroups).not.toHaveBeenCalled();
      expect(mockAPI.getSessionsPaginated).not.toHaveBeenCalled();
      expect(mockAPI.getAllSessions).not.toHaveBeenCalled();
      // Active context stays put — the chip only filters the loaded data.
      expect(store.getState().activeContextId).toBe('local');
    });

    it('switching back to "all" is also a pure view change with no refetch', () => {
      store.setState({
        availableContexts: MULTI_CONTEXTS,
        activeContextId: 'local',
        sourceFilter: 'claude',
        selectedProjectId: 'project-1',
      });

      store.getState().setSourceFilter('all');

      expect(store.getState().sourceFilter).toBe('all');
      expect(mockAPI.context.switch).not.toHaveBeenCalled();
      expect(mockAPI.getAllRepositoryGroups).not.toHaveBeenCalled();
      expect(mockAPI.getRepositoryGroups).not.toHaveBeenCalled();
      expect(mockAPI.getAllSessions).not.toHaveBeenCalled();
    });
  });

  describe('fetchAvailableContexts boundary refetch', () => {
    it('refetches via aggregate endpoints when a second local source appears', async () => {
      mockAPI.context.list.mockResolvedValue(MULTI_CONTEXTS);
      store.setState({ sourceFilter: 'all' });

      await store.getState().fetchAvailableContexts();

      expect(store.getState().availableContexts).toHaveLength(2);
      expect(mockAPI.getAllRepositoryGroups).toHaveBeenCalledOnce();
      expect(mockAPI.getRepositoryGroups).not.toHaveBeenCalled();
    });

    it('does not refetch when the local-source count stays single', async () => {
      mockAPI.context.list.mockResolvedValue([{ id: 'local', type: 'local', backend: 'claude' }]);

      await store.getState().fetchAvailableContexts();

      expect(mockAPI.getAllRepositoryGroups).not.toHaveBeenCalled();
      expect(mockAPI.getRepositoryGroups).not.toHaveBeenCalled();
      expect(mockAPI.getProjects).not.toHaveBeenCalled();
    });
  });

  describe('tab identity with contextId', () => {
    it('treats the same session id from different contexts as distinct tabs', () => {
      const { openTab } = store.getState();

      openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'S1' });
      openTab({
        type: 'session',
        sessionId: 's1',
        contextId: 'local-kimi',
        projectId: 'p1',
        label: 'S1',
      });
      expect(store.getState().openTabs).toHaveLength(2);

      // Re-opening either identity focuses the existing tab instead of duplicating.
      openTab({
        type: 'session',
        sessionId: 's1',
        contextId: 'local-kimi',
        projectId: 'p1',
        label: 'S1',
      });
      expect(store.getState().openTabs).toHaveLength(2);

      openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'S1' });
      expect(store.getState().openTabs).toHaveLength(2);
    });
  });
});
