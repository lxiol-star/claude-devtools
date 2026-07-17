/**
 * SessionItem - Compact session row in the session list.
 * Shows title, message count, and time ago.
 * Supports right-click context menu for pane management.
 */

import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { SOURCE_COLORS } from '@renderer/constants/sourceColors';
import { useLanguage, useT } from '@renderer/i18n';
import { useStore } from '@renderer/store';
import { buildAnnotationKey } from '@shared/utils/annotationKey';
import { formatTokensCompact } from '@shared/utils/tokenFormatting';
import { formatDistanceToNowStrict, type Locale } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { EyeOff, MessageSquare, Pin } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { OngoingIndicator } from '../common/OngoingIndicator';

import { AnnotationStars } from './AnnotationStars';
import { SessionContextMenu } from './SessionContextMenu';

import type { PhaseTokenBreakdown, Session } from '@renderer/types/data';

interface SessionItemProps {
  session: Session;
  isActive?: boolean;
  isPinned?: boolean;
  isHidden?: boolean;
  multiSelectActive?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}

/**
 * Format time distance in short form (e.g., "4m", "2h", "1d").
 * When a date-fns locale is provided, uses its natural relative form (e.g., "4 分钟前").
 */
function formatShortTime(date: Date, locale?: Locale): string {
  if (locale) {
    return formatDistanceToNowStrict(date, { addSuffix: true, locale });
  }
  const distance = formatDistanceToNowStrict(date, { addSuffix: false });
  return distance
    .replace(' seconds', 's')
    .replace(' second', 's')
    .replace(' minutes', 'm')
    .replace(' minute', 'm')
    .replace(' hours', 'h')
    .replace(' hour', 'h')
    .replace(' days', 'd')
    .replace(' day', 'd')
    .replace(' weeks', 'w')
    .replace(' week', 'w')
    .replace(' months', 'mo')
    .replace(' month', 'mo')
    .replace(' years', 'y')
    .replace(' year', 'y');
}

/**
 * Consumption badge with hover popover showing phase breakdown.
 */
