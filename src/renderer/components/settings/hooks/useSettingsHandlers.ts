/**
 * useSettingsHandlers - Hook for all settings action handlers.
 * Groups handlers by section for better organization.
 */

import { useCallback, useRef } from 'react';

import { api } from '@renderer/api';
import { useT } from '@renderer/i18n';
import { useStore } from '@renderer/store';

import type { RepositoryDropdownItem } from './useSettingsConfig';
import type { AppConfig, NotificationTrigger } from '@renderer/types/data';

// Get the setState function from the store to update appConfig globally
const setStoreState = useStore.setState;

interface UseSettingsHandlersProps {
  config: AppConfig | null;
  setSaving: (saving: boolean) => void;
  setError: (error: string | null) => void;
  setConfig: (config: AppConfig | null) => void;
  setOptimisticConfig: React.Dispatch<React.SetStateAction<AppConfig | null>>;
  updateConfig: (
    section: keyof AppConfig,
    data: Partial<AppConfig[keyof AppConfig]>
  ) => Promise<void>;
}

interface SettingsHandlers {
  // General handlers
  handleGeneralToggle: (key: keyof AppConfig['general'], value: boolean) => void;
  handleThemeChange: (value: 'dark' | 'light' | 'system') => void;
  handleDefaultTabChange: (value: 'dashboard' | 'last-session') => void;

  // Notification handlers
  handleNotificationToggle: (key: keyof AppConfig['notifications'], value: boolean) => void;
  handleSnooze: (minutes: number) => Promise<void>;
  handleClearSnooze: () => Promise<void>;
  handleAddIgnoredRepository: (item: RepositoryDropdownItem) => Promise<void>;
  handleRemoveIgnoredRepository: (repositoryId: string) => Promise<void>;

  // Trigger handlers
  handleAddTrigger: (trigger: Omit<NotificationTrigger, 'isBuiltin'>) => Promise<void>;
  handleUpdateTrigger: (triggerId: string, updates: Partial<NotificationTrigger>) => Promise<void>;
  handleRemoveTrigger: (triggerId: string) => Promise<void>;

  // Display handlers
  handleDisplayToggle: (key: keyof AppConfig['display'], value: boolean) => void;

  // Advanced handlers
  handleResetToDefaults: () => Promise<void>;
  handleExportConfig: () => void;
  handleImportConfig: () => void;
  handleOpenInEditor: () => Promise<void>;
}

