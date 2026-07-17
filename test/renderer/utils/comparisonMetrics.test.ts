import { describe, expect, it } from 'vitest';

import { summarizeToolCalls } from '../../../src/renderer/utils/comparisonMetrics';

import type { WaterfallItem } from '../../../src/shared/types/visualization';

let itemIdCounter = 0;

/** Minimal WaterfallItem factory for the aggregation tests. */
function toolItem(overrides: Partial<WaterfallItem> = {}): WaterfallItem {
  return {
    id: `item-${(itemIdCounter += 1)}`,
    label: 'item',
    startTime: new Date(0),
    endTime: new Date(0),
    durationMs: 0,
    tokenUsage: {},
    level: 0,
    type: 'tool',
    isParallel: false,
    ...overrides,
  } as WaterfallItem;
}

describe('summarizeToolCalls', () => {
  it('returns zeros for no items', () => {
    expect(summarizeToolCalls([])).toEqual({ total: 0, topTool: null, topToolCount: 0 });
  });

  it('ignores non-tool items', () => {
    const items = [
      toolItem({ type: 'chunk' }),
      toolItem({ type: 'subagent' }),
      toolItem({ metadata: { toolName: 'Bash' } }),
    ];
    const result = summarizeToolCalls(items);
    expect(result.total).toBe(1);
    expect(result.topTool).toBe('Bash');
    expect(result.topToolCount).toBe(1);
  });

  it('groups by toolName and finds the most frequent tool', () => {
    const items = [
      toolItem({ metadata: { toolName: 'Read' } }),
      toolItem({ metadata: { toolName: 'Read' } }),
      toolItem({ metadata: { toolName: 'Read' } }),
      toolItem({ metadata: { toolName: 'Bash' } }),
      toolItem({ metadata: { toolName: 'Bash' } }),
    ];
    const result = summarizeToolCalls(items);
    expect(result.total).toBe(5);
    expect(result.topTool).toBe('Read');
    expect(result.topToolCount).toBe(3);
  });

  it('falls back to the item label when toolName is absent', () => {
    const items = [toolItem({ label: 'custom-tool' })];
    const result = summarizeToolCalls(items);
    expect(result.total).toBe(1);
    expect(result.topTool).toBe('custom-tool');
  });
});
