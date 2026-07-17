import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@main/utils/pathDecoder', () => ({
  setClaudeBasePathOverride: vi.fn(),
}));

import { ConfigManager } from '../../../../src/main/services/infrastructure/ConfigManager';
import { buildAnnotationKey } from '../../../../src/shared/utils/annotationKey';

describe('buildAnnotationKey', () => {
  it('composes contextId:projectId:sessionId', () => {
    expect(buildAnnotationKey('ssh-1', 'proj', 'sess')).toBe('ssh-1:proj:sess');
  });

  it("falls back to 'local' when contextId is undefined", () => {
    expect(buildAnnotationKey(undefined, 'proj', 'sess')).toBe('local:proj:sess');
  });
});

describe('ConfigManager session annotations', () => {
  let tempDir: string;
  let configPath: string;
  let manager: ConfigManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-annot-'));
    configPath = path.join(tempDir, 'config.json');
    manager = new ConfigManager(configPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const key = buildAnnotationKey('local', 'proj', 'sess');

  it('starts with an empty annotations map', () => {
    expect(manager.getConfig().sessions.sessionAnnotations).toEqual({});
  });

  it('creates an annotation from a partial patch and stamps updatedAt', () => {
    manager.setSessionAnnotation(key, { score: 4 });

    const annotation = manager.getConfig().sessions.sessionAnnotations[key];
    expect(annotation).toBeDefined();
    expect(annotation.score).toBe(4);
    expect(annotation.tags).toEqual([]);
    expect(annotation.note).toBe('');
    expect(typeof annotation.updatedAt).toBe('number');
  });

  it('merges subsequent patches over the existing annotation', () => {
    manager.setSessionAnnotation(key, { score: 3 });
    manager.setSessionAnnotation(key, { tags: ['bug'] });
    manager.setSessionAnnotation(key, { note: 'follow up' });

    const annotation = manager.getConfig().sessions.sessionAnnotations[key];
    expect(annotation.score).toBe(3);
    expect(annotation.tags).toEqual(['bug']);
    expect(annotation.note).toBe('follow up');
  });

  it('deletes the key when the resulting annotation is empty', () => {
    manager.setSessionAnnotation(key, { score: 5, tags: ['x'], note: 'hi' });
    expect(manager.getConfig().sessions.sessionAnnotations[key]).toBeDefined();

    // Clear everything back out — should be treated as empty and removed.
    manager.setSessionAnnotation(key, { score: null, tags: [], note: '   ' });
    expect(manager.getConfig().sessions.sessionAnnotations[key]).toBeUndefined();
  });

  it('treats a whitespace-only note with no tags/score as empty', () => {
    manager.setSessionAnnotation(key, { note: '   ' });
    expect(manager.getConfig().sessions.sessionAnnotations[key]).toBeUndefined();
  });

  it('removeSessionAnnotation deletes an existing annotation', () => {
    manager.setSessionAnnotation(key, { score: 2 });
    expect(manager.getConfig().sessions.sessionAnnotations[key]).toBeDefined();

    manager.removeSessionAnnotation(key);
    expect(manager.getConfig().sessions.sessionAnnotations[key]).toBeUndefined();
  });

  it('removeSessionAnnotation is a no-op for a missing key', () => {
    expect(() => manager.removeSessionAnnotation('missing:key:here')).not.toThrow();
    expect(manager.getConfig().sessions.sessionAnnotations).toEqual({});
  });

  it('persists annotations to disk and reloads them via mergeWithDefaults', async () => {
    manager.setSessionAnnotation(key, { score: 4, tags: ['review'] });

    // A fresh manager pointed at the same file should load the persisted data.
    const reloaded = new ConfigManager(configPath);
    await reloaded.initialize();
    const annotation = reloaded.getConfig().sessions.sessionAnnotations[key];
    expect(annotation.score).toBe(4);
    expect(annotation.tags).toEqual(['review']);
  });

  it('backfills sessionAnnotations default for older configs without the field', async () => {
    // Simulate an old config file missing the new section.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ sessions: { pinnedSessions: {}, hiddenSessions: {} } })
    );

    const reloaded = new ConfigManager(configPath);
    await reloaded.initialize();
    expect(reloaded.getConfig().sessions.sessionAnnotations).toEqual({});
  });
});
