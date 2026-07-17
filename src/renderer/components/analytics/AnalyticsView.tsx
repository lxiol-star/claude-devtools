/**
 * AnalyticsView - Cross-session analytics dashboard.
 *
 * Aggregates metrics across ALL local sessions (Claude + Kimi + Codex) from
 * cheap session-list data only (session counts, message counts, and
 * contextConsumption as a token proxy). Cost and precise latency are
 * intentionally out of scope — the per-session timeline drill-down covers those.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { SOURCE_COLORS } from '@renderer/constants/sourceColors';
import { useT } from '@renderer/i18n';
import { buildAnalyticsCsv, downloadCsv } from '@renderer/utils/analyticsCsv';
import { createLogger } from '@shared/utils/logger';
import { formatTokensCompact } from '@shared/utils/tokenFormatting';
import { BarChart3, Download, RefreshCw } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { AggregateMetrics } from '@renderer/types/data';

const logger = createLogger('Component:AnalyticsView');

// Chart colors sourced from the dark-theme CSS variables so the charts stay
// consistent with the rest of the app across theme changes.
const AXIS_COLOR = 'var(--color-text-muted)';
const GRID_COLOR = 'var(--color-border-emphasis)';
const SERIES_COLOR = '#6366f1';

// =============================================================================
// KPI Cards
// =============================================================================

interface KpiCardProps {
  label: string;
  value: string;
}

const KpiCard = ({ label, value }: Readonly<KpiCardProps>): React.JSX.Element => (
  <div className="flex flex-col gap-1 rounded-sm border border-border bg-surface-raised p-4">
    <span className="text-xs font-medium uppercase tracking-wider text-text-muted">{label}</span>
    <span className="text-2xl font-semibold text-text">{value}</span>
  </div>
);

// =============================================================================
// Tooltip
// =============================================================================

interface ChartTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: { name?: string; value?: number; color?: string }[];
}

const ChartTooltip = ({ active, label, payload }: Readonly<ChartTooltipProps>): React.JSX.Element | null => {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  return (
    <div className="rounded-sm border border-border-emphasis bg-surface-overlay px-3 py-2 text-xs shadow-lg">
      {label !== undefined && <div className="mb-1 font-medium text-text">{label}</div>}
      {payload.map((entry, index) => (
        <div key={index} className="flex items-center gap-2 text-text-secondary">
          <span
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: entry.color ?? SERIES_COLOR }}
          />
          <span>{(entry.value ?? 0).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
};

// =============================================================================
// Analytics View
// =============================================================================

type DailySeries = 'sessions' | 'tokens';

export const AnalyticsView = (): React.JSX.Element => {
  const t = useT();
  const [metrics, setMetrics] = useState<AggregateMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [dailySeries, setDailySeries] = useState<DailySeries>('sessions');

  const loadMetrics = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await api.getAggregateMetrics();
      setMetrics(result);
    } catch (error) {
      logger.error('Failed to load aggregate metrics:', error);
      setMetrics(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  // Largest byProject session count for proportional bar widths.
  const maxProjectSessions = useMemo(
    () => Math.max(1, ...(metrics?.byProject.map((p) => p.sessions) ?? [0])),
    [metrics]
  );

  const isEmpty = !loading && (!metrics || metrics.totals.sessions === 0);

  return (
    <div className="relative flex-1 overflow-auto bg-surface">
      <div className="relative mx-auto max-w-5xl px-8 py-12">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="size-5 text-text-secondary" />
            <h1 className="text-lg font-semibold text-text">{t('analytics.title')}</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (metrics) {
                  downloadCsv(
                    `claude-devtools-analytics-${new Date().toISOString().slice(0, 10)}.csv`,
                    buildAnalyticsCsv(metrics)
                  );
                }
              }}
              disabled={loading || !metrics || metrics.totals.sessions === 0}
              className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-xs text-text-muted transition-colors hover:border-border-emphasis hover:text-text-secondary disabled:opacity-50"
              title={t('analytics.exportCsv')}
            >
              <Download className="size-3" />
              {t('analytics.exportCsv')}
            </button>
            <button
              onClick={() => void loadMetrics()}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-xs text-text-muted transition-colors hover:border-border-emphasis hover:text-text-secondary disabled:opacity-50"
              title={t('analytics.refresh')}
            >
              <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
              {t('analytics.refresh')}
            </button>
          </div>
        </div>

        {loading && (
          <p className="text-sm text-text-muted">{t('analytics.loading')}</p>
        )}

        {isEmpty && (
          <div className="flex flex-col items-center justify-center rounded-sm border border-dashed border-border px-8 py-16">
            <div className="mb-4 flex size-12 items-center justify-center rounded-sm border border-border bg-surface-raised">
              <BarChart3 className="size-6 text-text-muted" />
            </div>
            <p className="text-sm text-text-secondary">{t('analytics.empty')}</p>
          </div>
        )}

        {!loading && metrics && metrics.totals.sessions > 0 && (
          <div className="flex flex-col gap-8">
            {/* KPI cards */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard
                label={t('analytics.totalSessions')}
                value={metrics.totals.sessions.toLocaleString()}
              />
              <KpiCard
                label={t('analytics.totalMessages')}
                value={metrics.totals.messages.toLocaleString()}
              />
              <KpiCard
                label={t('analytics.totalTokens')}
                value={formatTokensCompact(metrics.totals.tokens)}
              />
              <KpiCard
                label={t('analytics.projects')}
                value={metrics.totals.projects.toLocaleString()}
              />
              {metrics.annotations.scoredSessions > 0 && (
                <KpiCard
                  label={t('analytics.avgScore')}
                  value={`${metrics.annotations.avgScore.toFixed(1)} ★ (${metrics.annotations.scoredSessions})`}
                />
              )}
            </div>

            {/* Daily trend chart (sessions or tokens over time) */}
            <section className="rounded-sm border border-border bg-surface-raised p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-xs font-medium uppercase tracking-wider text-text-muted">
                  {dailySeries === 'sessions'
                    ? t('analytics.sessionsOverTime')
                    : t('analytics.tokensOverTime')}
                </h2>
                <div className="flex items-center gap-1 rounded-sm border border-border p-0.5">
                  <button
                    onClick={() => setDailySeries('sessions')}
                    className={`rounded-sm px-2 py-0.5 text-[11px] transition-colors ${
                      dailySeries === 'sessions'
                        ? 'bg-surface-overlay text-text'
                        : 'text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    {t('analytics.showSessions')}
                  </button>
                  <button
                    onClick={() => setDailySeries('tokens')}
                    className={`rounded-sm px-2 py-0.5 text-[11px] transition-colors ${
                      dailySeries === 'tokens'
                        ? 'bg-surface-overlay text-text'
                        : 'text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    {t('analytics.showTokens')}
                  </button>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={metrics.daily} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="analyticsDailyFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SERIES_COLOR} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={SERIES_COLOR} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    stroke={AXIS_COLOR}
                    tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID_COLOR }}
                  />
                  <YAxis
                    stroke={AXIS_COLOR}
                    tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID_COLOR }}
                    width={48}
                    tickFormatter={(value: number) =>
                      dailySeries === 'tokens' ? formatTokensCompact(value) : value.toString()
                    }
                  />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: GRID_COLOR }} />
                  <Area
                    type="monotone"
                    dataKey={dailySeries}
                    stroke={SERIES_COLOR}
                    strokeWidth={2}
                    fill="url(#analyticsDailyFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </section>

            {/* By backend */}
            <section className="rounded-sm border border-border bg-surface-raised p-5">
              <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-text-muted">
                {t('analytics.byBackend')}
              </h2>
              <ResponsiveContainer width="100%" height={Math.max(120, metrics.byBackend.length * 48)}>
                <BarChart
                  data={metrics.byBackend}
                  layout="vertical"
                  margin={{ top: 0, right: 16, bottom: 0, left: 8 }}
                >
                  <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" horizontal={false} />
                  <XAxis
                    type="number"
                    stroke={AXIS_COLOR}
                    tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID_COLOR }}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="backend"
                    stroke={AXIS_COLOR}
                    tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID_COLOR }}
                    width={64}
                  />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--color-surface-overlay)' }} />
                  <Bar dataKey="sessions" radius={[0, 3, 3, 0]}>
                    {metrics.byBackend.map((stat) => (
                      <Cell key={stat.backend} fill={SOURCE_COLORS[stat.backend]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </section>

            {/* Top projects */}
            <section className="rounded-sm border border-border bg-surface-raised p-5">
              <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-text-muted">
                {t('analytics.topProjects')}
              </h2>
              <ul className="flex flex-col gap-3">
                {metrics.byProject.map((project) => (
                  <li key={project.projectId} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm text-text" title={project.path}>
                        {project.name}
                      </span>
                      <span className="shrink-0 text-xs text-text-muted">
                        {project.sessions.toLocaleString()} {t('analytics.sessions')} ·{' '}
                        {formatTokensCompact(project.tokens)} {t('analytics.tokens')}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-overlay">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.round((project.sessions / maxProjectSessions) * 100)}%`,
                          backgroundColor: SERIES_COLOR,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {/* Session quality (local annotations: scores + tags) */}
            {metrics.annotations.annotatedSessions > 0 && (
              <section className="rounded-sm border border-border bg-surface-raised p-5">
                <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-text-muted">
                  {t('analytics.quality')}
                </h2>

                {metrics.annotations.scoreDistribution.length > 0 && (
                  <div className="mb-5">
                    <div className="mb-2 text-[11px] text-text-muted">
                      {t('analytics.scoreDistribution')}
                    </div>
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart
                        data={metrics.annotations.scoreDistribution}
                        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                      >
                        <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" vertical={false} />
                        <XAxis
                          dataKey="score"
                          stroke={AXIS_COLOR}
                          tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                          tickLine={false}
                          axisLine={{ stroke: GRID_COLOR }}
                          tickFormatter={(value: number) => `${value}★`}
                        />
                        <YAxis
                          stroke={AXIS_COLOR}
                          tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                          tickLine={false}
                          axisLine={{ stroke: GRID_COLOR }}
                          width={32}
                          allowDecimals={false}
                        />
                        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--color-surface-overlay)' }} />
                        <Bar dataKey="sessions" radius={[3, 3, 0, 0]} fill="#f5c518" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {metrics.annotations.byTag.length > 0 && (
                  <div>
                    <div className="mb-2 text-[11px] text-text-muted">{t('analytics.byTag')}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {metrics.annotations.byTag.map((tag) => (
                        <span
                          key={tag.tag}
                          className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary"
                        >
                          {tag.tag}
                          <span className="text-text-muted">{tag.sessions}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

            <p className="text-[11px] text-text-muted">{t('analytics.tokensNote')}</p>
          </div>
        )}
      </div>
    </div>
  );
};