const ConsumptionBadge = ({
  contextConsumption,
  phaseBreakdown,
}: Readonly<{
  contextConsumption: number;
  phaseBreakdown?: PhaseTokenBreakdown[];
}>): React.JSX.Element => {
  const t = useT();
  const [popoverPosition, setPopoverPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const isHigh = contextConsumption > 150_000;

  const showPopover = popoverPosition !== null;

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- tooltip trigger via hover, not interactive
    <span
      ref={badgeRef}
      className="tabular-nums"
      style={{ color: isHigh ? 'rgb(251, 191, 36)' : undefined }}
      onMouseEnter={() => {
        const rect = badgeRef.current?.getBoundingClientRect();
        if (rect) {
          setPopoverPosition({
            top: rect.top - 6,
            left: rect.left + rect.width / 2,
          });
        }
      }}
      onMouseLeave={() => setPopoverPosition(null)}
    >
      {formatTokensCompact(contextConsumption)}
      {showPopover &&
        popoverPosition &&
        phaseBreakdown &&
        phaseBreakdown.length > 0 &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg px-3 py-2 text-[10px] shadow-xl"
            style={{
              top: popoverPosition.top,
              left: popoverPosition.left,
              backgroundColor: 'var(--color-surface-overlay)',
              border: '1px solid var(--color-border-emphasis)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <div className="mb-1 font-medium" style={{ color: 'var(--color-text)' }}>
              {t('sidebar.totalContextTokens', { count: formatTokensCompact(contextConsumption) })}
            </div>
            {phaseBreakdown.length === 1 ? (
              <div>
                {t('sidebar.contextTokens', { count: formatTokensCompact(phaseBreakdown[0].peakTokens) })}
              </div>
            ) : (
              phaseBreakdown.map((phase) => (
                <div key={phase.phaseNumber} className="flex items-center gap-1">
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {t('sidebar.phase', { number: phase.phaseNumber })}
                  </span>
                  <span className="tabular-nums">{formatTokensCompact(phase.contribution)}</span>
                  {phase.postCompaction != null && (
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      {t('sidebar.compactedTo', { count: formatTokensCompact(phase.postCompaction) })}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>,
          document.body
        )}
    </span>
  );
};

export const SessionItem = React.memo(function SessionItem({
  session,
  isActive,
  isPinned,
  isHidden,
  multiSelectActive,
  isSelected,
  onToggleSelect,
}: Readonly<SessionItemProps>): React.JSX.Element {
  const t = useT();
  const { language } = useLanguage();
  const {
    openTab,
    activeProjectId,
    selectSession,
    paneCount,
    splitPane,
    togglePinSession,
    toggleHideSession,
    setSessionAnnotation,
    sourceFilter,
  } = useStore(
    useShallow((s) => ({
      openTab: s.openTab,
      activeProjectId: s.activeProjectId,
      selectSession: s.selectSession,
      paneCount: s.paneLayout.panes.length,
      splitPane: s.splitPane,
      togglePinSession: s.togglePinSession,
      toggleHideSession: s.toggleHideSession,
      setSessionAnnotation: s.setSessionAnnotation,
      sourceFilter: s.sourceFilter,
    }))
  );

  const annotation = useStore(
    (s) => s.sessionAnnotations[buildAnnotationKey(session.contextId, session.projectId, session.id)]
  );

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const sessionLabel = session.firstMessage?.slice(0, 50) ?? t('sidebar.session');

  const handleClick = (event: React.MouseEvent): void => {
    if (!activeProjectId) return;

    // In multi-select mode, clicks toggle selection
    if (multiSelectActive && onToggleSelect) {
      onToggleSelect();
      return;
    }

    // Cmd/Ctrl+click: open in new tab; plain click: replace current tab
    const forceNewTab = event.ctrlKey || event.metaKey;

    openTab(
      {
        type: 'session',
        sessionId: session.id,
        contextId: session.contextId,
        projectId: activeProjectId,
        label: sessionLabel,
      },
      forceNewTab ? { forceNewTab } : { replaceActiveTab: true }
    );

    selectSession(session.id, session.contextId);
  };

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleOpenInCurrentPane = useCallback(() => {
    if (!activeProjectId) return;
    openTab(
      {
        type: 'session',
        sessionId: session.id,
        contextId: session.contextId,
        projectId: activeProjectId,
        label: sessionLabel,
      },
      { replaceActiveTab: true }
    );
    selectSession(session.id, session.contextId);
  }, [activeProjectId, openTab, selectSession, session.id, session.contextId, sessionLabel]);

  const handleOpenInNewTab = useCallback(() => {
    if (!activeProjectId) return;
    openTab(
      {
        type: 'session',
        sessionId: session.id,
        contextId: session.contextId,
        projectId: activeProjectId,
        label: sessionLabel,
      },
      { forceNewTab: true }
    );
    selectSession(session.id, session.contextId);
  }, [activeProjectId, openTab, selectSession, session.id, session.contextId, sessionLabel]);

  const handleSplitRightAndOpen = useCallback(() => {
    if (!activeProjectId) return;
    // First open the tab in the focused pane
    openTab({
      type: 'session',
      sessionId: session.id,
      contextId: session.contextId,
      projectId: activeProjectId,
      label: sessionLabel,
    });
    selectSession(session.id, session.contextId);
    // Then split it to the right
    const state = useStore.getState();
    const focusedPaneId = state.paneLayout.focusedPaneId;
    const activeTabId = state.activeTabId;
    if (activeTabId) {
      splitPane(focusedPaneId, activeTabId, 'right');
    }
  }, [activeProjectId, openTab, selectSession, session.id, session.contextId, sessionLabel, splitPane]);

  // Height must match SESSION_HEIGHT (48px) in DateGroupedSessions.tsx for virtual scroll
  return (
    <>
      <button
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className={`h-[48px] w-full overflow-hidden border-b px-3 py-2 text-left transition-all duration-150 ${isActive ? '' : 'bg-transparent hover:opacity-80'} `}
        style={{
          borderColor: 'var(--color-border)',
          ...(isActive ? { backgroundColor: 'var(--color-surface-raised)' } : {}),
          ...(isHidden ? { opacity: 0.5 } : {}),
        }}
      >
        {/* First line: title + ongoing indicator + pin/hidden icons */}
        <div className="flex items-center gap-1.5">
          {multiSelectActive && (
            <input
              type="checkbox"
              checked={isSelected ?? false}
              onChange={() => onToggleSelect?.()}
              onClick={(e) => e.stopPropagation()}
              className="size-3.5 shrink-0 accent-blue-500"
            />
          )}
          {session.isOngoing && <OngoingIndicator />}
          {isPinned && <Pin className="size-2.5 shrink-0 text-blue-400" />}
          {isHidden && <EyeOff className="size-2.5 shrink-0 text-zinc-500" />}
          <span
            className="truncate text-[13px] font-medium leading-tight"
            style={{ color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)' }}
          >
            {session.firstMessage ?? t('sidebar.untitled')}
          </span>
          {annotation?.score != null && annotation.score > 0 && (
            <span className="ml-auto shrink-0">
              <AnnotationStars score={annotation.score} />
            </span>
          )}
        </div>

        {/* Second line: message count + time + context consumption */}
        <div
          className="mt-0.5 flex items-center gap-2 text-[10px] leading-tight"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <span className="flex items-center gap-0.5">
            <MessageSquare className="size-2.5" />
            {session.messageCount}
          </span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span className="tabular-nums">
            {formatShortTime(
              new Date(Math.max(session.updatedAt ?? session.createdAt, session.createdAt)),
              language === 'zh' ? zhCN : undefined
            )}
          </span>
          {session.contextConsumption != null && session.contextConsumption > 0 && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <ConsumptionBadge
                contextConsumption={session.contextConsumption}
                phaseBreakdown={session.phaseBreakdown}
              />
            </>
          )}
          {/* Source badge — only in the aggregate ("All") view for tagged sessions */}
          {sourceFilter === 'all' && session.sourceBackend && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <span className="flex items-center gap-0.5">
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: SOURCE_COLORS[session.sourceBackend] }}
                />
                {t(`layout.sourceShort.${session.sourceBackend}`)}
              </span>
            </>
          )}
          {/* Annotation tag chips */}
          {annotation?.tags.map((tag) => (
            <span
              key={tag}
              className="shrink-0 truncate rounded px-1 py-px text-[9px] leading-tight"
              style={{
                backgroundColor: 'var(--color-surface-raised)',
                color: 'var(--color-text-secondary)',
                maxWidth: '80px',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      </button>

      {contextMenu &&
        activeProjectId &&
        createPortal(
          <SessionContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            sessionId={session.id}
            projectId={activeProjectId}
            sessionLabel={sessionLabel}
            paneCount={paneCount}
            isPinned={isPinned ?? false}
            isHidden={isHidden ?? false}
            annotation={annotation}
            onClose={() => setContextMenu(null)}
            onOpenInCurrentPane={handleOpenInCurrentPane}
            onOpenInNewTab={handleOpenInNewTab}
            onSplitRightAndOpen={handleSplitRightAndOpen}
            onTogglePin={() => void togglePinSession(session.id)}
            onToggleHide={() => void toggleHideSession(session.id)}
            onSetAnnotation={(patch) => void setSessionAnnotation(session, patch)}
          />,
          document.body
        )}
    </>
  );
});
