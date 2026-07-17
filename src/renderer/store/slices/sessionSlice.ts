/**
 * Session slice - manages session list state and pagination.
 */

import { api } from '@renderer/api';
import { buildAnnotationKey } from '@shared/utils/annotationKey';
import { createLogger } from '@shared/utils/logger';

import { isAggregateSourceMode } from './contextSlice';

import type { AppState } from '../types';
import type { Session, SessionSortMode } from '@renderer/types/data';
import type { SessionAnnotation } from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:session');

/**
 * Tracks the latest in-place refresh generation per project.
 * Used to guarantee last-write-wins under rapid file change events.
 */
const projectRefreshGeneration = new Map<string, number>();

// =============================================================================
// Slice Interface
// =============================================================================

export interface SessionSlice {
  // State
  sessions: Session[];
  selectedSessionId: string | null;
  sessionsLoading: boolean;
  sessionsError: string | null;
  // Pagination state
  sessionsCursor: string | null;
  sessionsHasMore: boolean;
  sessionsTotalCount: number;
  sessionsLoadingMore: boolean;
  // Pinned sessions
  pinnedSessionIds: string[];
  // Hidden sessions
  hiddenSessionIds: string[];
  showHiddenSessions: boolean;
  // Session annotations (keyed by composite `${contextId}:${projectId}:${sessionId}`)
  sessionAnnotations: Record<string, SessionAnnotation>;
  // Multi-select
  sidebarSelectedSessionIds: string[];
  sidebarMultiSelectActive: boolean;
  // Sort mode
  sessionSortMode: SessionSortMode;

