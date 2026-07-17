/**
 * Context Slice - Manages context switching lifecycle.
 *
 * Orchestrates snapshot capture/restore for instant workspace switching
 * between local and SSH contexts, with IndexedDB persistence and TTL.
 */

import { api } from '@renderer/api';
import { contextStorage } from '@renderer/services/contextStorage';

import { getFullResetState } from '../utils/stateResetHelpers';

import type { AppState } from '../types';
import type { ContextSnapshot } from '@renderer/services/contextStorage';
import type { Project, RepositoryGroup } from '@renderer/types/data';
import type { Pane } from '@renderer/types/panes';
import type { ContextInfo, DataBackendName } from '@shared/types/api';
import type { StateCreator } from 'zustand';

/**
 * Source filter for the sidebar: 'all' shows every source, a backend name keeps
 * only cards/sessions from that backend. This is a pure client-side view filter
 * applied on top of the already-loaded aggregate data — it never switches the
 * active context or refetches.
 */
export type SourceFilter = DataBackendName | 'all';

/**
 * Whether the store is effectively in aggregate ("All") mode — i.e. the loaded
 * data is the cross-backend merged set. This is independent of sourceFilter:
 * filtering to a single backend is done client-side on the same aggregate data,
 * so we must keep loading (and caching) it aggregately regardless of the chip.
 *
 * Requires multiple local backend contexts AND a local active context —
 * aggregate queries merge local backends only, so an SSH workspace or a
 * single-source install always uses the single-context path.
 */
export function isAggregateSourceMode(state: {
  availableContexts: ContextInfo[];
  activeContextId: string;
}): boolean {
  const localContexts = state.availableContexts.filter((ctx) => ctx.type === 'local');
  if (localContexts.length <= 1) return false;
  const active = state.availableContexts.find((ctx) => ctx.id === state.activeContextId);
  return active?.type === 'local';
}

// =============================================================================
// Slice Interface
// =============================================================================

export interface ContextSlice {
  // State
  activeContextId: string; // 'local' initially
  isContextSwitching: boolean; // true during switch transition
  targetContextId: string | null; // context being switched to
  contextSnapshotsReady: boolean; // true after initial IndexedDB check
  availableContexts: ContextInfo[]; // list of all available contexts (local + SSH)
  sourceFilter: SourceFilter; // sidebar source filter ('all' = aggregate mixed view)

