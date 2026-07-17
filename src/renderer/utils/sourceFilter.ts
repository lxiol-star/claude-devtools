/**
 * Client-side source-filter helpers for the aggregate ("All") view.
 *
 * The sidebar source chips are a pure view filter over the already-loaded
 * cross-backend aggregate data — no context switch, no refetch. These helpers
 * decide whether a project/worktree/repository-group card or a session should
 * be shown for the current filter.
 */

import type { SourceFilter } from '@renderer/store/slices/contextSlice';
import type { DataBackendName } from '@shared/types/api';

/**
 * Whether a project/worktree/repository-group matches the active source filter.
 *
 * A cross-backend-merged card exposes every origin via `sourceBackends`, so it
 * matches when the filtered backend is any of its sources. Falls back to the
 * singular `sourceBackend` tag, and matches everything under 'all' or when the
 * entity carries no source info (single-source / SSH views).
 */
export function projectMatchesSource(
  entity: { sourceBackends?: DataBackendName[]; sourceBackend?: DataBackendName },
  filter: SourceFilter
): boolean {
  if (filter === 'all') return true;
  if (entity.sourceBackends && entity.sourceBackends.length > 0) {
    return entity.sourceBackends.includes(filter);
  }
  if (entity.sourceBackend) {
    return entity.sourceBackend === filter;
  }
  // No source tags (single-source / SSH view): nothing to filter against.
  return true;
}

/**
 * Whether a session matches the active source filter. Sessions always carry a
 * single origin backend, so this is an exact match (or 'all', or untagged).
 */
export function sessionMatchesSource(
  session: { sourceBackend?: DataBackendName },
  filter: SourceFilter
): boolean {
  if (filter === 'all') return true;
  if (session.sourceBackend) {
    return session.sourceBackend === filter;
  }
  return true;
}

/**
 * Whether a session's annotation matches the active annotation filter.
 * A session passes when it carries ALL of the selected tags AND its score is
 * >= minScore. An empty tag list + minScore 0 means "no filter" → always true.
 * A session with no annotation only passes when no filter is active.
 */
export function sessionMatchesAnnotation(
  annotation: { tags?: string[]; score?: number | null } | undefined,
  filterTags: string[],
  minScore: number
): boolean {
  const hasFilter = filterTags.length > 0 || minScore > 0;
  if (!hasFilter) return true;
  if (!annotation) return false;

  if (minScore > 0 && (annotation.score ?? 0) < minScore) {
    return false;
  }
  if (filterTags.length > 0) {
    const tags = annotation.tags ?? [];
    return filterTags.every((t) => tags.includes(t));
  }
  return true;
}
