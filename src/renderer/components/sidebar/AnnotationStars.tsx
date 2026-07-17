/**
 * AnnotationStars - Renders a 0–5 star rating.
 * When interactive, clicking a star sets the score (clicking the current score clears it).
 */

import { useT } from '@renderer/i18n';
import { Star } from 'lucide-react';

interface AnnotationStarsProps {
  /** Current score (null = unrated) */
  score: number | null;
  /** Whether stars are clickable */
  interactive?: boolean;
  /** Called with the new score when a star is clicked */
  onChange?: (score: number | null) => void;
  /** Tailwind size class for each star (defaults to size-4 interactive, size-2.5 static) */
  sizeClass?: string;
}

const STAR_VALUES = [1, 2, 3, 4, 5] as const;

export const AnnotationStars = ({
  score,
  interactive = false,
  onChange,
  sizeClass,
}: AnnotationStarsProps): React.JSX.Element => {
  const t = useT();
  const filled = score ?? 0;
  const resolvedSize = sizeClass ?? (interactive ? 'size-4' : 'size-2.5');

  if (!interactive) {
    return (
      <span className="inline-flex items-center gap-0.5">
        {STAR_VALUES.map((value) => (
          <Star
            key={value}
            className={resolvedSize}
            style={{ color: value <= filled ? 'rgb(251, 191, 36)' : 'var(--color-text-muted)' }}
            fill={value <= filled ? 'currentColor' : 'none'}
          />
        ))}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-0.5" aria-label={t('annotations.rate')}>
      {STAR_VALUES.map((value) => (
        <button
          key={value}
          onClick={() => onChange?.(value === score ? null : value)}
          title={t('annotations.rate')}
          aria-label={`${t('annotations.rate')} ${value}`}
          className="transition-transform hover:scale-110"
        >
          <Star
            className={resolvedSize}
            style={{ color: value <= filled ? 'rgb(251, 191, 36)' : 'var(--color-text-muted)' }}
            fill={value <= filled ? 'currentColor' : 'none'}
          />
        </button>
      ))}
    </span>
  );
};