  // Actions
  fetchSessions: (projectId: string) => Promise<void>;
  fetchSessionsInitial: (projectId: string) => Promise<void>;
  fetchSessionsMore: () => Promise<void>;
  resetSessionsPagination: () => void;
  selectSession: (id: string, contextId?: string) => void;
  clearSelection: () => void;
  /** Refresh sessions list without loading states - for real-time updates */
  refreshSessionsInPlace: (projectId: string) => Promise<void>;
  /** Toggle pin/unpin for a session */
  togglePinSession: (sessionId: string) => Promise<void>;
  /** Load pinned sessions from config for current project */
  loadPinnedSessions: () => Promise<void>;
  /** Set session sort mode */
  setSessionSortMode: (mode: SessionSortMode) => void;
  /** Toggle hide/unhide for a session */
  toggleHideSession: (sessionId: string) => Promise<void>;
  /** Bulk hide sessions */
  hideMultipleSessions: (sessionIds: string[]) => Promise<void>;
  /** Bulk unhide sessions */
  unhideMultipleSessions: (sessionIds: string[]) => Promise<void>;
  /** Load hidden sessions from config for current project */
  loadHiddenSessions: () => Promise<void>;
  /** Set (merge) a session's annotation (optimistic) */
  setSessionAnnotation: (
    session: Session,
    patch: Partial<Pick<SessionAnnotation, 'tags' | 'score' | 'note'>>
  ) => Promise<void>;
  /** Load session annotations from config into the local map */
  loadSessionAnnotations: () => Promise<void>;
  /** Toggle showing hidden sessions in sidebar */
  toggleShowHiddenSessions: () => void;
  /** Toggle one session's checkbox in sidebar multi-select */
  toggleSidebarSessionSelection: (sessionId: string) => void;
  /** Clear all selections and exit multi-select mode */
  clearSidebarSelection: () => void;
  /** Enter/exit selection mode */
  toggleSidebarMultiSelect: () => void;
  /** Bulk pin for multi-select */
  pinMultipleSessions: (sessionIds: string[]) => Promise<void>;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createSessionSlice: StateCreator<AppState, [], [], SessionSlice> = (set, get) => ({
  // Initial state
  sessions: [],
  selectedSessionId: null,
  sessionsLoading: false,
  sessionsError: null,
  // Pagination state
  sessionsCursor: null,
  sessionsHasMore: false,
  sessionsTotalCount: 0,
  sessionsLoadingMore: false,
  // Pinned sessions
  pinnedSessionIds: [],
  // Hidden sessions
  hiddenSessionIds: [],
  showHiddenSessions: false,
  // Session annotations
  sessionAnnotations: {},
  // Multi-select
  sidebarSelectedSessionIds: [],
  sidebarMultiSelectActive: false,
  // Sort mode
  sessionSortMode: 'recent' as SessionSortMode,

  // Fetch sessions for a specific project (legacy - not paginated)
  fetchSessions: async (projectId: string) => {
    set({ sessionsLoading: true, sessionsError: null });
    try {
      // Aggregate ("All") mode merges sessions across all local backends.
      const sessions = isAggregateSourceMode(get())
        ? await api.getAllSessions(projectId)
        : await api.getSessions(projectId);
      // Sort by max of updatedAt/createdAt (descending)
      const sorted = [...sessions].sort(
        (a, b) =>
          Math.max(b.updatedAt ?? b.createdAt, b.createdAt) -
          Math.max(a.updatedAt ?? a.createdAt, a.createdAt)
      );
      set({ sessions: sorted, sessionsLoading: false });
    } catch (error) {
      set({
        sessionsError: error instanceof Error ? error.message : 'Failed to fetch sessions',
        sessionsLoading: false,
      });
    }
  },

  // Fetch initial page of sessions (paginated)
  fetchSessionsInitial: async (projectId: string) => {
    const aggregate = isAggregateSourceMode(get());
    // Capture the cache filter key up front so it matches the fetched data even
    // if the user switches source mid-flight. In aggregate mode the stored list
    // is the full merged set (independent of the chip), so it keys under 'all';
    // the source chip filters it client-side.
    const filterAtStart = aggregate ? 'all' : get().sourceFilter;
    set({
      sessionsLoading: true,
      sessionsError: null,
      sessions: [],
      sessionsCursor: null,
      sessionsHasMore: false,
      sessionsTotalCount: 0,
    });
    try {
      if (aggregate) {
        // Aggregate endpoint returns the full list — no pagination.
        const sessions = await api.getAllSessions(projectId);
        set({
          sessions,
          sessionsCursor: null,
          sessionsHasMore: false,
          sessionsTotalCount: sessions.length,
          sessionsLoading: false,
        });

        const cacheProjectId = get().selectedProjectId;
        if (cacheProjectId) {
          get()._sessionCache.set(`${filterAtStart}:${cacheProjectId}`, {
            sessions,
            cursor: null,
            hasMore: false,
            totalCount: sessions.length,
            timestamp: Date.now(),
          });
        }

        void get().loadPinnedSessions();
        void get().loadHiddenSessions();
        void get().loadSessionAnnotations();
        void get().loadSavedViews();
        return;
      }

      const result = await api.getSessionsPaginated(projectId, null, 20, {
        includeTotalCount: false,
        prefilterAll: false,
        metadataLevel: 'light',
      });
      set({
        sessions: result.sessions,
        sessionsCursor: result.nextCursor,
        sessionsHasMore: result.hasMore,
        sessionsTotalCount: result.totalCount,
        sessionsLoading: false,
      });

      const cacheProjectId = get().selectedProjectId;
      if (cacheProjectId) {
        get()._sessionCache.set(`${filterAtStart}:${cacheProjectId}`, {
          sessions: result.sessions,
          cursor: result.nextCursor,
          hasMore: result.hasMore,
          totalCount: result.totalCount,
          timestamp: Date.now(),
        });
      }

      // Load pinned and hidden sessions after fetching session list
      void get().loadPinnedSessions();
      void get().loadHiddenSessions();
      void get().loadSessionAnnotations();
      void get().loadSavedViews();
    } catch (error) {
      set({
        sessionsError: error instanceof Error ? error.message : 'Failed to fetch sessions',
        sessionsLoading: false,
      });
    }
  },

  // Fetch more sessions (next page)
  fetchSessionsMore: async () => {
    const state = get();
    const { selectedProjectId, sessionsCursor, sessionsHasMore, sessionsLoadingMore } = state;

    // Guard: don't fetch if already loading, no more pages, or no project.
    // Aggregate mode returns the full list up front, so it never paginates.
    if (
      !selectedProjectId ||
      !sessionsHasMore ||
      sessionsLoadingMore ||
      !sessionsCursor ||
      isAggregateSourceMode(state)
    ) {
      return;
    }

    set({ sessionsLoadingMore: true });
    try {
      const result = await api.getSessionsPaginated(selectedProjectId, sessionsCursor, 20, {
        includeTotalCount: false,
        prefilterAll: false,
        metadataLevel: 'light',
      });
      const existingIds = new Set(get().sessions.map((s) => s.id));
      const newSessions = result.sessions.filter((s) => !existingIds.has(s.id));
      set((prevState) => {
        // Deduplicate: pinned sessions fetched earlier may appear in paginated results.
        const nextSessions = [...prevState.sessions, ...newSessions];
        const inferredTotalLowerBound = nextSessions.length + (result.hasMore ? 1 : 0);
        const stableTotalCount = Math.max(
          prevState.sessionsTotalCount,
          result.totalCount,
          inferredTotalLowerBound
        );
        return {
          sessions: nextSessions,
          sessionsCursor: result.nextCursor,
          sessionsHasMore: result.hasMore,
          sessionsTotalCount: stableTotalCount,
          sessionsLoadingMore: false,
        };
      });
    } catch (error) {
      set({
        sessionsError: error instanceof Error ? error.message : 'Failed to fetch more sessions',
        sessionsLoadingMore: false,
      });
    }
  },

  // Reset pagination state
  resetSessionsPagination: () => {
    set({
      sessions: [],
      sessionsCursor: null,
      sessionsHasMore: false,
      sessionsTotalCount: 0,
      sessionsLoadingMore: false,
      sessionsError: null,
    });
  },

  // Select a session and fetch its detail.
  // contextId identifies the origin backend in aggregate ("All") mode; when
  // omitted it is looked up from the loaded session list.
  selectSession: (id: string, contextId?: string) => {
    set({
      selectedSessionId: id,
      sessionDetail: null,
      sessionContextStats: null,
      sessionDetailError: null,
    });

    // Fetch detail for this session, passing the active tabId for per-tab data
    const state = get();
    const projectId = state.selectedProjectId;
    if (projectId) {
      const activeTabId = state.activeTabId ?? undefined;
      const resolvedContextId =
        contextId ?? state.sessions.find((s) => s.id === id)?.contextId ?? undefined;
      void state.fetchSessionDetail(projectId, id, activeTabId, resolvedContextId);
    } else {
      logger.warn('Cannot fetch session detail: no project selected');
    }
  },

  // Clear all selections
  clearSelection: () => {
    set({
      selectedProjectId: null,
      selectedSessionId: null,
      sessions: [],
      sessionDetail: null,
      sessionContextStats: null,
    });
  },

  // Refresh sessions list in place without loading states
  // Used for real-time updates when new sessions are added
  refreshSessionsInPlace: async (projectId: string) => {
    const currentState = get();

    // Only refresh if viewing this project
    if (currentState.selectedProjectId !== projectId) {
      return;
    }

    const generation = (projectRefreshGeneration.get(projectId) ?? 0) + 1;
    projectRefreshGeneration.set(projectId, generation);

    try {
      // Aggregate ("All") mode refetches the full merged list (no pagination).
      const aggregate = isAggregateSourceMode(currentState);
      const result = aggregate
        ? {
            sessions: await api.getAllSessions(projectId),
            nextCursor: null,
            hasMore: false,
            totalCount: 0,
          }
        : await api.getSessionsPaginated(projectId, null, 20, {
            includeTotalCount: false,
            prefilterAll: false,
            metadataLevel: 'light',
          });

      // Drop stale responses from older in-flight refreshes
      if (projectRefreshGeneration.get(projectId) !== generation) {
        return;
      }

      const totalCount = aggregate ? result.sessions.length : result.totalCount;

      // Update sessions without loading state
      set({
        sessions: result.sessions,
        sessionsCursor: result.nextCursor,
        sessionsHasMore: result.hasMore,
        sessionsTotalCount: totalCount,
      });

      const cacheFilterKey = aggregate ? 'all' : currentState.sourceFilter;
      get()._sessionCache.set(`${cacheFilterKey}:${projectId}`, {
        sessions: result.sessions,
        cursor: result.nextCursor,
        hasMore: result.hasMore,
        totalCount,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('refreshSessionsInPlace error:', error);
    }
  },

  // Toggle pin/unpin for a session (optimistic update)
  togglePinSession: async (sessionId: string) => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId) return;

    const isPinned = state.pinnedSessionIds.includes(sessionId);
    const previousPinnedIds = state.pinnedSessionIds;

    // Optimistic: update UI immediately
    if (isPinned) {
      set({ pinnedSessionIds: previousPinnedIds.filter((id) => id !== sessionId) });
    } else {
      set({ pinnedSessionIds: [sessionId, ...previousPinnedIds] });
    }

    try {
      if (isPinned) {
        await api.config.unpinSession(projectId, sessionId);
      } else {
        await api.config.pinSession(projectId, sessionId);
      }
    } catch (error) {
      // Rollback on failure
      set({ pinnedSessionIds: previousPinnedIds });
      logger.error('togglePinSession error:', error);
    }
  },

  // Load pinned sessions from config for current project
  // Fetches missing pinned session data that may be beyond the paginated page
  loadPinnedSessions: async () => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId) {
      set({ pinnedSessionIds: [] });
      return;
    }

    try {
      const config = await api.config.get();
      const pins = config.sessions?.pinnedSessions?.[projectId] ?? [];
      const pinnedIds = pins.map((p) => p.sessionId);
      set({ pinnedSessionIds: pinnedIds });

      // Determine which pinned sessions are missing from the loaded sessions array
      const currentSessions = get().sessions;
      const loadedIds = new Set(currentSessions.map((s) => s.id));
      const missingIds = pinnedIds.filter((id) => !loadedIds.has(id));

      if (missingIds.length > 0) {
        const missingSessions = await api.getSessionsByIds(projectId, missingIds, {
          metadataLevel: 'light',
        });
        if (missingSessions.length > 0) {
          // Re-read sessions in case they changed during the async call
          const latestSessions = get().sessions;
          const latestIds = new Set(latestSessions.map((s) => s.id));
          const toAppend = missingSessions.filter((s) => !latestIds.has(s.id));
          if (toAppend.length > 0) {
            set({ sessions: [...latestSessions, ...toAppend] });
          }
        }
      }
    } catch (error) {
      logger.error('loadPinnedSessions error:', error);
      set({ pinnedSessionIds: [] });
    }
  },

