/**
 * CSV export for the cross-session analytics dashboard.
 *
 * Serializes AggregateMetrics into a spreadsheet-friendly CSV and triggers a
 * local browser download (Blob + object URL). Purely local — no network — so it
 * respects the app's zero-outbound posture.
 */

import type { AggregateMetrics } from '@renderer/types/data';

/** Quotes a CSV field when it contains a comma, quote, or newline (RFC 4180). */
function csvCell(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Joins a row of cells into a CSV line. */
function csvRow(cells: (string | number)[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * Builds a multi-section CSV from aggregate metrics: totals, daily trend,
 * per-backend, per-project, and (when present) annotation rollups. Sections are
 * separated by blank lines with their own header rows so the file stays
 * readable in any spreadsheet tool.
 */
export function buildAnalyticsCsv(metrics: AggregateMetrics): string {
  const lines: string[] = [];

  lines.push('Totals');
  lines.push(csvRow(['metric', 'value']));
  lines.push(csvRow(['sessions', metrics.totals.sessions]));
  lines.push(csvRow(['messages', metrics.totals.messages]));
  lines.push(csvRow(['tokens', metrics.totals.tokens]));
  lines.push(csvRow(['projects', metrics.totals.projects]));
  lines.push('');

  lines.push('Daily');
  lines.push(csvRow(['date', 'sessions', 'messages', 'tokens']));
  for (const b of metrics.daily) {
    lines.push(csvRow([b.date, b.sessions, b.messages, b.tokens]));
  }
  lines.push('');

  lines.push('By backend');
  lines.push(csvRow(['backend', 'sessions', 'messages', 'tokens']));
  for (const b of metrics.byBackend) {
    lines.push(csvRow([b.backend, b.sessions, b.messages, b.tokens]));
  }
  lines.push('');

  lines.push('By project');
  lines.push(csvRow(['name', 'path', 'sessions', 'messages', 'tokens']));
  for (const p of metrics.byProject) {
    lines.push(csvRow([p.name, p.path, p.sessions, p.messages, p.tokens]));
  }

  const { scoreDistribution, byTag } = metrics.annotations;
  if (scoreDistribution.length > 0 || byTag.length > 0) {
    lines.push('');
    lines.push('Ratings');
    lines.push(csvRow(['score', 'sessions']));
    for (const s of scoreDistribution) {
      lines.push(csvRow([s.score, s.sessions]));
    }
    lines.push('');
    lines.push('Tags');
    lines.push(csvRow(['tag', 'sessions']));
    for (const tg of byTag) {
      lines.push(csvRow([tg.tag, tg.sessions]));
    }
  }

  return lines.join('\n');
}

/** Triggers a local CSV file download for the given content. */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
