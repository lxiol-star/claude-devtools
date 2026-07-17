/**
 * NotificationsSection - Notification settings including triggers and ignored repositories.
 */

import {
  RepositoryDropdown,
  SelectedRepositoryItem,
} from '@renderer/components/common/RepositoryDropdown';
import { useT } from '@renderer/i18n';

import { SettingRow, SettingsSectionHeader, SettingsSelect, SettingsToggle } from '../components';
import { NotificationTriggerSettings } from '../NotificationTriggerSettings';

import type { RepositoryDropdownItem, SafeConfig } from '../hooks/useSettingsConfig';
import type { NotificationTrigger } from '@renderer/types/data';

// Snooze duration options (labels resolved via i18n at render time)
const SNOOZE_OPTIONS = [
  { value: 15, labelKey: 'settings.notifications.snoozeMinutes', count: 15 },
  { value: 30, labelKey: 'settings.notifications.snoozeMinutes', count: 30 },
  { value: 60, labelKey: 'settings.notifications.snoozeHour' },
  { value: 120, labelKey: 'settings.notifications.snoozeHours', count: 2 },
  { value: 240, labelKey: 'settings.notifications.snoozeHours', count: 4 },
  { value: -1, labelKey: 'settings.notifications.snoozeUntilTomorrow' },
] as const;

interface NotificationsSectionProps {
  readonly safeConfig: SafeConfig;
  readonly saving: boolean;
  readonly isSnoozed: boolean;
  readonly ignoredRepositoryItems: RepositoryDropdownItem[];
  readonly excludedRepositoryIds: string[];
  readonly onNotificationToggle: (
    key: 'enabled' | 'soundEnabled' | 'includeSubagentErrors',
    value: boolean
  ) => void;
  readonly onSnooze: (minutes: number) => Promise<void>;
  readonly onClearSnooze: () => Promise<void>;
  readonly onAddIgnoredRepository: (item: RepositoryDropdownItem) => Promise<void>;
  readonly onRemoveIgnoredRepository: (repositoryId: string) => Promise<void>;
  readonly onAddTrigger: (trigger: Omit<NotificationTrigger, 'isBuiltin'>) => Promise<void>;
  readonly onUpdateTrigger: (
    triggerId: string,
    updates: Partial<NotificationTrigger>
  ) => Promise<void>;
  readonly onRemoveTrigger: (triggerId: string) => Promise<void>;
}

export const NotificationsSection = ({
  safeConfig,
  saving,
  isSnoozed,
  ignoredRepositoryItems,
  excludedRepositoryIds,
  onNotificationToggle,
  onSnooze,
  onClearSnooze,
  onAddIgnoredRepository,
  onRemoveIgnoredRepository,
  onAddTrigger,
  onUpdateTrigger,
  onRemoveTrigger,
}: NotificationsSectionProps): React.JSX.Element => {
  const t = useT();

  return (
    <div>
      {/* Notification Triggers */}
      <NotificationTriggerSettings
        triggers={safeConfig.notifications.triggers || []}
        saving={saving}
        onUpdateTrigger={onUpdateTrigger}
        onAddTrigger={onAddTrigger}
        onRemoveTrigger={onRemoveTrigger}
      />

      {/* Notification Settings */}
      <SettingsSectionHeader title={t('settings.notifications.settings')} />
      <SettingRow
        label={t('settings.notifications.enableSystem')}
        description={t('settings.notifications.enableSystemDesc')}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.enabled}
          onChange={(v) => onNotificationToggle('enabled', v)}
          disabled={saving}
        />
      </SettingRow>
      <SettingRow
        label={t('settings.notifications.playSound')}
        description={t('settings.notifications.playSoundDesc')}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.soundEnabled}
          onChange={(v) => onNotificationToggle('soundEnabled', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label={t('settings.notifications.includeSubagentErrors')}
        description={t('settings.notifications.includeSubagentErrorsDesc')}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.includeSubagentErrors}
          onChange={(v) => onNotificationToggle('includeSubagentErrors', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label={t('settings.notifications.snooze')}
        description={
          isSnoozed
            ? t('settings.notifications.snoozedUntil', {
                time: new Date(safeConfig.notifications.snoozedUntil!).toLocaleTimeString(),
              })
            : t('settings.notifications.snoozeDesc')
        }
      >
        <div className="flex items-center gap-2">
          {isSnoozed ? (
            <button
              onClick={onClearSnooze}
              disabled={saving}
              className={`rounded-md bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-400 transition-all duration-150 hover:bg-red-500/20 ${saving ? 'cursor-not-allowed opacity-50' : ''} `}
            >
              {t('settings.notifications.clearSnooze')}
            </button>
          ) : (
            <SettingsSelect
              value={0}
              options={[
                { value: 0, label: t('settings.notifications.selectDuration') },
                ...SNOOZE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(
                    option.labelKey,
                    'count' in option ? { count: option.count } : undefined
                  ),
                })),
              ]}
              onChange={(v) => v !== 0 && onSnooze(v)}
              disabled={saving || !safeConfig.notifications.enabled}
              dropUp
            />
          )}
        </div>
      </SettingRow>

      <SettingsSectionHeader title={t('settings.notifications.ignoredRepositories')} />
      <p className="mb-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {t('settings.notifications.ignoredRepositoriesDesc')}
      </p>
      {ignoredRepositoryItems.length > 0 ? (
        <div className="mb-3">
          {ignoredRepositoryItems.map((item) => (
            <SelectedRepositoryItem
              key={item.id}
              item={item}
              onRemove={() => onRemoveIgnoredRepository(item.id)}
              disabled={saving}
            />
          ))}
        </div>
      ) : (
        <div
          className="mb-3 rounded-md border border-dashed py-3 text-center"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {t('settings.notifications.noRepositoriesIgnored')}
          </p>
        </div>
      )}
      <RepositoryDropdown
        onSelect={onAddIgnoredRepository}
        excludeIds={excludedRepositoryIds}
        placeholder={t('settings.notifications.selectRepositoryToIgnore')}
        disabled={saving}
        dropUp
      />
    </div>
  );
};
