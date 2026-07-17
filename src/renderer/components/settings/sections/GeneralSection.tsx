/**
 * GeneralSection - General settings including startup, appearance, browser access, and local data root.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { LANGUAGE_OPTIONS, useLanguage, useT } from '@renderer/i18n';
import { useStore } from '@renderer/store';
import { getFullResetState } from '@renderer/store/utils/stateResetHelpers';
import { Check, Copy, FolderOpen, Laptop, Loader2, RotateCcw } from 'lucide-react';

import { SettingRow, SettingsSectionHeader, SettingsSelect, SettingsToggle } from '../components';

import type { SafeConfig } from '../hooks/useSettingsConfig';
import type { ClaudeRootInfo, WslClaudeRootCandidate } from '@shared/types';
import type { HttpServerStatus } from '@shared/types/api';
import type { AppConfig } from '@shared/types/notifications';

// Theme options (labels resolved via i18n at render time)
const THEME_OPTIONS = [
  { value: 'dark', labelKey: 'settings.theme.dark' },
  { value: 'light', labelKey: 'settings.theme.light' },
  { value: 'system', labelKey: 'settings.theme.system' },
] as const;

interface GeneralSectionProps {
  readonly safeConfig: SafeConfig;
  readonly saving: boolean;
  readonly onGeneralToggle: (key: keyof AppConfig['general'], value: boolean) => void;
  readonly onThemeChange: (value: 'dark' | 'light' | 'system') => void;
}

export const GeneralSection = ({
  safeConfig,
  saving,
  onGeneralToggle,
  onThemeChange,
}: GeneralSectionProps): React.JSX.Element => {
  const t = useT();
  const { language, setLanguage } = useLanguage();

  const [serverStatus, setServerStatus] = useState<HttpServerStatus>({
    running: false,
    port: 3456,
  });
  const [serverLoading, setServerLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Claude Root state
  const connectionMode = useStore((s) => s.connectionMode);
  const fetchProjects = useStore((s) => s.fetchProjects);
  const fetchRepositoryGroups = useStore((s) => s.fetchRepositoryGroups);
  const fetchDataBackend = useStore((s) => s.fetchDataBackend);
  const fetchAvailableContexts = useStore((s) => s.fetchAvailableContexts);

  const [claudeRootInfo, setClaudeRootInfo] = useState<ClaudeRootInfo | null>(null);
  const [updatingClaudeRoot, setUpdatingClaudeRoot] = useState(false);
  const [claudeRootError, setClaudeRootError] = useState<string | null>(null);
  const [findingWslRoots, setFindingWslRoots] = useState(false);
  const [wslCandidates, setWslCandidates] = useState<WslClaudeRootCandidate[]>([]);
  const [showWslModal, setShowWslModal] = useState(false);

  // Fetch server status and Claude root info on mount
  useEffect(() => {
    void api.httpServer.getStatus().then(setServerStatus);
  }, []);

  const loadClaudeRootInfo = useCallback(async () => {
    try {
      const info = await api.config.getClaudeRootInfo();
      setClaudeRootInfo(info);
    } catch (error) {
      setClaudeRootError(
        error instanceof Error ? error.message : t('settings.general.loadRootError')
      );
    }
  }, [t]);

  useEffect(() => {
    void loadClaudeRootInfo();
  }, [loadClaudeRootInfo]);

  const handleServerToggle = useCallback(async (enabled: boolean) => {
    setServerLoading(true);
    try {
      const status = enabled ? await api.httpServer.start() : await api.httpServer.stop();
      setServerStatus(status);
    } catch {
      // Status didn't change
    } finally {
      setServerLoading(false);
    }
  }, []);

  const serverUrl = `http://localhost:${serverStatus.port}`;

  const handleCopyUrl = useCallback(() => {
    void navigator.clipboard.writeText(serverUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [serverUrl]);

  // Claude Root handlers
  const resetWorkspaceForRootChange = useCallback((): void => {
    useStore.setState({
      projects: [],
      repositoryGroups: [],
      openTabs: [],
      activeTabId: null,
      activeContextId: 'local',
      selectedTabIds: [],
      paneLayout: {
        panes: [
          {
            id: 'pane-default',
            tabs: [],
            activeTabId: null,
            selectedTabIds: [],
            widthFraction: 1,
          },
        ],
        focusedPaneId: 'pane-default',
      },
      ...getFullResetState(),
    });
  }, []);

  const applyClaudeRootPath = useCallback(
    async (claudeRootPath: string | null): Promise<void> => {
      try {
        setUpdatingClaudeRoot(true);
        setClaudeRootError(null);

        await api.config.update('general', { claudeRootPath });
        await loadClaudeRootInfo();

        if (connectionMode === 'local') {
          resetWorkspaceForRootChange();
          await Promise.all([fetchProjects(), fetchRepositoryGroups(), fetchDataBackend()]);
          await fetchAvailableContexts();
        }
      } catch (error) {
        setClaudeRootError(
          error instanceof Error ? error.message : t('settings.general.updateRootError')
        );
      } finally {
        setUpdatingClaudeRoot(false);
      }
    },
    [
      connectionMode,
      fetchProjects,
      fetchRepositoryGroups,
      fetchDataBackend,
      fetchAvailableContexts,
      loadClaudeRootInfo,
      resetWorkspaceForRootChange,
      t,
    ]
  );

  const handleSelectClaudeRootFolder = useCallback(async (): Promise<void> => {
    setClaudeRootError(null);

    const selection = await api.config.selectClaudeRootFolder();
    if (!selection) {
      return;
    }

    if (!selection.isClaudeDirName) {
      const proceed = await confirm({
        title: t('settings.general.unknownFolderTitle'),
        message: t('settings.general.unknownFolderMessage', {
          name: selection.path.split(/[\\/]/).pop() ?? selection.path,
        }),
        confirmLabel: t('settings.general.useFolder'),
      });
      if (!proceed) {
        return;
      }
    }

    if (!selection.hasProjectsDir) {
      const proceed = await confirm({
        title: t('settings.general.noSessionsDirTitle'),
        message: t('settings.general.noSessionsDirMessage'),
        confirmLabel: t('settings.general.useFolder'),
      });
      if (!proceed) {
        return;
      }
    }

    await applyClaudeRootPath(selection.path);
  }, [applyClaudeRootPath, t]);

  const handleResetClaudeRoot = useCallback(async (): Promise<void> => {
    await applyClaudeRootPath(null);
  }, [applyClaudeRootPath]);

  const applyWslCandidate = useCallback(
    async (candidate: WslClaudeRootCandidate): Promise<void> => {
      if (!candidate.hasProjectsDir) {
        const proceed = await confirm({
          title: t('settings.general.wslMissingProjectsTitle'),
          message: t('settings.general.wslMissingProjectsMessage', { path: candidate.path }),
          confirmLabel: t('settings.general.usePath'),
        });
        if (!proceed) {
          return;
        }
      }

      await applyClaudeRootPath(candidate.path);
      setShowWslModal(false);
    },
    [applyClaudeRootPath, t]
  );

  const handleUseWslForClaude = useCallback(async (): Promise<void> => {
    try {
      setFindingWslRoots(true);
      setClaudeRootError(null);
      const candidates = await api.config.findWslClaudeRoots();
      setWslCandidates(candidates);

      if (candidates.length === 0) {
        const pickManually = await confirm({
          title: t('settings.general.noWslRootsTitle'),
          message: t('settings.general.noWslRootsMessage'),
          confirmLabel: t('settings.general.selectFolder'),
        });
        if (pickManually) {
          await handleSelectClaudeRootFolder();
        }
        return;
      }

      const candidatesWithProjects = candidates.filter((candidate) => candidate.hasProjectsDir);
      if (candidatesWithProjects.length === 1) {
        await applyWslCandidate(candidatesWithProjects[0]);
        return;
      }

      setShowWslModal(true);
    } catch (error) {
      setClaudeRootError(
        error instanceof Error ? error.message : t('settings.general.wslDetectError')
      );
    } finally {
      setFindingWslRoots(false);
    }
  }, [applyWslCandidate, handleSelectClaudeRootFolder, t]);

  const isCustomClaudeRoot = Boolean(claudeRootInfo?.customPath);
  const resolvedClaudeRootPath = claudeRootInfo?.resolvedPath ?? '~/.claude';
  const defaultClaudeRootPath = claudeRootInfo?.defaultPath ?? '~/.claude';
  const isWindowsStyleDefaultPath =
    /^[a-zA-Z]:\\/.test(defaultClaudeRootPath) || defaultClaudeRootPath.startsWith('\\\\');

  const isElectron = useMemo(() => isElectronMode(), []);

  return (
    <div>
      {isElectron && (
        <>
          <SettingsSectionHeader title={t('settings.general.startup')} />
          <SettingRow
            label={t('settings.general.launchAtLogin')}
            description={t('settings.general.launchAtLoginDesc')}
          >
            <SettingsToggle
              enabled={safeConfig.general.launchAtLogin}
              onChange={(v) => onGeneralToggle('launchAtLogin', v)}
              disabled={saving}
            />
          </SettingRow>
          {window.navigator.userAgent.includes('Macintosh') && (
            <SettingRow
              label={t('settings.general.showDockIcon')}
              description={t('settings.general.showDockIconDesc')}
            >
              <SettingsToggle
                enabled={safeConfig.general.showDockIcon}
                onChange={(v) => onGeneralToggle('showDockIcon', v)}
                disabled={saving}
              />
            </SettingRow>
          )}
        </>
      )}

      <SettingsSectionHeader title={t('settings.general.appearance')} />
      <SettingRow
        label={t('settings.general.language')}
        description={t('settings.general.languageDesc')}
      >
        <SettingsSelect
          value={language}
          options={LANGUAGE_OPTIONS}
          onChange={setLanguage}
          disabled={saving}
        />
      </SettingRow>
      <SettingRow label={t('settings.general.theme')} description={t('settings.general.themeDesc')}>
        <SettingsSelect
          value={safeConfig.general.theme}
          options={THEME_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
          onChange={onThemeChange}
          disabled={saving}
        />
      </SettingRow>
      <SettingRow
        label={t('settings.general.autoExpand')}
        description={t('settings.general.autoExpandDesc')}
      >
        <SettingsToggle
          enabled={safeConfig.general.autoExpandAIGroups ?? false}
          onChange={(v) => onGeneralToggle('autoExpandAIGroups', v)}
          disabled={saving}
        />
      </SettingRow>
      {isElectron && !window.navigator.userAgent.includes('Macintosh') && (
        <SettingRow
          label={t('settings.general.nativeTitleBar')}
          description={t('settings.general.nativeTitleBarDesc')}
        >
          <SettingsToggle
            enabled={safeConfig.general.useNativeTitleBar}
            onChange={async (v) => {
              const shouldRelaunch = await confirm({
                title: t('settings.general.restartRequired'),
                message: t('settings.general.restartTitleBarMessage'),
                confirmLabel: t('settings.general.restart'),
              });
              if (shouldRelaunch) {
                onGeneralToggle('useNativeTitleBar', v);
                // Small delay to let config persist before relaunch
                setTimeout(() => {
                  void window.electronAPI?.windowControls?.relaunch();
                }, 200);
              }
            }}
            disabled={saving}
          />
        </SettingRow>
      )}

      {isElectron && (
        <>
          <SettingsSectionHeader title={t('settings.general.dataRoot')} />
          <p className="mb-4 text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {t('settings.general.dataRootDesc')}
          </p>

          <SettingRow
            label={t('settings.general.currentRoot')}
            description={
              isCustomClaudeRoot
                ? t('settings.general.usingCustomPath')
                : t('settings.general.usingAutoDetect')
            }
          >
            <div className="max-w-96 text-right">
              <div className="truncate font-mono text-xs" style={{ color: 'var(--color-text)' }}>
                {resolvedClaudeRootPath}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                {t('settings.general.autoDetectedPath', { path: defaultClaudeRootPath })}
              </div>
            </div>
          </SettingRow>

          {claudeRootInfo?.knownRoots && claudeRootInfo.knownRoots.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 py-2">
              {claudeRootInfo.knownRoots.map((root) => {
                const isActive = resolvedClaudeRootPath === root.path;
                return (
                  <button
                    key={root.path}
                    onClick={() => void applyClaudeRootPath(root.path)}
                    disabled={updatingClaudeRoot || isActive || !root.exists}
                    title={
                      root.exists
                        ? root.path
                        : t('settings.general.rootNotFound', { path: root.path })
                    }
                    className="rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
                    style={{
                      backgroundColor: isActive
                        ? 'var(--color-surface-overlay)'
                        : 'var(--color-surface-raised)',
                      borderColor: isActive ? 'var(--color-border-emphasis)' : 'var(--color-border)',
                      color: 'var(--color-text)',
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: root.exists ? '#22c55e' : '#6b7280' }}
                      />
                      {root.label}
                      {isActive && <Check className="size-3" />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-3 py-2">
            <button
              onClick={() => void handleSelectClaudeRootFolder()}
              disabled={updatingClaudeRoot}
              className="rounded-md px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
              style={{
                backgroundColor: 'var(--color-surface-raised)',
                color: 'var(--color-text)',
              }}
            >
              <span className="flex items-center gap-2">
                {updatingClaudeRoot ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <FolderOpen className="size-3" />
                )}
                {t('settings.general.selectFolder')}
              </span>
            </button>

            <button
              onClick={() => void handleResetClaudeRoot()}
              disabled={updatingClaudeRoot || !isCustomClaudeRoot}
              className="rounded-md px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
              style={{
                backgroundColor: 'var(--color-surface-raised)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <span className="flex items-center gap-2">
                <RotateCcw className="size-3" />
                {t('settings.general.useAutoDetect')}
              </span>
            </button>

            {isWindowsStyleDefaultPath && (
              <button
                onClick={() => void handleUseWslForClaude()}
                disabled={updatingClaudeRoot || findingWslRoots}
                className="rounded-md px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
                style={{
                  backgroundColor: 'var(--color-surface-raised)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                <span className="flex items-center gap-2">
                  {findingWslRoots ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Laptop className="size-3" />
                  )}
                  {t('settings.general.usingWsl')}
                </span>
              </button>
            )}
          </div>

          {claudeRootError && (
            <div className="rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3">
              <p className="text-sm text-red-400">{claudeRootError}</p>
            </div>
          )}

          {showWslModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center">
              <button
                className="absolute inset-0 cursor-default"
                style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
                onClick={() => setShowWslModal(false)}
                aria-label={t('settings.general.closeWslModal')}
                tabIndex={-1}
              />
              <div
                className="relative mx-4 w-full max-w-2xl rounded-lg border p-5 shadow-xl"
                style={{
                  backgroundColor: 'var(--color-surface-overlay)',
                  borderColor: 'var(--color-border-emphasis)',
                }}
              >
                <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                  {t('settings.general.wslModalTitle')}
                </h3>
                <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {t('settings.general.wslModalDesc')}
                </p>

                <div className="mt-4 space-y-2">
                  {wslCandidates.map((candidate) => (
                    <div
                      key={`${candidate.distro}:${candidate.path}`}
                      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                      style={{ borderColor: 'var(--color-border)' }}
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                          {candidate.distro}
                        </p>
                        <p
                          className="truncate font-mono text-[11px]"
                          style={{ color: 'var(--color-text-muted)' }}
                        >
                          {candidate.path}
                        </p>
                        {!candidate.hasProjectsDir && (
                          <p className="text-[11px] text-amber-400">
                            {t('settings.general.noProjectsDirDetected')}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => void applyWslCandidate(candidate)}
                        className="rounded-md px-3 py-1.5 text-xs transition-colors"
                        style={{
                          backgroundColor: 'var(--color-surface-raised)',
                          color: 'var(--color-text)',
                        }}
                      >
                        {t('settings.general.useThisPath')}
                      </button>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    onClick={() => setShowWslModal(false)}
                    className="rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
                    style={{
                      borderColor: 'var(--color-border)',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={() => {
                      setShowWslModal(false);
                      void handleSelectClaudeRootFolder();
                    }}
                    className="rounded-md px-3 py-1.5 text-xs transition-colors"
                    style={{
                      backgroundColor: 'var(--color-surface-raised)',
                      color: 'var(--color-text)',
                    }}
                  >
                    {t('settings.general.selectFolderManually')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {isElectron ? (
        <>
          <SettingsSectionHeader title={t('settings.general.browserAccess')} />
          <SettingRow
            label={t('settings.general.enableServerMode')}
            description={t('settings.general.enableServerModeDesc')}
          >
            {serverLoading ? (
              <Loader2
                className="size-5 animate-spin"
                style={{ color: 'var(--color-text-muted)' }}
              />
            ) : (
              <SettingsToggle
                enabled={serverStatus.running}
                onChange={handleServerToggle}
                disabled={saving}
              />
            )}
          </SettingRow>

          {serverStatus.running && (
            <div
              className="mb-2 flex items-center gap-3 rounded-md px-3 py-2.5"
              style={{ backgroundColor: 'var(--color-surface-raised)' }}
            >
              <div
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: '#22c55e' }}
              />
              <span
                className="text-xs font-medium"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {t('settings.general.runningOn')}
              </span>
              <code
                className="rounded px-1.5 py-0.5 font-mono text-xs"
                style={{
                  backgroundColor: 'var(--color-surface)',
                  color: 'var(--color-text)',
                  border: '1px solid var(--color-border)',
                }}
              >
                {serverUrl}
              </code>
              <button
                onClick={handleCopyUrl}
                className="ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/5"
                style={{
                  borderColor: 'var(--color-border)',
                  color: copied ? '#22c55e' : 'var(--color-text-secondary)',
                }}
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? t('common.copied') : t('settings.general.copyUrl')}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <SettingsSectionHeader title={t('settings.general.server')} />
          <div
            className="mb-2 flex items-center gap-3 rounded-md px-3 py-2.5"
            style={{ backgroundColor: 'var(--color-surface-raised)' }}
          >
            <div className="size-2 shrink-0 rounded-full" style={{ backgroundColor: '#22c55e' }} />
            <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
              {t('settings.general.runningOn')}
            </span>
            <code
              className="rounded px-1.5 py-0.5 font-mono text-xs"
              style={{
                backgroundColor: 'var(--color-surface)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
              }}
            >
              {window.location.origin}
            </code>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(window.location.origin);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/5"
              style={{
                borderColor: 'var(--color-border)',
                color: copied ? '#22c55e' : 'var(--color-text-secondary)',
              }}
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? t('common.copied') : t('settings.general.copyUrl')}
            </button>
          </div>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {t('settings.general.standaloneNote')}
          </p>
        </>
      )}
    </div>
  );
};
