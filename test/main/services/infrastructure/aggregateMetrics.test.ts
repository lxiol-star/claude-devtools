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
  computeAggregateMetrics,
  type AggregateContext,
} from '@main/services/infrastructure/AggregateQueries';

import type { ProjectScanner } from '@main/services/discovery/ProjectScanner';
import type { Project, Session } from '@main/types';
import type { DataBackendName } from '@shared/types/api';

// =============================================================================
// Fixtures
// =============================================================================

/** Millis for a given UTC calendar date (midnight). */
function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-native',
    path: '/Users/dev/myproject',
    name: 'myproject',
    sessions: [],
    createdAt: 1000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-x',
    projectId: 'proj-native',
    projectPath: '/Users/dev/myproject',
    createdAt: dayMs('2026-01-01'),
    hasSubagents: false,
    messageCount: 3,
    contextConsumption: 100,
    ...overrides,
  };
}

/**
 * Builds a context whose scanner returns the given projects and, per project
 * id, the given sessions. Missing entries resolve to empty lists.
 */
function makeContext(
  id: string,
  backendName: DataBackendName | undefined,
  projects: Project[],
  sessionsByProject: Record<string, Session[]>
): AggregateContext {
  const sessionMap = new Map(Object.entries(sessionsByProject));
  const scanner: Partial<ProjectScanner> = {
    scan: vi.fn().mockResolvedValue(projects),
    listSessions: vi.fn((projectId: string) => Promise.resolve(sessionMap.get(projectId) ?? [])),
  };
  return { id, backendName, projectScanner: scanner as ProjectScanner };
}

// =============================================================================
// computeAggregateMetrics
// =============================================================================

