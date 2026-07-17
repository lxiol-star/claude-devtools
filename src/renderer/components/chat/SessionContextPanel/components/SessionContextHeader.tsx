/**
 * SessionContextHeader - Header component with title, help tooltip, and token stats.
 */

import React from 'react';

import {
  COLOR_BORDER,
  COLOR_BORDER_SUBTLE,
  COLOR_SURFACE_OVERLAY,
  COLOR_TEXT,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SECONDARY,
} from '@renderer/constants/cssVariables';
import { useT } from '@renderer/i18n';
import { ArrowDownWideNarrow, FileText, LayoutList, X } from 'lucide-react';

import { formatTokens } from '../utils/formatting';

import { SessionContextHelpTooltip } from './SessionContextHelpTooltip';

import type { ContextViewMode } from '../types';
import type { ContextPhaseInfo } from '@renderer/types/contextInjection';

interface SessionContextHeaderProps {
  injectionCount: number;
  totalTokens: number;
  totalSessionTokens?: number;
  onClose?: () => void;
  phaseInfo?: ContextPhaseInfo;
  selectedPhase: number | null;
  onPhaseChange: (phase: number | null) => void;
  viewMode: ContextViewMode;
  onViewModeChange: (mode: ContextViewMode) => void;
}

export const SessionContextHeader = ({
  injectionCount,
  totalTokens,
  totalSessionTokens,
  onClose,
  phaseInfo,
  selectedPhase,
  onPhaseChange,
  viewMode,
  onViewModeChange,
}: Readonly<SessionContextHeaderProps>): React.ReactElement => {
  const t = useT();

  return (
    <div className="shrink-0 px-4 py-3" style={{ borderBottom: `1px solid ${COLOR_BORDER}` }}>
      {/* Title row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText size={16} style={{ color: COLOR_TEXT_SECONDARY }} />
          <h2 className="text-sm font-semibold" style={{ color: COLOR_TEXT }}>
            {t('chat.contextPanel.title')}
          </h2>
          <span
            className="rounded px-1.5 py-0.5 text-xs"
            style={{
              backgroundColor: COLOR_SURFACE_OVERLAY,
              color: COLOR_TEXT_SECONDARY,
            }}
          >
            {injectionCount}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SessionContextHelpTooltip />
          {onClose && (
            <button
              onClick={onClose}
              className="rounded p-1 transition-colors hover:bg-white/10"
              style={{ color: COLOR_TEXT_SECONDARY }}
              aria-label={t('chat.contextPanel.closePanel')}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Token comparison stats */}
      <div
        className="mt-2 flex items-center justify-between pt-2 text-xs"
        style={{ borderTop: `1px solid ${COLOR_BORDER_SUBTLE}` }}
      >
        <div className="flex items-center gap-4">
          {/* Visible Context tokens */}
          <div>
            <span style={{ color: COLOR_TEXT_MUTED }}>{t('chat.contextPanel.visibleLabel')} </span>
            <span className="font-medium tabular-nums" style={{ color: COLOR_TEXT_SECONDARY }}>
              ~{formatTokens(totalTokens)}
            </span>
          </div>
          {/* Total Session tokens (if provided) */}
          {totalSessionTokens !== undefined && totalSessionTokens > 0 && (
            <div>
              <span style={{ color: COLOR_TEXT_MUTED }}>{t('chat.contextPanel.totalLabel')} </span>
              <span className="font-medium tabular-nums" style={{ color: COLOR_TEXT_SECONDARY }}>
                {formatTokens(totalSessionTokens)}
              </span>
            </div>
          )}
        </div>
        {/* Percentage of total */}
        {totalSessionTokens !== undefined && totalSessionTokens > 0 && (
          <span
            className="rounded px-1.5 py-0.5 tabular-nums"
            style={{
              backgroundColor: COLOR_SURFACE_OVERLAY,
              color: COLOR_TEXT_MUTED,
            }}
          >
            {t('chat.contextPanel.percentOfTotal', {
              percent: Math.min((totalTokens / totalSessionTokens) * 100, 100).toFixed(1),
            })}
          </span>
        )}
      </div>

      {/* Phase selector - only shown when compactions exist */}
      {phaseInfo && phaseInfo.phases.length > 1 && (
        <div
          className="mt-2 flex flex-wrap items-center gap-1 pt-2"
          style={{ borderTop: `1px solid ${COLOR_BORDER_SUBTLE}` }}
        >
          <span className="mr-1 text-[10px]" style={{ color: COLOR_TEXT_MUTED }}>
            {t('chat.contextPanel.phaseLabel')}
          </span>
          {phaseInfo.phases.map((phase) => (
            <button
              key={phase.phaseNumber}
              onClick={() =>
                onPhaseChange(phase.phaseNumber === selectedPhase ? null : phase.phaseNumber)
              }
              className="rounded px-1.5 py-0.5 text-[10px] transition-colors"
              style={{
                backgroundColor:
                  selectedPhase === phase.phaseNumber
                    ? 'rgba(99, 102, 241, 0.2)'
                    : COLOR_SURFACE_OVERLAY,
                color: selectedPhase === phase.phaseNumber ? '#818cf8' : COLOR_TEXT_MUTED,
              }}
            >
              {phase.phaseNumber}
            </button>
          ))}
          <button
            onClick={() => onPhaseChange(null)}
            className="rounded px-1.5 py-0.5 text-[10px] transition-colors"
            style={{
              backgroundColor:
                selectedPhase === null ? 'rgba(99, 102, 241, 0.2)' : COLOR_SURFACE_OVERLAY,
              color: selectedPhase === null ? '#818cf8' : COLOR_TEXT_MUTED,
            }}
          >
            {t('chat.contextPanel.current')}
          </button>
        </div>
      )}

      {/* View mode toggle */}
      <div
        className="mt-2 flex items-center gap-1 pt-2"
        style={{ borderTop: `1px solid ${COLOR_BORDER_SUBTLE}` }}
      >
        <span className="mr-1 text-[10px]" style={{ color: COLOR_TEXT_MUTED }}>
          {t('chat.contextPanel.viewLabel')}
        </span>
        <button
          onClick={() => onViewModeChange('category')}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors"
          style={{
            backgroundColor:
              viewMode === 'category' ? 'rgba(99, 102, 241, 0.2)' : COLOR_SURFACE_OVERLAY,
            color: viewMode === 'category' ? '#818cf8' : COLOR_TEXT_MUTED,
          }}
        >
          <LayoutList size={10} />
          {t('chat.contextPanel.category')}
        </button>
        <button
          onClick={() => onViewModeChange('ranked')}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors"
          style={{
            backgroundColor:
              viewMode === 'ranked' ? 'rgba(99, 102, 241, 0.2)' : COLOR_SURFACE_OVERLAY,
            color: viewMode === 'ranked' ? '#818cf8' : COLOR_TEXT_MUTED,
          }}
        >
          <ArrowDownWideNarrow size={10} />
          {t('chat.contextPanel.bySize')}
        </button>
      </div>
    </div>
  );
};
