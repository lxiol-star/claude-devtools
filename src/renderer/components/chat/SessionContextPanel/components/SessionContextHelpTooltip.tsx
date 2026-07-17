/**
 * SessionContextHelpTooltip - Help tooltip explaining Visible Context vs Total Tokens.
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useT } from '@renderer/i18n';
import { HelpCircle } from 'lucide-react';

export const SessionContextHelpTooltip = (): React.ReactElement => {
  const t = useT();
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const [arrowStyle, setArrowStyle] = useState<React.CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimeout = (): void => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  };

  const handleMouseEnter = (): void => {
    clearHideTimeout();
    setShowTooltip(true);
  };

  const handleMouseLeave = (): void => {
    clearHideTimeout();
    hideTimeoutRef.current = setTimeout(() => setShowTooltip(false), 150);
  };

  useEffect(() => {
    return () => clearHideTimeout();
  }, []);

  // Close tooltip on scroll
  useEffect(() => {
    if (!showTooltip) return;

    const handleScroll = (): void => {
      setShowTooltip(false);
    };

    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, [showTooltip]);

  // Calculate tooltip position based on trigger element
  useEffect(() => {
    if (showTooltip && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const tooltipWidth = 288; // w-72 = 18rem = 288px

      setTooltipStyle({
        position: 'fixed',
        top: rect.bottom + 8,
        left: rect.right - tooltipWidth,
        width: tooltipWidth,
        zIndex: 99999,
      });

      setArrowStyle({
        position: 'absolute',
        top: -4,
        right: 12,
        width: 8,
        height: 8,
        transform: 'rotate(45deg)',
        backgroundColor: 'var(--color-surface-raised)',
        borderLeft: '1px solid var(--color-border)',
        borderTop: '1px solid var(--color-border)',
      });
    }
  }, [showTooltip]);

  return (
    <div
      role="button"
      tabIndex={0}
      ref={containerRef}
      className="relative inline-flex"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setShowTooltip(!showTooltip);
        }
      }}
    >
      <HelpCircle
        size={14}
        className="cursor-help transition-colors hover:opacity-80"
        style={{ color: 'var(--color-text-muted)' }}
      />

      {showTooltip &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className="rounded-lg p-3 shadow-xl"
            style={{
              ...tooltipStyle,
              backgroundColor: 'var(--color-surface-raised)',
              border: '1px solid var(--color-border)',
              boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3)',
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {/* Arrow */}
            <div style={arrowStyle} />

            <div className="space-y-3 text-xs">
              {/* What is Visible Context */}
              <div>
                <div className="mb-1 font-semibold" style={{ color: 'var(--color-text)' }}>
                  {t('chat.contextHelp.whatIsTitle')}
                </div>
                <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                  {t('chat.contextHelp.whatIsBody')}
                </p>
              </div>

              {/* Difference with Total */}
              <div className="pt-2" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
                <div className="mb-1 font-semibold" style={{ color: 'var(--color-text)' }}>
                  {t('chat.contextHelp.vsTitle')}
                </div>
                <div
                  className="space-y-2"
                  style={{ color: 'var(--color-text-secondary)', lineHeight: 1.5 }}
                >
                  <div className="flex">
                    <span
                      className="min-w-[74px] text-left"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {t('chat.contextPanel.totalLabel')}
                    </span>
                    <span className="flex-1 leading-snug">
                      {t('chat.contextHelp.totalDesc')}
                    </span>
                  </div>
                  <div className="flex">
                    <span
                      className="min-w-[74px] text-left"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {t('chat.contextPanel.visibleLabel')}
                    </span>
                    <span className="flex-1 leading-snug">
                      {t('chat.contextHelp.visibleDesc')}
                    </span>
                  </div>
                </div>
              </div>

              {/* Tips */}
              <div className="pt-2" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
                <div className="mb-1 font-semibold" style={{ color: 'var(--color-text)' }}>
                  {t('chat.contextHelp.tipsTitle')}
                </div>
                <ul
                  className="space-y-1 pl-3"
                  style={{ color: 'var(--color-text-secondary)', lineHeight: 1.5 }}
                >
                  <li className="list-disc">{t('chat.contextHelp.tipShortenClaudeMd')}</li>
                  <li className="list-disc">{t('chat.contextHelp.tipSplitFiles')}</li>
                  <li className="list-disc">{t('chat.contextHelp.tipMcpVerbosity')}</li>
                </ul>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
