/**
 * Renders the content of an expanded memory entry as markdown.
 *
 * Reuses the same prose markdown components the chat view uses, so a memory
 * layer looks identical to a session message — no second markdown stack.
 */

import ReactMarkdown from 'react-markdown';

import { markdownComponents } from '@renderer/components/chat/markdownComponents';
import { useT } from '@renderer/i18n';
import remarkGfm from 'remark-gfm';

interface MemoryEntryPreviewProps {
  content: string | undefined;
}

export const MemoryEntryPreview = ({ content }: MemoryEntryPreviewProps): React.JSX.Element => {
  const t = useT();

  if (content === undefined) {
    return <div className="px-2 py-1 text-xs text-text-muted">{t('common.loading')}</div>;
  }

  return (
    <div className="px-2 py-1 text-xs" style={{ color: 'var(--prose-body)' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
};
