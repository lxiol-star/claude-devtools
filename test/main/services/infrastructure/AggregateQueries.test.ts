import { describe, expect, it, vi } from 'vitest';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  canonicalProjectId,
  fetchContextSessionDetail,
  fetchContextWaterfallData,
  listAllLocalSessions,
  listLocalContexts,
  mergeTaggedProjects,
  mergeTaggedRepositoryGroups,
  normalizeProjectPath,
  resolveContextBackend,
  resolveNativeProjectId,
  scanAllLocalProjects,
  type AggregateContext,
  type SessionDetailServices,
} from '@main/services/infrastructure/AggregateQueries';
import { DataCache } from '@main/services/infrastructure/DataCache';

import type { ChunkBuilder } from '@main/services/analysis/ChunkBuilder';
import type { ProjectScanner } from '@main/services/discovery/ProjectScanner';
import type { SubagentResolver } from '@main/services/discovery/SubagentResolver';
import type { ServiceContext } from '@main/services/infrastructure/ServiceContext';
import type { ServiceContextRegistry } from '@main/services/infrastructure/ServiceContextRegistry';
import type { SessionParser } from '@main/services/parsing/SessionParser';
import type { Project, RepositoryGroup, Session, SessionDetail, Worktree } from '@main/types';
import type { DataBackendName } from '@shared/types/api';

// =============================================================================
// Fixtures
// =============================================================================

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: '-Users-dev-myproject',
    path: '/Users/dev/myproject',
    name: 'myproject',
    sessions: ['s1'],
    createdAt: 1000,
    mostRecentSession: 2000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    projectId: '-Users-dev-myproject',
    projectPath: '/Users/dev/myproject',
    createdAt: 2000,
    hasSubagents: false,
    messageCount: 3,
    ...overrides,
  };
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: '-Users-dev-myproject',
    path: '/Users/dev/myproject',
    name: 'main',
    isMainWorktree: true,
    source: 'git',
    sessions: ['s1'],
    createdAt: 1000,
    mostRecentSession: 2000,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<RepositoryGroup> = {}): RepositoryGroup {
  const worktrees = overrides.worktrees ?? [makeWorktree()];
  return {
    id: 'repo-1',
    identity: null,
    worktrees,
    name: 'myproject',
    mostRecentSession: 2000,
    totalSessions: worktrees.reduce((sum, wt) => sum + wt.sessions.length, 0),
    ...overrides,
  };
}

function makeContext(
  id: string,
  backendName: DataBackendName | undefined,
  scanner: Partial<ProjectScanner>
): AggregateContext {
  return {
    id,
    backendName,
    projectScanner: scanner as ProjectScanner,
  };
}

// =============================================================================
// resolveContextBackend
// =============================================================================

describe('resolveContextBackend', () => {
  it('prefers the explicit backendName', () => {
    expect(resolveContextBackend({ id: 'local', backendName: 'kimi' })).toBe('kimi');
  });

  it('derives the backend from the local-{backend} id suffix', () => {
    expect(resolveContextBackend({ id: 'local-kimi' })).toBe('kimi');
    expect(resolveContextBackend({ id: 'local-codex' })).toBe('codex');
    expect(resolveContextBackend({ id: 'local-claude' })).toBe('claude');
  });

  it("falls back to 'claude' for the primary root and unknown suffixes", () => {
    expect(resolveContextBackend({ id: 'local' })).toBe('claude');
    expect(resolveContextBackend({ id: 'local-unknown' })).toBe('claude');
    expect(resolveContextBackend({ id: 'ssh-myserver' })).toBe('claude');
  });
});

// =============================================================================
// listLocalContexts
// =============================================================================

describe('listLocalContexts', () => {
  it('returns only local-type contexts present in the registry', () => {
    const local = { id: 'local', type: 'local' } as ServiceContext;
    const kimi = { id: 'local-kimi', type: 'local' } as ServiceContext;
    const ssh = { id: 'ssh-host', type: 'ssh' } as ServiceContext;
    const registry = {
      list: () => [
        { id: 'local', type: 'local' as const },
        { id: 'local-kimi', type: 'local' as const },
        { id: 'ssh-host', type: 'ssh' as const },
      ],
      get: (id: string) => {
        if (id === 'local') return local;
        if (id === 'local-kimi') return kimi;
        if (id === 'ssh-host') return ssh;
        return undefined;
      },
    } as unknown as ServiceContextRegistry;

    expect(listLocalContexts(registry)).toEqual([local, kimi]);
  });
});

