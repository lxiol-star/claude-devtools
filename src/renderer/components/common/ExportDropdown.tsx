/**
 * ExportDropdown - Download icon button with dropdown for exporting session data.
 *
 * Supports three formats: Markdown (.md), JSON (.json), Plain Text (.txt).
 * Follows the same close-on-outside-click / Escape patterns as RepositoryDropdown.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '@renderer/i18n';
import { triggerDownload } from '@renderer/utils/sessionExporter';
import { Braces, Download, FileText, FlaskConical, Type } from 'lucide-react';

import type { SessionDetail } from '@renderer/types/data';
import type { ExportFormat } from '@renderer/utils/sessionExporter';

interface ExportDropdownProps {
  sessionDetail: SessionDetail;
}

interface FormatOption {
  format: ExportFormat;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  ext: string;
}

const FORMAT_OPTIONS: FormatOption[] = [
  { format: 'markdown', labelKey: 'layout.formatMarkdown', icon: FileText, ext: '.md' },
  { format: 'json', labelKey: 'layout.formatJson', icon: Braces, ext: '.json' },
  { format: 'plaintext', labelKey: 'layout.formatPlainText', icon: Type, ext: '.txt' },
  { format: 'fixtures', labelKey: 'layout.formatFixtures', icon: FlaskConical, ext: '.fixtures.json' },
];

export const ExportDropdown = ({
  sessionDetail,
}: Readonly<ExportDropdownProps>): React.JSX.Element => {
  const t = useT();
  const [isOpen, setIsOpen] = useState(false);
  const [buttonHover, setButtonHover] = useState(false);
  const [hoveredFormat, setHoveredFormat] = useState<ExportFormat | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  const handleExport = useCallback(
    (format: ExportFormat) => {
      triggerDownload(sessionDetail, format);
      setIsOpen(false);
    },
    [sessionDetail]
  );

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        onMouseEnter={() => setButtonHover(true)}
        onMouseLeave={() => setButtonHover(false)}
        className="rounded-md p-2 transition-colors"
        style={{
          color: buttonHover || isOpen ? 'var(--color-text)' : 'var(--color-text-muted)',
          backgroundColor: buttonHover || isOpen ? 'var(--color-surface-raised)' : 'transparent',
        }}
        title={t('layout.exportSessionTooltip')}
      >
        <Download className="size-4" />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-md border shadow-lg"
          style={{
            backgroundColor: 'var(--color-surface-overlay)',
            borderColor: 'var(--color-border)',
          }}
        >
          {/* Header */}
          <div
            className="px-3 py-2 text-xs font-medium"
            style={{
              color: 'var(--color-text-secondary)',
              borderBottom: '1px solid var(--color-border)',
            }}
          >
            {t('layout.exportSession')}
          </div>

          {/* Format options */}
          {FORMAT_OPTIONS.map((option) => (
            <button
              key={option.format}
              onClick={() => handleExport(option.format)}
              onMouseEnter={() => setHoveredFormat(option.format)}
              onMouseLeave={() => setHoveredFormat(null)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors"
              style={{
                color:
                  hoveredFormat === option.format
                    ? 'var(--color-text)'
                    : 'var(--color-text-secondary)',
                backgroundColor:
                  hoveredFormat === option.format ? 'var(--color-surface-raised)' : 'transparent',
              }}
            >
              <option.icon className="size-3.5" />
              <span className="flex-1">{t(option.labelKey)}</span>
              <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                {option.ext}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
