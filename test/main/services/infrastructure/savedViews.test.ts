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

describe('ConfigManager saved views', () => {
  let tempDir: string;
  let configPath: string;
  let manager: ConfigManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-views-'));
    configPath = path.join(tempDir, 'config.json');
    manager = new ConfigManager(configPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts with an empty saved views list', () => {
    expect(manager.getConfig().sessions.savedViews).toEqual([]);
  });

  it('addSavedView generates an id and createdAt and returns the created view', () => {
    const created = manager.addSavedView({
      name: 'Starred bugs',
      tags: ['bug'],
      minScore: 4,
      sourceFilter: 'claude',
    });

    expect(typeof created.id).toBe('string');
    expect(created.id.length).toBeGreaterThan(0);
    expect(typeof created.createdAt).toBe('number');
    expect(created.name).toBe('Starred bugs');
    expect(created.tags).toEqual(['bug']);
    expect(created.minScore).toBe(4);
    expect(created.sourceFilter).toBe('claude');

    const stored = manager.getConfig().sessions.savedViews;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(created);
  });

  it('generates a distinct id for each saved view', () => {
    const a = manager.addSavedView({ name: 'A', tags: [], minScore: 0, sourceFilter: 'all' });
    const b = manager.addSavedView({ name: 'B', tags: [], minScore: 0, sourceFilter: 'all' });
    expect(a.id).not.toBe(b.id);
    expect(manager.getConfig().sessions.savedViews).toHaveLength(2);
  });

  it('removeSavedView removes the matching view', () => {
    const a = manager.addSavedView({ name: 'A', tags: [], minScore: 0, sourceFilter: 'all' });
    const b = manager.addSavedView({ name: 'B', tags: [], minScore: 0, sourceFilter: 'kimi' });

    manager.removeSavedView(a.id);

    const stored = manager.getConfig().sessions.savedViews;
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(b.id);
  });

  it('removeSavedView is a no-op for a missing id', () => {
    manager.addSavedView({ name: 'A', tags: [], minScore: 0, sourceFilter: 'all' });
    expect(() => manager.removeSavedView('missing-id')).not.toThrow();
    expect(manager.getConfig().sessions.savedViews).toHaveLength(1);
  });

  it('persists saved views to disk and reloads them via mergeWithDefaults', async () => {
    const created = manager.addSavedView({
      name: 'Review queue',
      tags: ['review'],
      minScore: 3,
      sourceFilter: 'codex',
    });

    const reloaded = new ConfigManager(configPath);
    await reloaded.initialize();
    const stored = reloaded.getConfig().sessions.savedViews;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(created);
  });

  it('backfills savedViews default for older configs without the field', async () => {
    // Simulate an old config file missing the new field.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ sessions: { pinnedSessions: {}, hiddenSessions: {}, sessionAnnotations: {} } })
    );

    const reloaded = new ConfigManager(configPath);
    await reloaded.initialize();
    expect(reloaded.getConfig().sessions.savedViews).toEqual([]);
  });
});
