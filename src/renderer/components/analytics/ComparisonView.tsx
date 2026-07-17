/**
 * ComparisonView - Side-by-side metrics comparison for 2-3 sessions.
 *
 * The "same task across Claude vs Kimi vs Codex" use case: each selected session
 * becomes a column, each metric a row. Data is pulled from the per-context
 * session detail (metrics) and waterfall (tool-call counts) — no new backend
 * parsing. A session whose fetch fails still renders its column with placeholders
 * instead of crashing the view.
 */

import React, { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { SOURCE_COLORS } from '@renderer/constants/sourceColors';
import { useT } from '@renderer/i18n';
import { summarizeToolCalls, type ToolCallSummary } from '@renderer/utils/comparisonMetrics';
import { formatDuration, formatTokensCompact } from '@renderer/utils/formatters';
import { createLogger } from '@shared/utils/logger';
import { Columns3 } from 'lucide-react';

import type { ComparisonSession } from '@renderer/types/tabs';
import type { SessionMetrics } from '@shared/types';

const logger = createLogger('Component:ComparisonView');

// Text colors for the best/worst highlight — muted green/red, theme-neutral.
const BEST_COLOR = '#4ade80';
const WORST_COLOR = '#f87171';

interface ColumnData {
  /** Stable identity key (contextId + sessionId) */
  key: string;
  label: string;
  sourceBackend?: ComparisonSession['sourceBackend'];
  /** Whether both fetches succeeded and produced metrics */
  ok: boolean;
  metrics: SessionMetrics | null;
  toolCalls: ToolCallSummary | null;
}

interface ComparisonViewProps {
  sessions: ComparisonSession[];
}

/** Builds the stable identity key for a compared session. */
function columnKey(s: ComparisonSession): string {
  return `${s.contextId ?? ''}:${s.projectId}:${s.sessionId}`;
}

/**
 * A single comparison row: metric name plus one value per column. `getValue`
 * returns the raw number used for best/worst highlighting (null = N/A), while
 * `format` produces the displayed string. `compare === 'lowGood'` tints the
 * lowest value green and the highest red; `undefined` leaves the row neutral.
 */
interface RowDef {
  labelKey: string;
  getValue: (col: ColumnData) => number | null;
  format: (col: ColumnData) => string;
  compare?: 'lowGood';
}

const PLACEHOLDER = '—';

export const ComparisonView = ({ sessions }: ComparisonViewProps): React.JSX.Element => {
  const t = useT();
  const [columns, setColumns] = useState<ColumnData[]>([]);
  const [loading, setLoading] = useState(true);

  // Recompute only when the compared identities change, not on array identity.
  const identityKey = useMemo(() => sessions.map(columnKey).join('|'), [sessions]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const loadColumn = async (s: ComparisonSession): Promise<ColumnData> => {
      const base: ColumnData = {
        key: columnKey(s),
        label: s.label,
        sourceBackend: s.sourceBackend,
        ok: false,
        metrics: null,
        toolCalls: null,
      };
      try {
        // contextId identifies the origin backend in aggregate ("All") mode —
        // route both fetches to that context instead of the active one.
        const [detail, waterfall] = await Promise.all([
          s.contextId
            ? api.getSessionDetailByContext({
                contextId: s.contextId,
                sessionId: s.sessionId,
                projectId: s.projectId,
              })
            : api.getSessionDetail(s.projectId, s.sessionId),
          s.contextId
            ? api.getWaterfallDataByContext({
                contextId: s.contextId,
                sessionId: s.sessionId,
                projectId: s.projectId,
              })
            : api.getWaterfallData(s.projectId, s.sessionId),
        ]);

        // No knownFingerprint is passed, so detail is SessionDetail | null at
        // runtime. Narrow defensively against the "unchanged" sentinel.
        const metrics = detail && !('unchanged' in detail) ? detail.metrics : null;
        const toolCalls = waterfall ? summarizeToolCalls(waterfall.items) : null;
        return { ...base, ok: metrics != null, metrics, toolCalls };
      } catch (error) {
        logger.error('Failed to load comparison column:', error);
        return base;
      }
    };

    void Promise.all(sessions.map(loadColumn)).then((result) => {
      if (!cancelled) {
        setColumns(result);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identityKey captures the meaningful change; `sessions` is the data source read inside
  }, [identityKey]);

  const rows: RowDef[] = useMemo(
    () => [
      {
        labelKey: 'comparison.messages',
        getValue: (c) => c.metrics?.messageCount ?? null,
        format: (c) => c.metrics?.messageCount.toLocaleString() ?? PLACEHOLDER,
      },
      {
        labelKey: 'comparison.duration',
        getValue: (c) => c.metrics?.durationMs ?? null,
        format: (c) => (c.metrics ? formatDuration(c.metrics.durationMs) : PLACEHOLDER),
        compare: 'lowGood',
      },
      {
        labelKey: 'comparison.totalTokens',
        getValue: (c) => c.metrics?.totalTokens ?? null,
        format: (c) => (c.metrics ? formatTokensCompact(c.metrics.totalTokens) : PLACEHOLDER),
        compare: 'lowGood',
      },
      {
        labelKey: 'comparison.inputTokens',
        getValue: (c) => c.metrics?.inputTokens ?? null,
        format: (c) => (c.metrics ? formatTokensCompact(c.metrics.inputTokens) : PLACEHOLDER),
        compare: 'lowGood',
      },
      {
        labelKey: 'comparison.outputTokens',
        getValue: (c) => c.metrics?.outputTokens ?? null,
        format: (c) => (c.metrics ? formatTokensCompact(c.metrics.outputTokens) : PLACEHOLDER),
        compare: 'lowGood',
      },
      {
        labelKey: 'comparison.cost',
        getValue: (c) => c.metrics?.costUsd ?? null,
        format: (c) =>
          c.metrics?.costUsd != null ? `$${c.metrics.costUsd.toFixed(4)}` : PLACEHOLDER,
        compare: 'lowGood',
      },
      {
        labelKey: 'comparison.toolCalls',
        getValue: (c) => c.toolCalls?.total ?? null,
        format: (c) => c.toolCalls?.total.toLocaleString() ?? PLACEHOLDER,
      },
      {
        labelKey: 'comparison.topTool',
        getValue: () => null,
        format: (c) =>
          c.toolCalls?.topTool
            ? `${c.toolCalls.topTool} (${c.toolCalls.topToolCount})`
            : PLACEHOLDER,
      },
    ],
    []
  );

  const isEmpty = !loading && columns.length === 0;

  return (
    <div className="relative flex-1 overflow-auto bg-surface">
      <div className="relative mx-auto max-w-4xl px-8 py-12">
        {/* Title */}
        <div className="mb-8 flex items-center gap-2">
          <Columns3 className="size-5 text-text-secondary" />
          <h1 className="text-lg font-semibold text-text">{t('comparison.title')}</h1>
        </div>

        {loading && <p className="text-sm text-text-muted">{t('comparison.loading')}</p>}

        {isEmpty && (
          <div className="flex flex-col items-center justify-center rounded-sm border border-dashed border-border px-8 py-16">
            <div className="mb-4 flex size-12 items-center justify-center rounded-sm border border-border bg-surface-raised">
              <Columns3 className="size-6 text-text-muted" />
            </div>
            <p className="text-sm text-text-secondary">{t('comparison.empty')}</p>
          </div>
        )}

        {!loading && columns.length > 0 && (
          <div className="overflow-x-auto rounded-sm border border-border bg-surface-raised">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-text-muted">
                    {t('comparison.metric')}
                  </th>
                  {columns.map((col) => (
                    <th key={col.key} className="px-4 py-3 text-right align-bottom">
                      <div className="flex flex-col items-end gap-1">
                        {col.sourceBackend && (
                          <span className="flex items-center gap-1 text-[11px] text-text-muted">
                            <span
                              className="size-1.5 rounded-full"
                              style={{ backgroundColor: SOURCE_COLORS[col.sourceBackend] }}
                            />
                            {t(`layout.sourceShort.${col.sourceBackend}`)}
                          </span>
                        )}
                        <span
                          className="max-w-56 truncate text-xs font-medium text-text"
                          title={col.label}
                        >
                          {col.label}
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  // Compute best/worst among the valid numeric values on this row.
                  const values = columns
                    .map((c) => row.getValue(c))
                    .filter((v): v is number => v != null);
                  const canHighlight = row.compare === 'lowGood' && values.length >= 2;
                  const min = canHighlight ? Math.min(...values) : null;
                  const max = canHighlight ? Math.max(...values) : null;
                  const distinct = canHighlight && min !== max;

                  return (
                    <tr key={row.labelKey} className="border-t border-border">
                      <td className="px-4 py-2.5 text-xs text-text-secondary">
                        {t(row.labelKey)}
                      </td>
                      {columns.map((col) => {
                        const raw = row.getValue(col);
                        let color: string | undefined;
                        if (distinct && raw != null) {
                          if (raw === min) color = BEST_COLOR;
                          else if (raw === max) color = WORST_COLOR;
                        }
                        return (
                          <td
                            key={col.key}
                            className="px-4 py-2.5 text-right tabular-nums text-text"
                            style={color ? { color } : undefined}
                          >
                            {row.format(col)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