// =============================================================================
// mergeTaggedProjects
// =============================================================================

describe('mergeTaggedProjects', () => {
  it('merges projects with the same id, dropping ambiguous origin tags', () => {
    const claude = makeProject({
      sessions: ['s1', 's2'],
      createdAt: 1000,
      mostRecentSession: 2000,
      contextId: 'local',
      sourceBackend: 'claude',
    });
    const kimi = makeProject({
      sessions: ['s2', 's3'],
      createdAt: 500,
      mostRecentSession: 3000,
      contextId: 'local-kimi',
      sourceBackend: 'kimi',
    });

    const merged = mergeTaggedProjects([claude, kimi]);

    expect(merged).toHaveLength(1);
    const [project] = merged;
    expect(project.sessions).toEqual(['s1', 's2', 's3']);
    expect(project.createdAt).toBe(500);
    expect(project.mostRecentSession).toBe(3000);
    expect(project.contextId).toBeUndefined();
    expect(project.sourceBackend).toBeUndefined();
    // Cross-backend merge keeps the ordered union of all origins.
    expect(project.sourceBackends).toEqual(['claude', 'kimi']);
  });

  it('keeps sourceBackend when merged sources agree on the backend', () => {
    const first = makeProject({ contextId: 'local', sourceBackend: 'claude' });
    const second = makeProject({ contextId: 'local-claude', sourceBackend: 'claude' });

    const [project] = mergeTaggedProjects([first, second]);

    expect(project.sourceBackend).toBe('claude');
    expect(project.contextId).toBeUndefined();
    expect(project.sourceBackends).toEqual(['claude']);
  });

  it('keeps origin tags for single-source projects and sorts by recency desc', () => {
    const older = makeProject({
      id: 'proj-a',
      mostRecentSession: 1000,
      contextId: 'local',
      sourceBackend: 'claude',
    });
    const newer = makeProject({
      id: 'proj-b',
      mostRecentSession: 5000,
      contextId: 'local-kimi',
      sourceBackend: 'kimi',
    });

    const merged = mergeTaggedProjects([older, newer]);

    expect(merged.map((p) => p.id)).toEqual(['proj-b', 'proj-a']);
    expect(merged[0].contextId).toBe('local-kimi');
    expect(merged[0].sourceBackend).toBe('kimi');
  });

  it('keeps mostRecentSession undefined when no source has it', () => {
    const project = makeProject({ mostRecentSession: undefined, contextId: 'local' });
    const [merged] = mergeTaggedProjects([project]);
    expect(merged.mostRecentSession).toBeUndefined();
  });
});

// =============================================================================
// mergeTaggedRepositoryGroups
// =============================================================================

describe('mergeTaggedRepositoryGroups', () => {
  it('merges groups by repo id, merging worktrees and recomputing totals', () => {
    const sharedWorktree = makeWorktree({
      sessions: ['s1'],
      contextId: 'local',
      sourceBackend: 'claude',
    });
    const claudeGroup = makeGroup({
      worktrees: [sharedWorktree],
      contextId: 'local',
      sourceBackend: 'claude',
      mostRecentSession: 2000,
    });
    const kimiGroup = makeGroup({
      worktrees: [
        makeWorktree({
          sessions: ['s1', 's2'],
          mostRecentSession: 4000,
          contextId: 'local-kimi',
          sourceBackend: 'kimi',
        }),
        makeWorktree({
          id: '-Users-dev-myproject-wt2',
          path: '/Users/dev/myproject-wt2',
          name: 'wt2',
          isMainWorktree: false,
          sessions: ['s9'],
          contextId: 'local-kimi',
          sourceBackend: 'kimi',
        }),
      ],
      contextId: 'local-kimi',
      sourceBackend: 'kimi',
      mostRecentSession: 4000,
    });

    const merged = mergeTaggedRepositoryGroups([claudeGroup, kimiGroup]);

    expect(merged).toHaveLength(1);
    const [group] = merged;
    expect(group.contextId).toBeUndefined();
    expect(group.sourceBackend).toBeUndefined();
    expect(group.mostRecentSession).toBe(4000);
    // s1/s2 in main worktree (deduped union) + s9 in wt2
    expect(group.totalSessions).toBe(3);
    expect(group.worktrees).toHaveLength(2);
    // Main worktree first, merged sessions unioned, tags dropped (seen in 2 contexts)
    const main = group.worktrees[0];
    expect(main.isMainWorktree).toBe(true);
    expect(main.sessions).toEqual(['s1', 's2']);
    expect(main.mostRecentSession).toBe(4000);
    expect(main.contextId).toBeUndefined();
    // Worktree seen in a single context keeps its tags
    const wt2 = group.worktrees[1];
    expect(wt2.contextId).toBe('local-kimi');
    expect(wt2.sourceBackend).toBe('kimi');
  });

  it('sorts groups by mostRecentSession desc', () => {
    const older = makeGroup({ id: 'repo-old', mostRecentSession: 1000 });
    const newer = makeGroup({ id: 'repo-new', mostRecentSession: 9000 });

    const merged = mergeTaggedRepositoryGroups([older, newer]);

    expect(merged.map((g) => g.id)).toEqual(['repo-new', 'repo-old']);
  });
});

