/**
 * context-file-change (aggregate live updates) unit tests.
 *
 * Covers the renderer subscription to context-tagged file-change events from
 * inactive local backends:
 * - Aggregate ("All") mode refreshes the sidebar via the aggregate endpoints
 * - Bursts from multiple backends coalesce through the shared debounce
 * - Viewed session detail refreshes through its origin context
 * - Single-source mode (and SSH-active mode) ignores tagged events entirely
 *
 * Uses the real store singleton from src/renderer/store because
 * initializeNotificationListeners() wires module-level subscriptions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installMockElectronAPI, type MockElectronAPI } from '../../mocks/electronAPI';

import type { Session } from '../../src/renderer/types/data';
import type { FileChangeEvent } from '@shared/types';
import type { ContextInfo } from '@shared/types/api';

type StoreModule = typeof import('../../../src/renderer/store');
type ContextFileChangeHandler = (payload: {
  contextId: string;
  event: FileChangeEvent;
}) => void;

const MULTI_CONTEXTS: ContextInfo[] = [
  { id: 'local', type: 'local', backend: 'claude' },
  { id: 'local-kimi', type: 'local', backend: 'kimi' },
];

function makeEvent(overrides?: Partial<FileChangeEvent>): FileChangeEvent {
  return {
    type: 'add',
    path: '/home/testuser/.kimi-code/sessions/project-1/new-session.jsonl',
    projectId: 'project-1',
    sessionId: 'new-session',
    isSubagent: false,
    ...overrides,
  };
}

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

/** Allow debounced refreshes (300ms project / 150ms session) to fire, then assert. */
const flushDebounce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600));

describe('context-file-change (aggregate live updates)', () => {
  let storeModule: StoreModule;
  let mockAPI: MockElectronAPI;
  let taggedHandler: ContextFileChangeHandler | null;
  let cleanupListeners: (() => void) | undefined;

  beforeEach(async () => {
    mockAPI = installMockElectronAPI();
    taggedHandler = null;
    mockAPI.onContextFileChange.mockImplementation((cb: ContextFileChangeHandler) => {
      taggedHandler = cb;
      return () => undefined;
    });
    storeModule = await import('../../../src/renderer/store');
    cleanupListeners = storeModule.initializeNotificationListeners();
  });

  afterEach(() => {
    cleanupListeners?.();
    cleanupListeners = undefined;
    vi.restoreAllMocks();
  });

  const emitTagged = (contextId: string, event: FileChangeEvent): void => {
    expect(taggedHandler, 'onContextFileChange was not subscribed').not.toBeNull();
    taggedHandler!({ contextId, event });
  };

  describe('aggregate mode', () => {
    beforeEach(() => {
      storeModule.useStore.setState({
        availableContexts: MULTI_CONTEXTS,
        sourceFilter: 'all',
        activeContextId: 'local',
        selectedProjectId: 'project-1',
      });
    });

    it('refreshes the sidebar through the aggregate endpoint on a tagged event', async () => {
      emitTagged('local-kimi', makeEvent());

      await vi.waitFor(() => expect(mockAPI.getAllSessions).toHaveBeenCalledWith('project-1'));
      expect(mockAPI.getSessionsPaginated).not.toHaveBeenCalled();
      expect(mockAPI.getSessions).not.toHaveBeenCalled();
    });

    it('coalesces bursts from multiple backends into a single refresh', async () => {
      emitTagged('local-kimi', makeEvent({ sessionId: 'new-session-1' }));
      emitTagged('local-codex', makeEvent({ sessionId: 'new-session-2' }));

      await vi.waitFor(() => expect(mockAPI.getAllSessions).toHaveBeenCalled());
      await flushDebounce();
      expect(mockAPI.getAllSessions).toHaveBeenCalledOnce();
    });

    it('refreshes a viewed session detail through its origin context', async () => {
      storeModule.useStore.setState({
        selectedSessionId: 's1',
        sessions: [makeSession('s1', { contextId: 'local-kimi', sourceBackend: 'kimi' })],
      });

      emitTagged(
        'local-kimi',
        makeEvent({ type: 'change', sessionId: 's1', path: '/x/project-1/s1.jsonl' })
      );

      await vi.waitFor(() => expect(mockAPI.getSessionDetailByContext).toHaveBeenCalledOnce());
      expect(mockAPI.getSessionDetailByContext).toHaveBeenCalledWith({
        contextId: 'local-kimi',
        sessionId: 's1',
        projectId: 'project-1',
      });
      expect(mockAPI.getSessionDetail).not.toHaveBeenCalled();
    });
  });

  describe('ignored outside aggregate mode', () => {
    it('ignores tagged events in single-source mode (one local context)', async () => {
      storeModule.useStore.setState({
        availableContexts: [{ id: 'local', type: 'local', backend: 'claude' }],
        sourceFilter: 'all',
        activeContextId: 'local',
        selectedProjectId: 'project-1',
      });

      emitTagged('local-kimi', makeEvent());
      await flushDebounce();

      expect(mockAPI.getAllSessions).not.toHaveBeenCalled();
      expect(mockAPI.getSessionsPaginated).not.toHaveBeenCalled();
      expect(mockAPI.getSessions).not.toHaveBeenCalled();
      expect(mockAPI.getSessionDetailByContext).not.toHaveBeenCalled();
    });

    it('still refreshes with a backend chip selected (chip is a client-side filter, not a mode)', async () => {
      // A backend chip no longer switches context — the store stays in aggregate
      // mode over the merged data, so tagged events from any local backend must
      // still refresh. The source chip only filters what the list renders.
      storeModule.useStore.setState({
        availableContexts: MULTI_CONTEXTS,
        sourceFilter: 'kimi',
        activeContextId: 'local',
        selectedProjectId: 'project-1',
      });

      emitTagged('local', makeEvent());

      await vi.waitFor(() => expect(mockAPI.getAllSessions).toHaveBeenCalledWith('project-1'));
      expect(mockAPI.getSessionsPaginated).not.toHaveBeenCalled();
      expect(mockAPI.getSessions).not.toHaveBeenCalled();
    });

    it('ignores tagged events while an SSH context is active', async () => {
      storeModule.useStore.setState({
        availableContexts: [...MULTI_CONTEXTS, { id: 'ssh-host', type: 'ssh' }],
        sourceFilter: 'all',
        activeContextId: 'ssh-host',
        selectedProjectId: 'project-1',
      });

      emitTagged('local-kimi', makeEvent());
      await flushDebounce();

      expect(mockAPI.getAllSessions).not.toHaveBeenCalled();
      expect(mockAPI.getSessionsPaginated).not.toHaveBeenCalled();
      expect(mockAPI.getSessions).not.toHaveBeenCalled();
    });
  });
});