  // Set session sort mode
  setSessionSortMode: (mode: SessionSortMode) => {
    set({ sessionSortMode: mode });
  },

  // Toggle hide/unhide for a session (optimistic update)
  toggleHideSession: async (sessionId: string) => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId) return;

    const isHidden = state.hiddenSessionIds.includes(sessionId);
    const previousHiddenIds = state.hiddenSessionIds;

    // Optimistic: update UI immediately
    if (isHidden) {
      set({ hiddenSessionIds: previousHiddenIds.filter((id) => id !== sessionId) });
    } else {
      set({ hiddenSessionIds: [sessionId, ...previousHiddenIds] });
    }

    try {
      if (isHidden) {
        await api.config.unhideSession(projectId, sessionId);
      } else {
        await api.config.hideSession(projectId, sessionId);
      }
    } catch (error) {
      // Rollback on failure
      set({ hiddenSessionIds: previousHiddenIds });
      logger.error('toggleHideSession error:', error);
    }
  },

  // Bulk hide sessions
  hideMultipleSessions: async (sessionIds: string[]) => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId || sessionIds.length === 0) return;

    const previousHiddenIds = state.hiddenSessionIds;
    const existingSet = new Set(previousHiddenIds);
    const newIds = sessionIds.filter((id) => !existingSet.has(id));

    // Optimistic update
    set({ hiddenSessionIds: [...newIds, ...previousHiddenIds] });

    try {
      await api.config.hideSessions(projectId, sessionIds);
    } catch (error) {
      set({ hiddenSessionIds: previousHiddenIds });
      logger.error('hideMultipleSessions error:', error);
    }
  },

  // Bulk unhide sessions
  unhideMultipleSessions: async (sessionIds: string[]) => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId || sessionIds.length === 0) return;

    const previousHiddenIds = state.hiddenSessionIds;
    const toRemove = new Set(sessionIds);

    // Optimistic update
    set({ hiddenSessionIds: previousHiddenIds.filter((id) => !toRemove.has(id)) });

    try {
      await api.config.unhideSessions(projectId, sessionIds);
    } catch (error) {
      set({ hiddenSessionIds: previousHiddenIds });
      logger.error('unhideMultipleSessions error:', error);
    }
  },

  // Load hidden sessions from config for current project
  loadHiddenSessions: async () => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId) {
      set({ hiddenSessionIds: [] });
      return;
    }

    try {
      const config = await api.config.get();
      const hidden = config.sessions?.hiddenSessions?.[projectId] ?? [];
      const hiddenIds = hidden.map((h) => h.sessionId);
      set({ hiddenSessionIds: hiddenIds });
    } catch (error) {
      logger.error('loadHiddenSessions error:', error);
      set({ hiddenSessionIds: [] });
    }
  },

  // Set (merge) a session's annotation (optimistic update)
  setSessionAnnotation: async (session, patch) => {
    const key = buildAnnotationKey(session.contextId, session.projectId, session.id);
    const previousAnnotations = get().sessionAnnotations;
    const existing = previousAnnotations[key] ?? { tags: [], score: null, note: '' };

    const next: SessionAnnotation = {
      tags: patch.tags ?? existing.tags,
      score: patch.score !== undefined ? patch.score : existing.score,
      note: patch.note ?? existing.note,
      updatedAt: Date.now(),
    };

    const isEmpty = next.tags.length === 0 && next.score === null && next.note.trim().length === 0;

    // Optimistic: update UI immediately (mirror the main-process empty-deletion rule)
    const optimistic = { ...previousAnnotations };
    if (isEmpty) {
      delete optimistic[key];
    } else {
      optimistic[key] = next;
    }
    set({ sessionAnnotations: optimistic });

    try {
      await api.config.setSessionAnnotation(key, patch);
    } catch (error) {
      // Rollback on failure
      set({ sessionAnnotations: previousAnnotations });
      logger.error('setSessionAnnotation error:', error);
    }
  },

  // Load session annotations from config into the local map
  loadSessionAnnotations: async () => {
    try {
      const config = await api.config.get();
      set({ sessionAnnotations: config.sessions?.sessionAnnotations ?? {} });
    } catch (error) {
      logger.error('loadSessionAnnotations error:', error);
      set({ sessionAnnotations: {} });
    }
  },

  // Toggle showing hidden sessions in sidebar
  toggleShowHiddenSessions: () => {
    set((prev) => ({ showHiddenSessions: !prev.showHiddenSessions }));
  },

  // Toggle one session's checkbox in sidebar multi-select
  toggleSidebarSessionSelection: (sessionId: string) => {
    set((prev) => {
      const selected = prev.sidebarSelectedSessionIds;
      if (selected.includes(sessionId)) {
        return { sidebarSelectedSessionIds: selected.filter((id) => id !== sessionId) };
      }
      return {
        sidebarSelectedSessionIds: [...selected, sessionId],
        sidebarMultiSelectActive: true,
      };
    });
  },

  // Clear all selections and exit multi-select mode
  clearSidebarSelection: () => {
    set({ sidebarSelectedSessionIds: [], sidebarMultiSelectActive: false });
  },

  // Enter/exit selection mode
  toggleSidebarMultiSelect: () => {
    set((prev) => {
      if (prev.sidebarMultiSelectActive) {
        return { sidebarMultiSelectActive: false, sidebarSelectedSessionIds: [] };
      }
      return { sidebarMultiSelectActive: true };
    });
  },

  // Bulk pin for multi-select
  pinMultipleSessions: async (sessionIds: string[]) => {
    const state = get();
    const projectId = state.selectedProjectId;
    if (!projectId || sessionIds.length === 0) return;

    const previousPinnedIds = state.pinnedSessionIds;
    const existingSet = new Set(previousPinnedIds);
    const newIds = sessionIds.filter((id) => !existingSet.has(id));

    // Optimistic update
    set({ pinnedSessionIds: [...newIds, ...previousPinnedIds] });

    try {
      // Pin each session individually (no bulk pin IPC)
      await Promise.all(newIds.map((sessionId) => api.config.pinSession(projectId, sessionId)));
    } catch (error) {
      set({ pinnedSessionIds: previousPinnedIds });
      logger.error('pinMultipleSessions error:', error);
    }
  },
});
