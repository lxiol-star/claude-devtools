import { useT } from '@renderer/i18n';

/**
 * Empty state for ChatHistory when no conversation exists.
 */
export const ChatHistoryEmptyState = (): JSX.Element => {
  const t = useT();

  return (
    <div className="flex flex-1 items-center justify-center overflow-hidden bg-surface">
      <div className="space-y-2 text-center text-text-muted">
        <div className="mb-4 text-6xl">💬</div>
        <div className="text-xl font-medium text-text-secondary">
          {t('chat.empty.noConversation')}
        </div>
        <div className="text-sm">{t('chat.empty.noMessages')}</div>
      </div>
    </div>
  );
};