// =============================================================================
// scanAllLocalProjects
// =============================================================================

describe('scanAllLocalProjects', () => {
  it('rewrites ids to canonical(path) and keeps single-source ordering + tags', async () => {
    const projects = [
      makeProject({ id: '-Users-dev-b', path: '/Users/dev/b', mostRecentSession: 1000 }),
      makeProject({ id: '-Users-dev-a', path: '/Users/dev/a', mostRecentSession: 5000 }),
    ];
    const context = makeContext('local', 'claude', {
      scan: vi.fn().mockResolvedValue(projects),
    });

    const result = await scanAllLocalProjects([context]);

    // Same ordering the single-source scan produces (recency desc), but ids are
    // rewritten to the backend-independent canonical id.
    expect(result.map((p) => p.id)).toEqual([
      canonicalProjectId('/Users/dev/a'),
      canonicalProjectId('/Users/dev/b'),
    ]);
    for (const project of result) {
      expect(project.contextId).toBe('local');
      expect(project.sourceBackend).toBe('claude');
      expect(project.sourceBackends).toEqual(['claude']);
    }
  });

  it('merges the same repo across Claude (dash) and Kimi (base64url) into one card', async () => {
    const repoPath = '/Users/dev/myproject';
    const claude = makeContext('local', 'claude', {
      scan: vi.fn().mockResolvedValue([
        makeProject({
          id: '-Users-dev-myproject',
          path: repoPath,
          sessions: ['c1', 'c2'],
          createdAt: 500,
          mostRecentSession: 2000,
        }),
      ]),
    });
    const kimi = makeContext('local-kimi', 'kimi', {
      scan: vi.fn().mockResolvedValue([
        makeProject({
          id: canonicalProjectId(repoPath),
          path: repoPath,
          sessions: ['k1'],
          createdAt: 900,
          mostRecentSession: 3000,
        }),
      ]),
    });

    const result = await scanAllLocalProjects([claude, kimi]);

    expect(result).toHaveLength(1);
    const [merged] = result;
    expect(merged.id).toBe(canonicalProjectId(repoPath));
    // Sessions unioned, createdAt min, mostRecentSession max.
    expect([...merged.sessions].sort()).toEqual(['c1', 'c2', 'k1']);
    expect(merged.createdAt).toBe(500);
    expect(merged.mostRecentSession).toBe(3000);
    // Ambiguous singular origin (two backends) → singular tags dropped, but the
    // ordered union is retained for client-side source filtering.
    expect(merged.contextId).toBeUndefined();
    expect(merged.sourceBackend).toBeUndefined();
    expect(merged.sourceBackends).toEqual(['claude', 'kimi']);
  });

  it('skips a failing context and still returns the others', async () => {
    const broken = makeContext('local-kimi', 'kimi', {
      scan: vi.fn().mockRejectedValue(new Error('dir missing')),
    });
    const healthy = makeContext('local', 'claude', {
      scan: vi.fn().mockResolvedValue([makeProject()]),
    });

    const result = await scanAllLocalProjects([broken, healthy]);

    expect(result).toHaveLength(1);
    expect(result[0].sourceBackend).toBe('claude');
  });
});

