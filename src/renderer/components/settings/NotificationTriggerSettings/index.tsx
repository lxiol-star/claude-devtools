/**
 * NotificationTriggerSettings - Component for managing notification triggers.
 * Allows users to configure when notifications should be generated.
 *
 * Uses intent-first design pattern with 4 sections:
 * 1. General Info (always visible)
 * 2. Trigger Condition (mode selector)
 * 3. Dynamic Configuration (based on mode)
 * 4. Advanced (collapsible)
 */

import { useT } from '@renderer/i18n';

import { AddTriggerForm } from './components/AddTriggerForm';
import { SectionHeader } from './components/SectionHeader';
import { TriggerCard } from './components/TriggerCard';

import type { NotificationTriggerSettingsProps } from './types';

// Stable no-op function for builtin triggers that can't be removed
const noopRemove = (_triggerId: string): Promise<void> => Promise.resolve();

/**
 * Main component for managing notification triggers.
 */
export const NotificationTriggerSettings = ({
  triggers,
  saving,
  onUpdateTrigger,
  onAddTrigger,
  onRemoveTrigger,
}: Readonly<NotificationTriggerSettingsProps>): React.JSX.Element => {
  const t = useT();

  // Separate builtin and custom triggers
  const builtinTriggers = triggers.filter((trigger) => trigger.isBuiltin);
  const customTriggers = triggers.filter((trigger) => !trigger.isBuiltin);

  return (
    <div className="space-y-8">
      {/* Builtin Triggers */}
      {builtinTriggers.length > 0 && (
        <div>
          <SectionHeader title={t('settings.notifications.builtinTriggers')} />
          <p className="mb-4 text-xs text-text-muted">
            {t('settings.notifications.builtinTriggersDesc')}
          </p>
          <div>
            {builtinTriggers.map((trigger) => (
              <TriggerCard
                key={trigger.id}
                trigger={trigger}
                saving={saving}
                onUpdate={onUpdateTrigger}
                onRemove={noopRemove}
              />
            ))}
          </div>
        </div>
      )}

      {/* Custom Triggers */}
      <div>
        <SectionHeader title={t('settings.notifications.customTriggers')} />
        <p className="mb-4 text-xs text-text-muted">
          {t('settings.notifications.customTriggersDesc')}
        </p>

        {customTriggers.length > 0 && (
          <div className="mb-4">
            {customTriggers.map((trigger) => (
              <TriggerCard
                key={trigger.id}
                trigger={trigger}
                saving={saving}
                onUpdate={onUpdateTrigger}
                onRemove={onRemoveTrigger}
              />
            ))}
          </div>
        )}

        {customTriggers.length === 0 && (
          <p className="mb-4 text-sm italic text-text-muted">
            {t('settings.notifications.noCustomTriggers')}
          </p>
        )}

        <AddTriggerForm saving={saving} onAdd={onAddTrigger} />
      </div>
    </div>
  );
};
