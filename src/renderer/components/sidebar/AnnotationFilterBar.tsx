/**
 * AnnotationFilterBar - client-side sidebar filter by session annotations.
 *
 * Renders a collapsible control: a star threshold (min score) and toggle chips
 * for every tag currently in use across annotated sessions. Selecting tags/score
 * filters the visible session list (see DateGroupedSessions). Pure view filter —
 * no refetch, no context switch.
 */

import { useMemo, useState } from 'react';

import { useT } from '@renderer/i18n';
import { useStore } from '@renderer/store';
import { Bookmark, Star, Tag, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

export const AnnotationFilterBar = (): React.JSX.Element | null => {
  const t = useT();
  const {
    sessionAnnotations,
    annotationFilterTags,
    annotationMinScore,
    toggleAnnotationFilterTag,
    setAnnotationMinScore,
    clearAnnotationFilter,
    savedViews,
    saveCurrentView,
    deleteSavedView,
    applySavedView,
  } = useStore(
    useShallow((s) => ({
      sessionAnnotations: s.sessionAnnotations,
      annotationFilterTags: s.annotationFilterTags,
      annotationMinScore: s.annotationMinScore,
      toggleAnnotationFilterTag: s.toggleAnnotationFilterTag,
      setAnnotationMinScore: s.setAnnotationMinScore,
      clearAnnotationFilter: s.clearAnnotationFilter,
      savedViews: s.savedViews,
      saveCurrentView: s.saveCurrentView,
      deleteSavedView: s.deleteSavedView,
      applySavedView: s.applySavedView,
    }))
  );
  const [expanded, setExpanded] = useState(false);

  // All tags currently in use across annotated sessions, sorted.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const annotation of Object.values(sessionAnnotations)) {
      for (const tag of annotation.tags ?? []) {
        set.add(tag);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [sessionAnnotations]);

  const hasScores = useMemo(
    () => Object.values(sessionAnnotations).some((a) => (a.score ?? 0) > 0),
    [sessionAnnotations]
  );

  // Nothing to filter by yet and no saved views — hide entirely.
  if (allTags.length === 0 && !hasScores && savedViews.length === 0) {
    return null;
  }

  const isActive = annotationFilterTags.length > 0 || annotationMinScore > 0;

  const handleSaveCurrentView = (): void => {
    const name = window.prompt(t('annotations.saveViewPrompt'));
    if (name && name.trim().length > 0) {
      void saveCurrentView(name.trim());
    }
  };

  return (
    <div
      className="flex w-full flex-col gap-1 px-3 pb-1.5"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-1">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-opacity hover:opacity-80"
          style={{
            backgroundColor: isActive ? 'var(--color-accent-soft, #6366f122)' : 'transparent',
            borderColor: isActive ? 'var(--color-border-emphasis)' : 'var(--color-border)',
            color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
          }}
          title={t('annotations.filterTitle')}
        >
          <Tag className="size-3" />
          {t('annotations.filterLabel')}
          {isActive && (
            <span className="ml-0.5 rounded-full bg-[var(--color-border-emphasis)] px-1 text-[10px] text-[var(--color-text)]">
              {annotationFilterTags.length + (annotationMinScore > 0 ? 1 : 0)}
            </span>
          )}
        </button>
        {isActive && (
          <button
            onClick={clearAnnotationFilter}
            className="flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-opacity hover:opacity-80"
            title={t('annotations.filterClear')}
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-1.5 pt-1">
          {/* Min score selector */}
          {hasScores && (
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((score) => {
                const active = annotationMinScore >= score;
                return (
                  <button
                    key={score}
                    onClick={() =>
                      setAnnotationMinScore(annotationMinScore === score ? 0 : score)
                    }
                    title={t('annotations.filterMinScore', { score })}
                    className="transition-opacity hover:opacity-80"
                  >
                    <Star
                      className="size-3.5"
                      style={{
                        fill: active ? '#f5c518' : 'none',
                        color: active ? '#f5c518' : 'var(--color-text-muted)',
                      }}
                    />
                  </button>
                );
              })}
            </div>
          )}

          {/* Tag toggle chips */}
          {allTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {allTags.map((tag) => {
                const active = annotationFilterTags.includes(tag);
                return (
                  <button
                    key={tag}
                    onClick={() => toggleAnnotationFilterTag(tag)}
                    className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition-opacity hover:opacity-80"
                    style={{
                      backgroundColor: active ? 'var(--color-border-emphasis)' : 'transparent',
                      borderColor: active
                        ? 'var(--color-border-emphasis)'
                        : 'var(--color-border)',
                      color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
                    }}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          )}

          {/* Saved views (named filter presets) */}
          <div className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-1.5">
            <div className="flex items-center justify-between gap-1">
              <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-muted)]">
                <Bookmark className="size-3" />
                {t('annotations.savedViews')}
              </span>
              <button
                onClick={handleSaveCurrentView}
                disabled={!isActive}
                className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                title={t('annotations.saveCurrentView')}
              >
                {t('annotations.saveCurrentView')}
              </button>
            </div>
            {savedViews.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {savedViews.map((view) => (
                  <span
                    key={view.id}
                    className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--color-border)] py-0.5 pl-2 pr-1 text-[11px] text-[var(--color-text-muted)]"
                  >
                    <button
                      onClick={() => applySavedView(view.id)}
                      className="transition-opacity hover:opacity-80"
                    >
                      {view.name}
                    </button>
                    <button
                      onClick={() => void deleteSavedView(view.id)}
                      className="flex items-center transition-opacity hover:opacity-80"
                      title={t('annotations.deleteView', { name: view.name })}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