describe('computeAggregateMetrics', () => {
  it('returns an all-zero payload when there are no contexts', async () => {
    const metrics = await computeAggregateMetrics([]);
    expect(metrics.totals).toEqual({ sessions: 0, messages: 0, tokens: 0, projects: 0 });
    expect(metrics.daily).toEqual([]);
    expect(metrics.byBackend).toEqual([]);
    expect(metrics.byProject).toEqual([]);
    expect(typeof metrics.generatedAt).toBe('number');
  });

  it('aggregates totals, message counts, and token volume from list data', async () => {
    const project = makeProject();
    const ctx = makeContext('local', 'claude', [project], {
      [project.id]: [
        makeSession({ id: 's1', messageCount: 3, contextConsumption: 100 }),
        makeSession({ id: 's2', messageCount: 5, contextConsumption: 250 }),
      ],
    });

    const metrics = await computeAggregateMetrics([ctx]);

    expect(metrics.totals.sessions).toBe(2);
    expect(metrics.totals.messages).toBe(8);
    expect(metrics.totals.tokens).toBe(350);
    expect(metrics.totals.projects).toBe(1);
  });

  it('treats missing messageCount/contextConsumption as zero', async () => {
    const project = makeProject();
    const ctx = makeContext('local', 'claude', [project], {
      [project.id]: [
        // messageCount is required by the type but contextConsumption is optional.
        makeSession({ id: 's1', messageCount: 0, contextConsumption: undefined }),
      ],
    });

    const metrics = await computeAggregateMetrics([ctx]);
    expect(metrics.totals.messages).toBe(0);
    expect(metrics.totals.tokens).toBe(0);
    expect(metrics.totals.sessions).toBe(1);
  });

  it('buckets sessions by UTC calendar date, sorted ascending', async () => {
    const project = makeProject();
    const ctx = makeContext('local', 'claude', [project], {
      [project.id]: [
        makeSession({ id: 'a', createdAt: dayMs('2026-01-03'), messageCount: 1, contextConsumption: 10 }),
        makeSession({ id: 'b', createdAt: dayMs('2026-01-01'), messageCount: 2, contextConsumption: 20 }),
        makeSession({ id: 'c', createdAt: dayMs('2026-01-01'), messageCount: 4, contextConsumption: 5 }),
      ],
    });

    const metrics = await computeAggregateMetrics([ctx]);

    expect(metrics.daily.map((d) => d.date)).toEqual(['2026-01-01', '2026-01-03']);
    expect(metrics.daily[0]).toEqual({
      date: '2026-01-01',
      sessions: 2,
      messages: 6,
      tokens: 25,
    });
    expect(metrics.daily[1]).toEqual({
      date: '2026-01-03',
      sessions: 1,
      messages: 1,
      tokens: 10,
    });
  });

  it('rolls up by backend across contexts, sorted by sessions desc', async () => {
    const claudeProject = makeProject({ id: 'c-proj', path: '/Users/dev/alpha', name: 'alpha' });
    const kimiProject = makeProject({ id: 'k-proj', path: '/Users/dev/beta', name: 'beta' });

    const claudeCtx = makeContext('local', 'claude', [claudeProject], {
      [claudeProject.id]: [
        makeSession({ id: 'c1', messageCount: 1, contextConsumption: 10 }),
        makeSession({ id: 'c2', messageCount: 1, contextConsumption: 10 }),
        makeSession({ id: 'c3', messageCount: 1, contextConsumption: 10 }),
      ],
    });
    const kimiCtx = makeContext('local-kimi', 'kimi', [kimiProject], {
      [kimiProject.id]: [makeSession({ id: 'k1', messageCount: 2, contextConsumption: 40 })],
    });

    const metrics = await computeAggregateMetrics([claudeCtx, kimiCtx]);

    expect(metrics.byBackend.map((b) => b.backend)).toEqual(['claude', 'kimi']);
    expect(metrics.byBackend[0]).toEqual({ backend: 'claude', sessions: 3, messages: 3, tokens: 30 });
    expect(metrics.byBackend[1]).toEqual({ backend: 'kimi', sessions: 1, messages: 2, tokens: 40 });
  });

  it('merges the same repo across backends into one project via canonical id', async () => {
    // Same path under two backends with different native ids must merge.
    const claudeProject = makeProject({ id: 'claude-native', path: '/Users/dev/shared', name: 'shared' });
    const kimiProject = makeProject({ id: 'kimi-native', path: '/Users/dev/shared', name: 'shared' });

    const claudeCtx = makeContext('local', 'claude', [claudeProject], {
      [claudeProject.id]: [makeSession({ id: 'c1', messageCount: 1, contextConsumption: 10 })],
    });
    const kimiCtx = makeContext('local-kimi', 'kimi', [kimiProject], {
      [kimiProject.id]: [makeSession({ id: 'k1', messageCount: 1, contextConsumption: 20 })],
    });

    const metrics = await computeAggregateMetrics([claudeCtx, kimiCtx]);

    expect(metrics.totals.projects).toBe(1);
    expect(metrics.byProject).toHaveLength(1);
    expect(metrics.byProject[0].sessions).toBe(2);
    expect(metrics.byProject[0].tokens).toBe(30);
    expect(metrics.byProject[0].path).toBe('/Users/dev/shared');
  });

  it('returns only the top 10 projects by sessions desc', async () => {
    // 12 projects; project N gets N sessions so ordering is deterministic.
    const projects: Project[] = [];
    const sessionsByProject: Record<string, Session[]> = {};
    for (let i = 1; i <= 12; i++) {
      const id = `proj-${i}`;
      const path = `/Users/dev/p${i}`;
      projects.push(makeProject({ id, path, name: `p${i}` }));
      Object.defineProperty(sessionsByProject, id, {
        value: Array.from({ length: i }, (_unused, j) =>
          makeSession({ id: `${id}-s${j}`, messageCount: 1, contextConsumption: 1 })
        ),
        enumerable: true,
      });
    }
    const ctx = makeContext('local', 'claude', projects, sessionsByProject);

    const metrics = await computeAggregateMetrics([ctx]);

    expect(metrics.byProject).toHaveLength(10);
    expect(metrics.byProject.map((p) => p.sessions)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    // totals.projects still counts every project, not just the top 10.
    expect(metrics.totals.projects).toBe(12);
  });

  it('skips a failing context without breaking the aggregate', async () => {
    const project = makeProject();
    const goodCtx = makeContext('local', 'claude', [project], {
      [project.id]: [makeSession({ id: 'g1', messageCount: 2, contextConsumption: 30 })],
    });
    const badScanner: Partial<ProjectScanner> = {
      scan: vi.fn().mockRejectedValue(new Error('boom')),
      listSessions: vi.fn().mockResolvedValue([]),
    };
    const badCtx: AggregateContext = {
      id: 'local-codex',
      backendName: 'codex',
      projectScanner: badScanner as ProjectScanner,
    };

    const metrics = await computeAggregateMetrics([goodCtx, badCtx]);

    expect(metrics.totals.sessions).toBe(1);
    expect(metrics.byBackend.map((b) => b.backend)).toEqual(['claude']);
  });

  it('skips a failing project within a context but keeps the others', async () => {
    const okProject = makeProject({ id: 'ok', path: '/Users/dev/ok', name: 'ok' });
    const badProject = makeProject({ id: 'bad', path: '/Users/dev/bad', name: 'bad' });
    const scanner: Partial<ProjectScanner> = {
      scan: vi.fn().mockResolvedValue([okProject, badProject]),
      listSessions: vi.fn((projectId: string) => {
        if (projectId === 'bad') {
          return Promise.reject(new Error('cannot list'));
        }
        return Promise.resolve([makeSession({ id: 'ok1', messageCount: 1, contextConsumption: 5 })]);
      }),
    };
    const ctx: AggregateContext = {
      id: 'local',
      backendName: 'claude',
      projectScanner: scanner as ProjectScanner,
    };

    const metrics = await computeAggregateMetrics([ctx]);

    expect(metrics.totals.sessions).toBe(1);
    expect(metrics.totals.projects).toBe(1);
    expect(metrics.byProject[0].name).toBe('ok');
  });

  it('returns empty annotation rollups when no annotations are passed', async () => {
    const project = makeProject();
    const ctx = makeContext('local', 'claude', [project], {
      [project.id]: [makeSession({ id: 's1' })],
    });

    const metrics = await computeAggregateMetrics([ctx]);

    expect(metrics.annotations.annotatedSessions).toBe(0);
    expect(metrics.annotations.scoredSessions).toBe(0);
    expect(metrics.annotations.avgScore).toBe(0);
    expect(metrics.annotations.scoreDistribution).toEqual([]);
    expect(metrics.annotations.byTag).toEqual([]);
  });

  it('joins local annotations onto aggregated sessions (score dist, tags, avg)', async () => {
    const project = makeProject({ id: 'proj-native', path: '/Users/dev/myproject' });
    const ctx = makeContext('local', 'claude', [project], {
      'proj-native': [
        makeSession({ id: 's1' }),
        makeSession({ id: 's2' }),
        makeSession({ id: 's3' }),
      ],
    });
    // Annotations are keyed by contextId:nativeProjectId:sessionId.
    const annotations = {
      'local:proj-native:s1': { tags: ['bug', 'urgent'], score: 5, note: '', updatedAt: 1 },
      'local:proj-native:s2': { tags: ['bug'], score: 3, note: 'x', updatedAt: 2 },
      'local:proj-native:s3': { tags: [], score: null, note: '', updatedAt: 3 },
    };

    const metrics = await computeAggregateMetrics([ctx], annotations);

    // s1 + s2 carry tags/score/note; s3 is empty → not counted as annotated.
    expect(metrics.annotations.annotatedSessions).toBe(2);
    expect(metrics.annotations.scoredSessions).toBe(2);
    expect(metrics.annotations.avgScore).toBeCloseTo(4);
    expect(metrics.annotations.scoreDistribution).toEqual([
      { score: 3, sessions: 1 },
      { score: 5, sessions: 1 },
    ]);
    // 'bug' on s1+s2, 'urgent' on s1 → sorted by sessions desc.
    expect(metrics.annotations.byTag).toEqual([
      { tag: 'bug', sessions: 2 },
      { tag: 'urgent', sessions: 1 },
    ]);
  });
});