  // Actions
  switchContext: (targetContextId: string) => Promise<void>;
  initializeContextSystem: () => Promise<void>;
  fetchAvailableContexts: () => Promise<void>;
  setSourceFilter: (filter: SourceFilter) => void;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get empty context state for fresh contexts.
 * Returns state with empty arrays, null selections, and default dashboard tab.
 */
function getEmptyContextState(): Partial<AppState> {
  return {
    ...getFullResetState(),
    projects: [],
    repositoryGroups: [],
    sessions: [],
    notifications: [],
    unreadCount: 0,
    openTabs: [],
    activeTabId: null,
    selectedTabIds: [],
    activeProjectId: null,
    paneLayout: {
      panes: [
        {
          id: 'pane-default',
          tabs: [],
          activeTabId: null,
          selectedTabIds: [],
          widthFraction: 1,
        },
      ],
      focusedPaneId: 'pane-default',
    },
  };
}

/**
 * Validate snapshot against fresh data from target context.
 * Filters invalid tabs, selections, and ensures at-least-one-pane invariant.
 */
function validateSnapshot(
  snapshot: ContextSnapshot,
  freshProjects: Project[],
  freshRepoGroups: RepositoryGroup[]
): Partial<AppState> {
  const validProjectIds = new Set(freshProjects.map((p) => p.id));
  const validWorktreeIds = new Set(freshRepoGroups.flatMap((rg) => rg.worktrees.map((w) => w.id)));

  // Validate selectedProjectId
  const selectedProjectId =
    snapshot.selectedProjectId && validProjectIds.has(snapshot.selectedProjectId)
      ? snapshot.selectedProjectId
      : null;

  // Validate selectedRepositoryId and selectedWorktreeId
  const selectedRepositoryId = snapshot.selectedRepositoryId; // repos may differ but allow graceful fallback
  const selectedWorktreeId =
    snapshot.selectedWorktreeId && validWorktreeIds.has(snapshot.selectedWorktreeId)
      ? snapshot.selectedWorktreeId
      : null;

  // Validate tabs — filter out session tabs referencing invalid projects
  const validTabs = snapshot.openTabs.filter((tab) => {
    if (tab.type === 'session' && tab.projectId) {
      return validProjectIds.has(tab.projectId) || validWorktreeIds.has(tab.projectId);
    }
    return true; // Keep dashboard and non-session tabs
  });

  // Validate activeTabId
  let activeTabId = snapshot.activeTabId;
  if (activeTabId && !validTabs.find((t) => t.id === activeTabId)) {
    activeTabId = validTabs[0]?.id ?? null;
  }

  // Validate pane layout tabs
  const validatedPanes = snapshot.paneLayout.panes
    .map((pane) => {
      const paneTabs = pane.tabs.filter((tab) => {
        if (tab.type === 'session' && tab.projectId) {
          return validProjectIds.has(tab.projectId) || validWorktreeIds.has(tab.projectId);
        }
        return true;
      });
      const paneActiveId = paneTabs.find((t) => t.id === pane.activeTabId)
        ? pane.activeTabId
        : (paneTabs[0]?.id ?? null);
      return {
        ...pane,
        tabs: paneTabs,
        activeTabId: paneActiveId,
        selectedTabIds: pane.selectedTabIds.filter((id) => paneTabs.some((t) => t.id === id)),
      };
    })
    .filter((pane) => pane.tabs.length > 0); // Remove empty panes

  // Ensure at least one pane exists
  const finalPanes: Pane[] =
    validatedPanes.length > 0
      ? validatedPanes
      : [
          {
            id: 'pane-default',
            tabs: [],
            activeTabId: null,
            selectedTabIds: [],
            widthFraction: 1,
          },
        ];

  return {
    // Restored from snapshot (use fresh data for projects/repoGroups)
    projects: freshProjects,
    selectedProjectId,
    repositoryGroups: freshRepoGroups,
    selectedRepositoryId,
    selectedWorktreeId,
    viewMode: snapshot.viewMode,
    sessions: snapshot.sessions,
    selectedSessionId: snapshot.selectedSessionId,
    sessionsCursor: snapshot.sessionsCursor,
    sessionsHasMore: snapshot.sessionsHasMore,
    sessionsTotalCount: snapshot.sessionsTotalCount,
    pinnedSessionIds: snapshot.pinnedSessionIds,
    notifications: snapshot.notifications,
    unreadCount: snapshot.unreadCount,
    openTabs: validTabs,
    activeTabId,
    selectedTabIds: snapshot.selectedTabIds.filter((id) => validTabs.some((t) => t.id === id)),
    activeProjectId:
      snapshot.activeProjectId &&
      (validProjectIds.has(snapshot.activeProjectId) ||
        validWorktreeIds.has(snapshot.activeProjectId))
        ? snapshot.activeProjectId
        : selectedProjectId,
    paneLayout: {
      panes: finalPanes,
      focusedPaneId: finalPanes.find((p) => p.id === snapshot.paneLayout.focusedPaneId)
        ? snapshot.paneLayout.focusedPaneId
        : finalPanes[0].id,
    },
    sidebarCollapsed: snapshot.sidebarCollapsed,
  };
}

/**
 * Capture current context state as a snapshot.
 * Excludes transient state (loading flags, errors, search, Maps/Sets).
 */
function captureSnapshot(state: AppState, contextId: string): ContextSnapshot {
  return {
    // Data state
    projects: state.projects,
    selectedProjectId: state.selectedProjectId,
    repositoryGroups: state.repositoryGroups,
    selectedRepositoryId: state.selectedRepositoryId,
    selectedWorktreeId: state.selectedWorktreeId,
    viewMode: state.viewMode,
    sessions: state.sessions,
    selectedSessionId: state.selectedSessionId,
    sessionsCursor: state.sessionsCursor,
    sessionsHasMore: state.sessionsHasMore,
    sessionsTotalCount: state.sessionsTotalCount,
    pinnedSessionIds: state.pinnedSessionIds,
    notifications: state.notifications,
    unreadCount: state.unreadCount,

    // Tab/pane state
    openTabs: state.openTabs,
    activeTabId: state.activeTabId,
    selectedTabIds: state.selectedTabIds,
    activeProjectId: state.activeProjectId,
    paneLayout: state.paneLayout,

    // UI state
    sidebarCollapsed: state.sidebarCollapsed,

    // Metadata
    _metadata: {
      contextId,
      capturedAt: Date.now(),
      version: 1,
    },
  };
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createContextSlice: StateCreator<AppState, [], [], ContextSlice> = (set, get) => ({
  // Initial state
  activeContextId: 'local',
  isContextSwitching: false,
  targetContextId: null,
  contextSnapshotsReady: false,
  availableContexts: [{ id: 'local', type: 'local' as const }],
  sourceFilter: 'all',

  // Initialize context system (called once on app mount)
  initializeContextSystem: async () => {
    try {
      // Check IndexedDB availability
      const available = await contextStorage.isAvailable();
      if (available) {
        // Clean up expired snapshots
        void contextStorage.cleanupExpired();
      }

      // Fetch active context from main process
      const activeContextId = await api.context.getActive();

      set({
        contextSnapshotsReady: true,
        activeContextId,
      });

      // Fetch available contexts
      await get().fetchAvailableContexts();

      // Sync dataBackend label with the active context metadata.
      const state = get();
      const activeContext = state.availableContexts.find((ctx) => ctx.id === state.activeContextId);
      if (activeContext?.backend) {
        set({ dataBackend: activeContext.backend });
      }
    } catch (error) {
      console.error('[contextSlice] Failed to initialize context system:', error);
      set({ contextSnapshotsReady: true }); // Continue anyway
    }
  },

  // Fetch list of available contexts (local + SSH)
  fetchAvailableContexts: async () => {
    try {
      const prevLocalCount = get().availableContexts.filter((ctx) => ctx.type === 'local').length;
      const result = await api.context.list();
      set({ availableContexts: result });

      // Crossing the 1↔many local-source boundary changes the effective data
      // source (single-context ↔ aggregate): refetch the view. Aggregate mode
      // no longer depends on sourceFilter, so this keys purely on the count.
      const nextLocalCount = result.filter((ctx) => ctx.type === 'local').length;
      const wasAggregate = prevLocalCount > 1;
      const isAggregate = nextLocalCount > 1;
      if (wasAggregate !== isAggregate) {
        const state = get();
        if (state.viewMode === 'grouped') {
          void state.fetchRepositoryGroups();
        } else {
          void state.fetchProjects();
        }
        if (state.selectedProjectId) {
          void state.fetchSessionsInitial(state.selectedProjectId);
        }
      }
    } catch (error) {
      console.error('[contextSlice] Failed to fetch available contexts:', error);
      // Fallback to local-only
      set({ availableContexts: [{ id: 'local', type: 'local' }] });
    }
  },

  // Set the sidebar source filter. Pure client-side view filter: the aggregate
  // data is already the full merged set, so switching the chip only changes
  // what the lists render (see projectMatchesSource / sessionMatchesSource).
  // No context switch, no refetch, no loading spinner.
  setSourceFilter: (filter: SourceFilter) => {
    if (filter === get().sourceFilter) return;
    set({ sourceFilter: filter });
  },

  // Switch to a different context
  switchContext: async (targetContextId: string) => {
    const state = get();

    // Early return if already on target context
    if (targetContextId === state.activeContextId) {
      return;
    }

    // Re-entrancy guard: prevent concurrent switch races from overlapping events
    if (state.isContextSwitching) {
      return;
    }

    set({
      isContextSwitching: true,
      targetContextId,
    });

    try {
      // Step 1: Save current snapshot + load target snapshot + switch main process
      // These are independent — run in parallel for speed.
      // In aggregate ("All") mode the store holds merged cross-backend data,
      // not the active context's own state — never persist it as a snapshot.
      const currentSnapshot =
        state.sourceFilter === 'all' ? null : captureSnapshot(state, state.activeContextId);
      const [, targetSnapshot] = await Promise.all([
        currentSnapshot
          ? contextStorage.saveSnapshot(state.activeContextId, currentSnapshot)
          : Promise.resolve(),
        contextStorage.loadSnapshot(targetContextId),
        api.context.switch(targetContextId),
      ]);

      // Update dataBackend label from the target context metadata.
      const targetContext = state.availableContexts.find((ctx) => ctx.id === targetContextId);
      const nextDataBackend = targetContext?.backend ?? state.dataBackend;
      if (targetSnapshot) {
        set({
          projects: targetSnapshot.projects,
          repositoryGroups: targetSnapshot.repositoryGroups,
          selectedProjectId: targetSnapshot.selectedProjectId,
          selectedRepositoryId: targetSnapshot.selectedRepositoryId,
          selectedWorktreeId: targetSnapshot.selectedWorktreeId,
          viewMode: targetSnapshot.viewMode,
          sessions: targetSnapshot.sessions,
          selectedSessionId: targetSnapshot.selectedSessionId,
          sessionsCursor: targetSnapshot.sessionsCursor,
          sessionsHasMore: targetSnapshot.sessionsHasMore,
          sessionsTotalCount: targetSnapshot.sessionsTotalCount,
          pinnedSessionIds: targetSnapshot.pinnedSessionIds,
          notifications: targetSnapshot.notifications,
          unreadCount: targetSnapshot.unreadCount,
          openTabs: targetSnapshot.openTabs,
          activeTabId: targetSnapshot.activeTabId,
          selectedTabIds: targetSnapshot.selectedTabIds,
          activeProjectId: targetSnapshot.activeProjectId,
          paneLayout: targetSnapshot.paneLayout,
          sidebarCollapsed: targetSnapshot.sidebarCollapsed,
          // Finalize switch — overlay disappears, user sees cached data instantly
          activeContextId: targetContextId,
          dataBackend: nextDataBackend,
          isContextSwitching: false,
          targetContextId: null,
        });
      }

      // Step 3: Fetch fresh data in background (slow over SSH)
      // Wrapped in try/catch so fetch failures don't wipe valid snapshot data.
      // IPC handlers return [] on SSH scan failure — we must guard against that.
      try {
        const [freshProjects, freshRepoGroups] = await Promise.all([
          api.getProjects(),
          api.getRepositoryGroups(),
        ]);

        if (targetSnapshot) {
          // Guard: don't overwrite snapshot data if fetch returned empty
          // (likely transient SSH scan failure, not genuinely empty workspace)
          const snapshotHadData =
            targetSnapshot.projects.length > 0 || targetSnapshot.repositoryGroups.length > 0;
          const freshIsEmpty = freshProjects.length === 0 && freshRepoGroups.length === 0;

          if (snapshotHadData && freshIsEmpty) {
            console.warn(
              '[contextSlice] Background fetch returned empty but snapshot had data — keeping snapshot'
            );
          } else {
            set(validateSnapshot(targetSnapshot, freshProjects, freshRepoGroups));
          }
        } else {
          // No cache (first visit) — apply empty state with fresh data
          set({
            ...getEmptyContextState(),
            projects: freshProjects,
            repositoryGroups: freshRepoGroups,
            activeContextId: targetContextId,
            dataBackend: nextDataBackend,
            isContextSwitching: false,
            targetContextId: null,
          });
        }
      } catch (fetchError) {
        console.error('[contextSlice] Background data refresh failed:', fetchError);
        // Keep snapshot data as fallback — don't wipe user's view
        if (!targetSnapshot) {
          // No snapshot and fetch failed — finalize switch with empty state
          set({
            ...getEmptyContextState(),
            activeContextId: targetContextId,
            dataBackend: nextDataBackend,
            isContextSwitching: false,
            targetContextId: null,
          });
        }
      }

      // Step 4: Fetch notifications in background
      void get().fetchNotifications();
    } catch (error) {
      console.error('[contextSlice] Failed to switch context:', error);
      // Do NOT leave in broken state
      set({
        isContextSwitching: false,
        targetContextId: null,
      });
    }
  },
});
