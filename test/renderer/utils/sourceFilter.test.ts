import { describe, expect, it } from 'vitest';

import {
  projectMatchesSource,
  sessionMatchesAnnotation,
  sessionMatchesSource,
} from '../../../src/renderer/utils/sourceFilter';

describe('projectMatchesSource', () => {
  it("matches everything under the 'all' filter", () => {
    expect(projectMatchesSource({ sourceBackends: ['kimi'] }, 'all')).toBe(true);
    expect(projectMatchesSource({}, 'all')).toBe(true);
  });

  it('matches a merged card when the filter is any of its sources', () => {
    const merged = { sourceBackends: ['claude', 'kimi'] as const };
    expect(projectMatchesSource(merged, 'claude')).toBe(true);
    expect(projectMatchesSource(merged, 'kimi')).toBe(true);
    expect(projectMatchesSource(merged, 'codex')).toBe(false);
  });

  it('falls back to the singular sourceBackend tag', () => {
    expect(projectMatchesSource({ sourceBackend: 'codex' }, 'codex')).toBe(true);
    expect(projectMatchesSource({ sourceBackend: 'codex' }, 'kimi')).toBe(false);
  });

  it('prefers sourceBackends over the singular tag when both exist', () => {
    const entity = { sourceBackends: ['claude', 'kimi'] as const, sourceBackend: undefined };
    expect(projectMatchesSource(entity, 'kimi')).toBe(true);
  });

  it('matches when the entity carries no source info (single-source / SSH view)', () => {
    expect(projectMatchesSource({}, 'claude')).toBe(true);
    expect(projectMatchesSource({ sourceBackends: [] }, 'claude')).toBe(true);
  });
});

describe('sessionMatchesSource', () => {
  it("matches everything under the 'all' filter", () => {
    expect(sessionMatchesSource({ sourceBackend: 'kimi' }, 'all')).toBe(true);
  });

  it('matches on an exact backend', () => {
    expect(sessionMatchesSource({ sourceBackend: 'claude' }, 'claude')).toBe(true);
    expect(sessionMatchesSource({ sourceBackend: 'claude' }, 'kimi')).toBe(false);
  });

  it('matches an untagged session (single-source view)', () => {
    expect(sessionMatchesSource({}, 'claude')).toBe(true);
  });
});

describe('sessionMatchesAnnotation', () => {
  it('matches everything when no filter is active', () => {
    expect(sessionMatchesAnnotation(undefined, [], 0)).toBe(true);
    expect(sessionMatchesAnnotation({ tags: ['x'], score: 3 }, [], 0)).toBe(true);
  });

  it('excludes sessions without an annotation once a filter is active', () => {
    expect(sessionMatchesAnnotation(undefined, ['bug'], 0)).toBe(false);
    expect(sessionMatchesAnnotation(undefined, [], 3)).toBe(false);
  });

  it('requires ALL selected tags to be present', () => {
    const ann = { tags: ['bug', 'urgent'], score: null };
    expect(sessionMatchesAnnotation(ann, ['bug'], 0)).toBe(true);
    expect(sessionMatchesAnnotation(ann, ['bug', 'urgent'], 0)).toBe(true);
    expect(sessionMatchesAnnotation(ann, ['bug', 'missing'], 0)).toBe(false);
  });

  it('requires score >= minScore', () => {
    expect(sessionMatchesAnnotation({ tags: [], score: 4 }, [], 3)).toBe(true);
    expect(sessionMatchesAnnotation({ tags: [], score: 2 }, [], 3)).toBe(false);
    expect(sessionMatchesAnnotation({ tags: [], score: null }, [], 3)).toBe(false);
  });

  it('combines tag and score filters (both must pass)', () => {
    const ann = { tags: ['bug'], score: 4 };
    expect(sessionMatchesAnnotation(ann, ['bug'], 3)).toBe(true);
    expect(sessionMatchesAnnotation(ann, ['bug'], 5)).toBe(false);
    expect(sessionMatchesAnnotation(ann, ['other'], 3)).toBe(false);
  });
});