// =============================================================================
// listAllLocalSessions
// =============================================================================

describe('listAllLocalSessions', () => {
  // resolveNativeProjectId scans each context; a scan whose ids don't contain
  // the passed id and whose paths don't match falls back to the id unchanged.
  const passthroughScan = (): { scan: ReturnType<typeof vi.fn> } => ({
    scan: vi.fn().mockResolvedValue([]),
  });

  it('concatenates tagged sessions from all contexts, sorted by createdAt desc', async () => {
    const claude = makeContext('local', 'claude', {
      ...passthroughScan(),
      listSessions: vi.fn().mockResolvedValue([makeSession({ id: 's1', createdAt: 1000 })]),
    });
    const kimi = makeContext('local-kimi', 'kimi', {
      ...passthroughScan(),
      listSessions: vi.fn().mockResolvedValue([makeSession({ id: 's2', createdAt: 3000 })]),
    });

    const result = await listAllLocalSessions([claude, kimi], 'proj');

    expect(result.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(result[0].contextId).toBe('local-kimi');
    expect(result[0].sourceBackend).toBe('kimi');
    expect(result[1].contextId).toBe('local');
    expect(result[1].sourceBackend).toBe('claude');
  });

  it('resolves the canonical id to each backend native id before listing', async () => {
    const repoPath = '/Users/dev/myproject';
    const canonical = canonicalProjectId(repoPath);

    // Claude: canonical does not match any scanned id, so it resolves via path
    // to the dash-encoded native id.
    const claudeList = vi.fn().mockResolvedValue([makeSession({ id: 'c1', createdAt: 1000 })]);
    const claude = makeContext('local', 'claude', {
      scan: vi
        .fn()
        .mockResolvedValue([makeProject({ id: '-Users-dev-myproject', path: repoPath })]),
      listSessions: claudeList,
    });
    // Kimi: canonical == native id, matched directly in the scan.
    const kimiList = vi.fn().mockResolvedValue([makeSession({ id: 'k1', createdAt: 2000 })]);
    const kimi = makeContext('local-kimi', 'kimi', {
      scan: vi.fn().mockResolvedValue([makeProject({ id: canonical, path: repoPath })]),
      listSessions: kimiList,
    });

    const result = await listAllLocalSessions([claude, kimi], canonical);

    expect(claudeList).toHaveBeenCalledWith('-Users-dev-myproject');
    expect(kimiList).toHaveBeenCalledWith(canonical);
    expect(result.map((s) => s.id)).toEqual(['k1', 'c1']);
  });

  it('dedupes duplicate session ids from the same context but keeps cross-context ones', async () => {
    const claude = makeContext('local', 'claude', {
      ...passthroughScan(),
      listSessions: vi.fn().mockResolvedValue([makeSession({ id: 'same-id' })]),
    });
    const codex = makeContext('local-codex', 'codex', {
      ...passthroughScan(),
      listSessions: vi.fn().mockResolvedValue([makeSession({ id: 'same-id' })]),
    });

    const result = await listAllLocalSessions([claude, codex], 'proj');

    // Different contextId → distinct entries, both kept.
    expect(result).toHaveLength(2);
    expect(new Set(result.map((s) => s.sourceBackend))).toEqual(new Set(['claude', 'codex']));
  });

  it('drops a true duplicate (same contextId + id) from one context', async () => {
    const claude = makeContext('local', 'claude', {
      ...passthroughScan(),
      listSessions: vi
        .fn()
        .mockResolvedValue([makeSession({ id: 'dup' }), makeSession({ id: 'dup' })]),
    });

    const result = await listAllLocalSessions([claude], 'proj');

    expect(result).toHaveLength(1);
  });

  it('skips a failing context and still returns the others', async () => {
    const broken = makeContext('local-kimi', 'kimi', {
      ...passthroughScan(),
      listSessions: vi.fn().mockRejectedValue(new Error('service stopped')),
    });
    const healthy = makeContext('local', 'claude', {
      ...passthroughScan(),
      listSessions: vi.fn().mockResolvedValue([makeSession()]),
    });

    const result = await listAllLocalSessions([broken, healthy], 'proj');

    expect(result).toHaveLength(1);
    expect(result[0].contextId).toBe('local');
  });
});

// =============================================================================
// canonicalProjectId / normalizeProjectPath / resolveNativeProjectId
// =============================================================================

describe('normalizeProjectPath', () => {
  it('strips a single trailing separator but preserves a root', () => {
    expect(normalizeProjectPath('/Users/dev/proj/')).toBe('/Users/dev/proj');
    expect(normalizeProjectPath('/Users/dev/proj')).toBe('/Users/dev/proj');
    expect(normalizeProjectPath('/')).toBe('/');
  });

  it('applies Unicode NFC without changing case', () => {
    // 'é' as NFD (e + combining acute) normalizes to the NFC single codepoint.
    const nfd = '/Users/dev/cafe\u0301';
    const nfc = '/Users/dev/caf\u00e9';
    expect(normalizeProjectPath(nfd)).toBe(nfc);
    expect(normalizeProjectPath('/Users/Dev/Proj')).toBe('/Users/Dev/Proj');
  });
});

describe('canonicalProjectId', () => {
  it('is base64url(path) and stable across trailing-slash variants', () => {
    const path = '/Users/dev/myproject';
    expect(canonicalProjectId(path)).toBe(Buffer.from(path, 'utf8').toString('base64url'));
    expect(canonicalProjectId(path + '/')).toBe(canonicalProjectId(path));
  });

  it('never collides with a Claude dash-encoded id (no leading dash)', () => {
    // base64url of a POSIX absolute path starts with 'L' ('/'), not '-'.
    expect(canonicalProjectId('/Users/dev/x').startsWith('-')).toBe(false);
  });
});

describe('resolveNativeProjectId', () => {
  const makeScanner = (impl: Partial<ProjectScanner>): { projectScanner: ProjectScanner } => ({
    projectScanner: impl as ProjectScanner,
  });

  it('passes through when the id already matches a scanned native id (Kimi/Codex)', async () => {
    const canonical = canonicalProjectId('/Users/dev/proj');
    const ctx = makeScanner({
      scan: vi.fn().mockResolvedValue([makeProject({ id: canonical, path: '/Users/dev/proj' })]),
    });
    expect(await resolveNativeProjectId(ctx, canonical)).toBe(canonical);
  });

  it('resolves a canonical id to the Claude dash id via path match', async () => {
    const ctx = makeScanner({
      scan: vi
        .fn()
        .mockResolvedValue([makeProject({ id: '-Users-dev-proj', path: '/Users/dev/proj' })]),
    });
    const canonical = canonicalProjectId('/Users/dev/proj');
    expect(await resolveNativeProjectId(ctx, canonical)).toBe('-Users-dev-proj');
  });

  it('resolves to a Claude composite subproject id when its path matches', async () => {
    const ctx = makeScanner({
      scan: vi.fn().mockResolvedValue([
        makeProject({ id: '-Users-dev-proj::abcd1234', path: '/Users/dev/proj/sub' }),
      ]),
    });
    const canonical = canonicalProjectId('/Users/dev/proj/sub');
    expect(await resolveNativeProjectId(ctx, canonical)).toBe('-Users-dev-proj::abcd1234');
  });

  it('returns the id unchanged when no scanned project matches', async () => {
    const ctx = makeScanner({
      scan: vi.fn().mockResolvedValue([makeProject({ id: 'other', path: '/Users/dev/other' })]),
    });
    const canonical = canonicalProjectId('/Users/dev/missing');
    expect(await resolveNativeProjectId(ctx, canonical)).toBe(canonical);
  });

  it('returns the id unchanged when the scan throws', async () => {
    const ctx = makeScanner({ scan: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(await resolveNativeProjectId(ctx, 'anything')).toBe('anything');
  });
});

// =============================================================================
// fetchContextSessionDetail
// =============================================================================

describe('fetchContextSessionDetail', () => {
  function makeServices(overrides: Partial<SessionDetailServices> = {}): SessionDetailServices {
    const session = makeSession();
    const detail = {
      session,
      messages: [],
      chunks: [],
      processes: [],
      metrics: {
        durationMs: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messageCount: 0,
      },
    } as unknown as SessionDetail;

    return {
      projectScanner: {
        getFileSystemProvider: () => ({ type: 'local' }),
        getSessionWithOptions: vi.fn().mockResolvedValue(session),
      } as unknown as ProjectScanner,
      sessionParser: {
        parseSession: vi.fn().mockResolvedValue({ taskCalls: [], messages: [] }),
      } as unknown as SessionParser,
      subagentResolver: {
        resolveSubagents: vi.fn().mockResolvedValue([]),
      } as unknown as SubagentResolver,
      chunkBuilder: {
        buildSessionDetail: vi.fn().mockReturnValue(detail),
      } as unknown as ChunkBuilder,
      dataCache: new DataCache(10, 60, true),
      ...overrides,
    };
  }

  it('builds and caches the session detail on a cache miss', async () => {
    const services = makeServices();

    const detail = await fetchContextSessionDetail(services, 'proj', 'session-1');

    expect(detail).not.toBeNull();
    expect(services.sessionParser.parseSession).toHaveBeenCalledWith('proj', 'session-1');
    expect(services.chunkBuilder.buildSessionDetail).toHaveBeenCalledOnce();

    // Second call must hit the cache — no re-parse.
    const again = await fetchContextSessionDetail(services, 'proj', 'session-1');
    expect(again).not.toBeNull();
    expect(services.sessionParser.parseSession).toHaveBeenCalledOnce();
  });

  it('returns null when the session does not exist', async () => {
    const services = makeServices({
      projectScanner: {
        getFileSystemProvider: () => ({ type: 'local' }),
        getSessionWithOptions: vi.fn().mockResolvedValue(null),
      } as unknown as ProjectScanner,
    });

    const detail = await fetchContextSessionDetail(services, 'proj', 'missing');

    expect(detail).toBeNull();
    expect(services.sessionParser.parseSession).not.toHaveBeenCalled();
  });
});

// =============================================================================
// fetchContextWaterfallData
// =============================================================================

describe('fetchContextWaterfallData', () => {
  const waterfall = {
    items: [{ id: 'item-1' }],
    minTime: '2024-01-01T00:00:00Z',
    maxTime: '2024-01-01T00:01:00Z',
    totalDurationMs: 60_000,
  } as unknown as Awaited<ReturnType<typeof fetchContextWaterfallData>>;

  function makeServices(overrides: Partial<SessionDetailServices> = {}): SessionDetailServices {
    const session = makeSession();
    const detail = {
      session,
      messages: [],
      chunks: [{ id: 'chunk-1' }],
      processes: [{ id: 'proc-1' }],
      metrics: {
        durationMs: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messageCount: 0,
      },
    } as unknown as SessionDetail;

    return {
      projectScanner: {
        getFileSystemProvider: () => ({ type: 'local' }),
        getSessionWithOptions: vi.fn().mockResolvedValue(session),
      } as unknown as ProjectScanner,
      sessionParser: {
        parseSession: vi.fn().mockResolvedValue({ taskCalls: [], messages: [] }),
      } as unknown as SessionParser,
      subagentResolver: {
        resolveSubagents: vi.fn().mockResolvedValue([]),
      } as unknown as SubagentResolver,
      chunkBuilder: {
        buildSessionDetail: vi.fn().mockReturnValue(detail),
        buildWaterfallData: vi.fn().mockReturnValue(waterfall),
      } as unknown as ChunkBuilder,
      dataCache: new DataCache(10, 60, true),
      ...overrides,
    };
  }

  it('builds waterfall data from the session detail chunks and processes', async () => {
    const services = makeServices();

    const result = await fetchContextWaterfallData(services, 'proj', 'session-1');

    expect(result).toBe(waterfall);
    expect(services.chunkBuilder.buildWaterfallData).toHaveBeenCalledWith(
      [{ id: 'chunk-1' }],
      [{ id: 'proc-1' }]
    );
  });

  it('returns null when the session detail cannot be built', async () => {
    const services = makeServices({
      projectScanner: {
        getFileSystemProvider: () => ({ type: 'local' }),
        getSessionWithOptions: vi.fn().mockResolvedValue(null),
      } as unknown as ProjectScanner,
    });

    const result = await fetchContextWaterfallData(services, 'proj', 'missing');

    expect(result).toBeNull();
    expect(services.chunkBuilder.buildWaterfallData).not.toHaveBeenCalled();
  });
});