export function useSettingsHandlers({
  config,
  setSaving,
  setError,
  setConfig,
  setOptimisticConfig,
  updateConfig,
}: UseSettingsHandlersProps): SettingsHandlers {
  const t = useT();

  // Use ref for config to avoid recreating callbacks when config changes
  const configRef = useRef(config);
  configRef.current = config;

  // General handlers
  const handleGeneralToggle = useCallback(
    (key: keyof AppConfig['general'], value: boolean) => {
      void updateConfig('general', { [key]: value });
    },
    [updateConfig]
  );

  const handleThemeChange = useCallback(
    (value: 'dark' | 'light' | 'system') => {
      void updateConfig('general', { theme: value });
    },
    [updateConfig]
  );

  const handleDefaultTabChange = useCallback(
    (value: 'dashboard' | 'last-session') => {
      void updateConfig('general', { defaultTab: value });
    },
    [updateConfig]
  );

  // Notification handlers
  const handleNotificationToggle = useCallback(
    (key: keyof AppConfig['notifications'], value: boolean) => {
      void updateConfig('notifications', { [key]: value });
    },
    [updateConfig]
  );

  const handleSnooze = useCallback(
    async (minutes: number) => {
      try {
        setSaving(true);
        const updatedConfig = await api.config.snooze(minutes);
        setConfig(updatedConfig);
        setOptimisticConfig(updatedConfig);
        setStoreState({ appConfig: updatedConfig });
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.notifications.snoozeError'));
      } finally {
        setSaving(false);
      }
    },
    [setSaving, setConfig, setOptimisticConfig, setError, t]
  );

  const handleClearSnooze = useCallback(async () => {
    try {
      setSaving(true);
      const updatedConfig = await api.config.clearSnooze();
      setConfig(updatedConfig);
      setOptimisticConfig(updatedConfig);
      setStoreState({ appConfig: updatedConfig });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.notifications.clearSnoozeError'));
    } finally {
      setSaving(false);
    }
  }, [setSaving, setConfig, setOptimisticConfig, setError, t]);

  const handleAddIgnoredRepository = useCallback(
    async (item: RepositoryDropdownItem) => {
      try {
        setSaving(true);
        const updatedConfig = await api.config.addIgnoreRepository(item.id);
        setConfig(updatedConfig);
        setOptimisticConfig(updatedConfig);
        setStoreState({ appConfig: updatedConfig });
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.notifications.addRepositoryError'));
      } finally {
        setSaving(false);
      }
    },
    [setSaving, setConfig, setOptimisticConfig, setError, t]
  );

  const handleRemoveIgnoredRepository = useCallback(
    async (repositoryId: string) => {
      try {
        setSaving(true);
        const updatedConfig = await api.config.removeIgnoreRepository(repositoryId);
        setConfig(updatedConfig);
        setOptimisticConfig(updatedConfig);
        setStoreState({ appConfig: updatedConfig });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('settings.notifications.removeRepositoryError')
        );
      } finally {
        setSaving(false);
      }
    },
    [setSaving, setConfig, setOptimisticConfig, setError, t]
  );

  // Trigger handlers
  const handleAddTrigger = useCallback(
    async (trigger: Omit<NotificationTrigger, 'isBuiltin'>) => {
      try {
        setSaving(true);
        const updatedConfig = await api.config.addTrigger(trigger);
        setConfig(updatedConfig);
        setOptimisticConfig(updatedConfig);
        setStoreState({ appConfig: updatedConfig });
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.notifications.addTriggerError'));
      } finally {
        setSaving(false);
      }
    },
    [setSaving, setConfig, setOptimisticConfig, setError, t]
  );

  const handleUpdateTrigger = useCallback(
    async (triggerId: string, updates: Partial<NotificationTrigger>) => {
      // Optimistic update - immediately reflect the change in UI
      setOptimisticConfig((prev) => {
        if (!prev) return prev;
        const updatedTriggers =
          prev.notifications.triggers?.map((trigger) =>
            trigger.id === triggerId ? { ...trigger, ...updates } : trigger
          ) ?? [];
        return {
          ...prev,
          notifications: {
            ...prev.notifications,
            triggers: updatedTriggers,
          },
        };
      });

      try {
        setSaving(true);
        const updatedConfig = await api.config.updateTrigger(triggerId, updates);
        setConfig(updatedConfig);
        setOptimisticConfig(updatedConfig);
        setStoreState({ appConfig: updatedConfig });
      } catch (err) {
        // Revert optimistic update on error using ref to avoid stale closure
        setOptimisticConfig(configRef.current);
        setError(err instanceof Error ? err.message : t('settings.notifications.updateTriggerError'));
      } finally {
        setSaving(false);
      }
    },
    [setSaving, setConfig, setOptimisticConfig, setError, t]
  );

  const handleRemoveTrigger = useCallback(
    async (triggerId: string) => {
      try {
        setSaving(true);
        const updatedConfig = await api.config.removeTrigger(triggerId);
        setConfig(updatedConfig);
        setOptimisticConfig(updatedConfig);
        setStoreState({ appConfig: updatedConfig });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('settings.notifications.removeTriggerError')
        );
      } finally {
        setSaving(false);
      }
    },
    [setSaving, setConfig, setOptimisticConfig, setError, t]
  );

  // Display handlers
  const handleDisplayToggle = useCallback(
    (key: keyof AppConfig['display'], value: boolean) => {
      void updateConfig('display', { [key]: value });
    },
    [updateConfig]
  );

  // Advanced handlers
  const handleResetToDefaults = useCallback(async () => {
    if (!confirm(t('settings.advanced.resetConfirm'))) {
      return;
    }
    try {
      setSaving(true);
      const defaultIgnoredRegex = ["The user doesn't want to proceed with this tool use\\."];
      const defaultTriggers: NotificationTrigger[] = [
        {
          id: 'builtin-tool-result-error',
          name: 'Tool Result Error',
          enabled: true,
          contentType: 'tool_result',
          mode: 'error_status',
          requireError: true,
          ignorePatterns: ["The user doesn't want to proceed with this tool use\\."],
          isBuiltin: true,
        },
        {
          id: 'builtin-bash-command',
          name: 'Bash Command Alert for .env files',
          enabled: true,
          contentType: 'tool_use',
          toolName: 'Bash',
          mode: 'content_match',
          matchField: 'command',
          matchPattern: '/.env',
          isBuiltin: true,
        },
      ];
      const defaultConfig: AppConfig = {
        notifications: {
          enabled: true,
          soundEnabled: true,
          ignoredRegex: defaultIgnoredRegex,
          ignoredRepositories: [],
          snoozedUntil: null,
          snoozeMinutes: 30,
          includeSubagentErrors: true,
          triggers: defaultTriggers,
        },
        general: {
          launchAtLogin: false,
          showDockIcon: true,
          theme: 'dark',
          defaultTab: 'dashboard',
          claudeRootPath: null,
          autoExpandAIGroups: false,
          useNativeTitleBar: false,
        },
        display: {
          showTimestamps: true,
          compactMode: false,
          syntaxHighlighting: true,
        },
        sessions: {
          pinnedSessions: {},
          hiddenSessions: {},
          sessionAnnotations: {},
          savedViews: [],
        },
      };

      await api.config.update('notifications', defaultConfig.notifications);
      await api.config.update('general', defaultConfig.general);
      const updatedConfig = await api.config.update('display', defaultConfig.display);
      setConfig(updatedConfig);
      setOptimisticConfig(updatedConfig);
      setStoreState({ appConfig: updatedConfig });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.advanced.resetError'));
    } finally {
      setSaving(false);
    }
  }, [setSaving, setConfig, setOptimisticConfig, setError, t]);

  const handleExportConfig = useCallback(() => {
    if (!configRef.current) return;
    const dataStr = JSON.stringify(configRef.current, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'claude-devtools-config.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, []);

  const handleOpenInEditor = useCallback(async () => {
    try {
      await api.config.openInEditor();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.advanced.openInEditorError'));
    }
  }, [setError, t]);

  const handleImportConfig = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        setSaving(true);
        const text = await file.text();
        const importedConfig = JSON.parse(text) as AppConfig;

        if (importedConfig.notifications) {
          await api.config.update('notifications', importedConfig.notifications);
        }
        if (importedConfig.general) {
          await api.config.update('general', importedConfig.general);
        }
        if (importedConfig.display) {
          await api.config.update('display', importedConfig.display);
        }

        const updatedConfig = await api.config.get();
        setConfig(updatedConfig);
        setOptimisticConfig(updatedConfig);
        setStoreState({ appConfig: updatedConfig });
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.advanced.importError'));
      } finally {
        setSaving(false);
      }
    };
    input.click();
  }, [setSaving, setConfig, setOptimisticConfig, setError, t]);

  return {
    handleGeneralToggle,
    handleThemeChange,
    handleDefaultTabChange,
    handleNotificationToggle,
    handleSnooze,
    handleClearSnooze,
    handleAddIgnoredRepository,
    handleRemoveIgnoredRepository,
    handleAddTrigger,
    handleUpdateTrigger,
    handleRemoveTrigger,
    handleDisplayToggle,
    handleResetToDefaults,
    handleExportConfig,
    handleImportConfig,
    handleOpenInEditor,
  };
}
