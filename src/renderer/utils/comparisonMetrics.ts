/**
 * Metric helpers for the side-by-side session comparison view.
 *
 * Kept separate from the component so the pure aggregation logic can be
 * unit-tested without rendering.
 */

import type { WaterfallItem } from '@shared/types/visualization';

/** Aggregated tool-call stats derived from waterfall items. */
export interface ToolCallSummary {
  /** Total number of tool-call items */
  total: number;
  /** Name of the most-invoked tool, or null when there are no tool calls */
  topTool: string | null;
  /** Invocation count of the top tool */
  topToolCount: number;
}

/**
 * Counts tool-call items and finds the most frequently used tool. Groups by
 * `metadata.toolName`, falling back to the item label — mirroring the
 * aggregation used by SessionTimeline's tool drill-down.
 */
export function summarizeToolCalls(items: readonly WaterfallItem[]): ToolCallSummary {
  const counts = new Map<string, number>();
  let total = 0;

  for (const item of items) {
    if (item.type !== 'tool') continue;
    total += 1;
    const key = item.metadata?.toolName ?? item.label;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let topTool: string | null = null;
  let topToolCount = 0;
  for (const [name, count] of counts) {
    if (count > topToolCount) {
      topTool = name;
      topToolCount = count;
    }
  }

  return { total, topTool, topToolCount };
}
