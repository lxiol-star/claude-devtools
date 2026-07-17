/**
 * SessionContextMenu - Right-click context menu for sidebar session items.
 * Supports opening in current pane, new tab, and split right.
 * Shows keyboard shortcut hints for actions that have them.
 */

import { useEffect, useRef, useState } from 'react';

import { useT } from '@renderer/i18n';
import { MAX_PANES } from '@renderer/types/panes';
import { formatShortcut } from '@renderer/utils/stringUtils';
import {
  Check,
  ClipboardCopy,
  Eye,
  EyeOff,
  Pin,
  PinOff,
  StarOff,
  StickyNote,
  Tag,
  Terminal,
  X,
} from 'lucide-react';

import { AnnotationStars } from './AnnotationStars';

import type { SessionAnnotation } from '@shared/types';

interface SessionContextMenuProps {
  x: number;
  y: number;
  sessionId: string;
  projectId: string;
  sessionLabel: string;
  paneCount: number;
  isPinned: boolean;
  isHidden: boolean;
  annotation?: SessionAnnotation;
  onClose: () => void;
  onOpenInCurrentPane: () => void;
  onOpenInNewTab: () => void;
  onSplitRightAndOpen: () => void;
  onTogglePin: () => void;
  onToggleHide: () => void;
  onSetAnnotation: (patch: Partial<Pick<SessionAnnotation, 'tags' | 'score' | 'note'>>) => void;
}

export const SessionContextMenu = ({
  x,
  y,
  sessionId,
  paneCount,
  isPinned,
  isHidden,
  annotation,
  onClose,
  onOpenInCurrentPane,
  onOpenInNewTab,
  onSplitRightAndOpen,
  onTogglePin,
  onToggleHide,
  onSetAnnotation,
}: SessionContextMenuProps): React.JSX.Element => {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const [copiedField, setCopiedField] = useState<'id' | 'command' | null>(null);

  const tags = annotation?.tags ?? [];
  const score = annotation?.score ?? null;

  const handleAddTag = (): void => {
    const input = window.prompt(t('annotations.addTagPrompt'));
    const tag = input?.trim();
    if (!tag || tags.includes(tag)) return;
    onSetAnnotation({ tags: [...tags, tag] });
  };

  const handleRemoveTag = (tag: string): void => {
    onSetAnnotation({ tags: tags.filter((existing) => existing !== tag) });
  };

  const handleEditNote = (): void => {
    const input = window.prompt(t('annotations.editNotePrompt'), annotation?.note ?? '');
    if (input === null) return;
    onSetAnnotation({ note: input });
    onClose();
  };

  const handleSetScore = (value: number | null): void => {
    onSetAnnotation({ score: value });
  };

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const menuWidth = 240;
  const menuHeight = 430;
  const clampedX = Math.min(x, window.innerWidth - menuWidth - 8);
  const clampedY = Math.min(y, window.innerHeight - menuHeight - 8);

  const handleClick = (action: () => void) => () => {
    action();
    onClose();
  };

  const handleCopy = (text: string, field: 'id' | 'command') => async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => {
        setCopiedField(null);
        onClose();
      }, 600);
    } catch {
      // Silently fail
    }
  };

  const atMaxPanes = paneCount >= MAX_PANES;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[220px] overflow-hidden rounded-md border py-1 shadow-lg"
      style={{
        left: clampedX,
        top: clampedY,
        backgroundColor: 'var(--color-surface-overlay)',
        borderColor: 'var(--color-border-emphasis)',
        color: 'var(--color-text)',
      }}
    >
      <MenuItem label={t('sidebar.openInCurrentPane')} onClick={handleClick(onOpenInCurrentPane)} />
      <MenuItem label={t('sidebar.openInNewTab')} shortcut={`${formatShortcut('')}${t('sidebar.click')}`} onClick={handleClick(onOpenInNewTab)} />
      <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--color-border)' }} />
      <MenuItem
        label={t('sidebar.splitRightAndOpen')}
        onClick={handleClick(onSplitRightAndOpen)}
        disabled={atMaxPanes}
      />
      <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--color-border)' }} />
      <MenuItem
        label={isPinned ? t('sidebar.unpinSession') : t('sidebar.pinSession')}
        icon={isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        onClick={handleClick(onTogglePin)}
      />
      <MenuItem
        label={isHidden ? t('sidebar.unhideSession') : t('sidebar.hideSession')}
        icon={isHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        onClick={handleClick(onToggleHide)}
      />
      <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--color-border)' }} />

      {/* Rating */}
      <div className="flex items-center justify-between px-3 py-1.5 text-sm">
        <span className="flex items-center gap-2">
          <AnnotationStars score={score} interactive onChange={handleSetScore} />
        </span>
        {score !== null && (
          <button
            className="ml-2 rounded p-0.5 transition-colors hover:bg-[var(--color-surface-raised)]"
            onClick={() => handleSetScore(null)}
            title={t('annotations.clearRating')}
            aria-label={t('annotations.clearRating')}
          >
            <StarOff className="size-3.5" style={{ color: 'var(--color-text-muted)' }} />
          </button>
        )}
      </div>

      {/* Tags */}
      <MenuItem
        label={t('annotations.addTag')}
        icon={<Tag className="size-4" />}
        onClick={handleAddTag}
      />
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs"
              style={{
                backgroundColor: 'var(--color-surface-raised)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {tag}
              <button
                onClick={() => handleRemoveTag(tag)}
                title={t('annotations.removeTag', { tag })}
                aria-label={t('annotations.removeTag', { tag })}
                className="transition-colors hover:text-[var(--color-text)]"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Note */}
      <MenuItem
        label={t('annotations.editNote')}
        icon={<StickyNote className="size-4" />}
        onClick={handleEditNote}
      />
      <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--color-border)' }} />
      <MenuItem
        label={copiedField === 'id' ? t('sidebar.copied') : t('sidebar.copySessionId')}
        icon={
          copiedField === 'id' ? (
            <Check className="size-4 text-green-400" />
          ) : (
            <ClipboardCopy className="size-4" />
          )
        }
        onClick={handleCopy(sessionId, 'id')}
      />
      <MenuItem
        label={copiedField === 'command' ? t('sidebar.copied') : t('sidebar.copyResumeCommand')}
        icon={
          copiedField === 'command' ? (
            <Check className="size-4 text-green-400" />
          ) : (
            <Terminal className="size-4" />
          )
        }
        onClick={handleCopy(`claude --resume ${sessionId}`, 'command')}
      />
    </div>
  );
};

const MenuItem = ({
  label,
  shortcut,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}): React.JSX.Element => {
  return (
    <button
      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--color-surface-raised)]"
      onClick={onClick}
      disabled={disabled}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
      {shortcut && (
        <span className="ml-4 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {shortcut}
        </span>
      )}
    </button>
  );
};
