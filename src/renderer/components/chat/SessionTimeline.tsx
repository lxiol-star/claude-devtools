/**
 * SessionTimeline - Per-session execution timeline (Gantt) visualization.
 *
 * Renders one row per WaterfallItem in the order provided by the backend. Each
 * row has a left label column (indented by hierarchy level, with a type dot and
 * a parallel marker) and a right track that positions an absolutely-positioned
 * bar by numeric epoch time. Bars are drawn with plain divs - no charting lib.
 *
 * NOTE: WaterfallData.minTime/maxTime and WaterfallItem.startTime/endTime arrive
 * over IPC/HTTP as ISO strings, NOT Date objects. All time math coerces via
 * `new Date(x).getTime()` and works on numeric epoch ms.
 */

import React, { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import {
  COLOR_BORDER,
  COLOR_BORDER_SUBTLE,
  COLOR_SURFACE,
  COLOR_TEXT,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SECONDARY,
} from '@renderer/constants/cssVariables';
import { useT } from '@renderer/i18n';
import { formatDuration, formatTokensCompact } from '@renderer/utils/formatters';
import { GanttChartSquare, X } from 'lucide-react';

import type { WaterfallData, WaterfallItem } from '@shared/types/visualization';

interface SessionTimelineProps {
  projectId: string;
  sessionId: string;
  contextId?: string;
  onClose: () => void;
  /** Navigate the conversation to the clicked timeline item (scroll + highlight). */
  onNavigateToItem?: (waterfallItemId: string, itemType: WaterfallItem['type']) => void;
}

/** Left label column width in pixels. */
const LABEL_COLUMN_WIDTH_PX = 200;
/** Indentation applied per hierarchy level, in pixels. */
const INDENT_PER_LEVEL_PX = 12;
/** Minimum bar width as a percentage so tiny durations stay visible. */
const MIN_BAR_WIDTH_PERCENT = 0.5;

/** Bar/dot colors per item type (theme-consistent, distinct hues). */
const TYPE_COLORS: Record<WaterfallItem['type'], string> = {
  chunk: '#6366f1', // indigo - matches context accent
  subagent: '#22c55e', // green
  tool: '#f59e0b', // amber
};

/** Coerce an ISO string or Date into numeric epoch ms. */
function toMs(value: Date | string): number {
  return new Date(value).getTime();
}

/** Aggregated per-group stats for the drill-down summary. */
interface GroupStat {
  key: string;
  count: number;
  totalDurationMs: number;
  totalTokens: number;
}

/** Sums input+output tokens for a waterfall item (cache tokens excluded). */
function itemTokens(item: WaterfallItem): number {
  const usage = item.tokenUsage;
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

/**
 * Groups items by a key selector and sums count/duration/tokens, sorted by
 * total duration descending. Powers the cost/latency drill-down summary.
 */
function aggregateBy(
  items: WaterfallItem[],
  keyOf: (item: WaterfallItem) => string
): GroupStat[] {
  const map = new Map<string, GroupStat>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = map.get(key) ?? { key, count: 0, totalDurationMs: 0, totalTokens: 0 };
    existing.count += 1;
    existing.totalDurationMs += item.durationMs;
    existing.totalTokens += itemTokens(item);
    map.set(key, existing);
  }
  return [...map.values()].sort((a, b) => b.totalDurationMs - a.totalDurationMs);
}

/** Builds a hover tooltip string with label, duration, and token usage. */
function buildTooltip(item: WaterfallItem): string {
  const lines = [item.label, formatDuration(item.durationMs)];
  const usage = item.tokenUsage;
  if (usage) {
    const parts: string[] = [];
    if (usage.input_tokens) parts.push(`in ${usage.input_tokens}`);
    if (usage.output_tokens) parts.push(`out ${usage.output_tokens}`);
    if (parts.length > 0) lines.push(parts.join(' · '));
  }
  return lines.join('\n');
}

/**
 * Compact stat table for the drill-down: label · count · duration · tokens,
 * one row per group, already sorted by duration desc by the caller.
 */
const StatTable = ({
  heading,
  rows,
  labelOf,
  colorOf,
}: Readonly<{
  heading: string;
  rows: GroupStat[];
  labelOf?: (key: string) => string;
  colorOf?: (key: string) => string;
}>): React.ReactElement => {
  const t = useT();
  return (
    <div>
      <div className="mb-0.5 text-[10px]" style={{ color: COLOR_TEXT_MUTED }}>
        {heading}
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2 text-[11px]">
            {colorOf && (
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: colorOf(row.key) }}
              />
            )}
            <span className="flex-1 truncate" style={{ color: COLOR_TEXT_SECONDARY }}>
              {labelOf ? labelOf(row.key) : row.key}
            </span>
            <span className="shrink-0 tabular-nums" style={{ color: COLOR_TEXT_MUTED }}>
              ×{row.count}
            </span>
            <span
              className="w-14 shrink-0 text-right tabular-nums"
              style={{ color: COLOR_TEXT_SECONDARY }}
            >
              {formatDuration(row.totalDurationMs)}
            </span>
            <span
              className="w-14 shrink-0 text-right tabular-nums"
              style={{ color: COLOR_TEXT_MUTED }}
              title={t('chat.timelineTokens')}
            >
              {formatTokensCompact(row.totalTokens)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * Timeline panel showing the execution waterfall for a single session.
 */
export const SessionTimeline = ({
  projectId,
  sessionId,
  contextId,
  onClose,
  onNavigateToItem,
}: Readonly<SessionTimelineProps>): React.ReactElement => {
  const t = useT();
  const [data, setData] = useState<WaterfallData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      setLoading(true);
      try {
        // contextId identifies the origin backend in aggregate ("All") mode —
        // route the waterfall to that context instead of the active one so a
        // Kimi/Codex session's timeline resolves while Claude is active.
        const result = contextId
          ? await api.getWaterfallDataByContext({ contextId, sessionId, projectId })
          : await api.getWaterfallData(projectId, sessionId);
        if (!cancelled) setData(result);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, contextId]);

  const [showBreakdown, setShowBreakdown] = useState(true);

  const minMs = data ? toMs(data.minTime) : 0;
  const totalMs = data?.totalDurationMs ?? 0;
  const hasSpan = totalMs > 0;

  const items = useMemo(() => data?.items ?? [], [data]);
  // Latency/token drill-down: by item type, and by tool name (tool items only).
  const byType = useMemo(() => aggregateBy(items, (i) => i.type), [items]);
  const byTool = useMemo(
    () =>
      aggregateBy(
        items.filter((i) => i.type === 'tool'),
        (i) => i.metadata?.toolName ?? i.label
      ).slice(0, 8),
    [items]
  );

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ backgroundColor: COLOR_SURFACE, borderLeft: `1px solid ${COLOR_BORDER}` }}
    >
      {/* Header */}
      <div
        className="flex shrink-0 items-center justify-between px-4 py-3"
        style={{ borderBottom: `1px solid ${COLOR_BORDER}` }}
      >
        <div className="flex items-center gap-2">
          <GanttChartSquare size={16} style={{ color: COLOR_TEXT_SECONDARY }} />
          <h2 className="text-sm font-semibold" style={{ color: COLOR_TEXT }}>
            {t('chat.timelineTitle')}
          </h2>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 transition-colors hover:bg-white/10"
          style={{ color: COLOR_TEXT_SECONDARY }}
          aria-label={t('chat.contextPanel.closePanel')}
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-4 py-6 text-xs" style={{ color: COLOR_TEXT_MUTED }}>
            {t('chat.timelineLoading')}
          </p>
        ) : !data || data.items.length === 0 ? (
          <p className="px-4 py-6 text-xs" style={{ color: COLOR_TEXT_MUTED }}>
            {t('chat.timelineEmpty')}
          </p>
        ) : (
          <div className="py-2">
            {/* Latency / token drill-down summary */}
            <div className="mb-2 px-3">
              <button
                onClick={() => setShowBreakdown((v) => !v)}
                className="mb-1 flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-wide transition-opacity hover:opacity-80"
                style={{ color: COLOR_TEXT_MUTED }}
              >
                <span>{t('chat.timelineBreakdown')}</span>
                <span>{showBreakdown ? '−' : '+'}</span>
              </button>
              {showBreakdown && (
                <div className="flex flex-col gap-2">
                  <StatTable
                    heading={t('chat.timelineByType')}
                    rows={byType}
                    labelOf={(k) => t(`chat.timelineType.${k}`)}
                    colorOf={(k) => TYPE_COLORS[k as WaterfallItem['type']] ?? COLOR_TEXT_MUTED}
                  />
                  {byTool.length > 0 && (
                    <StatTable heading={t('chat.timelineByTool')} rows={byTool} />
                  )}
                </div>
              )}
            </div>

            {data.items.map((item) => {
              const startMs = toMs(item.startTime);
              const left = hasSpan ? ((startMs - minMs) / totalMs) * 100 : 0;
              const width = hasSpan
                ? Math.max((item.durationMs / totalMs) * 100, MIN_BAR_WIDTH_PERCENT)
                : 0;
              const color = TYPE_COLORS[item.type];

              const clickable = Boolean(onNavigateToItem);
              return (
                // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- row has role=button, tabIndex, click + keydown handlers
                <div
                  key={item.id}
                  className={`group flex items-center gap-2 px-3 py-1 ${
                    clickable ? 'cursor-pointer hover:bg-white/5' : ''
                  }`}
                  title={clickable ? t('chat.timelineJumpHint') : buildTooltip(item)}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => onNavigateToItem?.(item.id, item.type) : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onNavigateToItem?.(item.id, item.type);
                          }
                        }
                      : undefined
                  }
                >
                  {/* Label column */}
                  <div
                    className="flex shrink-0 items-center gap-1.5 overflow-hidden"
                    style={{
                      width: LABEL_COLUMN_WIDTH_PX,
                      paddingLeft: item.level * INDENT_PER_LEVEL_PX,
                    }}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    {item.isParallel && (
                      <span
                        className="shrink-0 text-[10px] font-semibold"
                        style={{ color: COLOR_TEXT_MUTED }}
                        aria-label="parallel"
                      >
                        ∥
                      </span>
                    )}
                    <span
                      className="truncate text-xs"
                      style={{ color: COLOR_TEXT_SECONDARY }}
                    >
                      {item.label}
                    </span>
                  </div>

                  {/* Track */}
                  <div
                    className="relative h-4 flex-1 rounded"
                    style={{ backgroundColor: COLOR_BORDER_SUBTLE }}
                  >
                    <div
                      className="absolute inset-y-0 rounded"
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        backgroundColor: color,
                      }}
                    />
                  </div>

                  {/* Jump affordance — appears on hover to signal the row opens
                      the corresponding step in the conversation. */}
                  {clickable && (
                    <span
                      className="shrink-0 text-xs opacity-0 transition-opacity group-hover:opacity-100"
                      style={{ color: COLOR_TEXT_MUTED }}
                      aria-hidden="true"
                    >
                      ↦
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

