/**
 * ContextSwitchOverlay - Full-screen loading overlay during context switches.
 *
 * Displayed when isContextSwitching is true, preventing stale data flash
 * during workspace transitions.
 */

import React from 'react';

import { useT } from '@renderer/i18n';
import { useStore } from '@renderer/store';

export const ContextSwitchOverlay: React.FC = () => {
  const t = useT();
  const isContextSwitching = useStore((state) => state.isContextSwitching);
  const targetContextId = useStore((state) => state.targetContextId);

  if (!isContextSwitching) {
    return null;
  }

  // Format context label for display
  const contextLabel =
    targetContextId === 'local'
      ? t('layout.local')
      : (targetContextId?.replace(/^ssh-/, '') ?? t('common.unknown'));

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-4">
        {/* Spinner */}
        <div className="size-8 animate-spin rounded-full border-4 border-text border-t-transparent" />

        {/* Text */}
        <div className="flex flex-col items-center gap-1">
          <p className="text-text">{t('layout.switchingTo', { context: contextLabel })}</p>
          <p className="text-sm text-text-secondary">{t('layout.loadingWorkspace')}</p>
        </div>
      </div>
    </div>
  );
};
