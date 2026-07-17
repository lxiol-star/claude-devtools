import { useMemo, useState } from 'react';

import { isElectronMode } from '@renderer/api';
import { useT } from '@renderer/i18n';
import { Bell, HardDrive, Server, Settings, Wrench } from 'lucide-react';

export type SettingsSection = 'general' | 'connection' | 'workspace' | 'notifications' | 'advanced';

interface SettingsTabsProps {
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}

interface TabConfig {
  id: SettingsSection;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  electronOnly?: boolean;
}

const tabs: TabConfig[] = [
  { id: 'general', labelKey: 'settings.nav.general', icon: Settings },
  { id: 'connection', labelKey: 'settings.nav.connection', icon: Server, electronOnly: true },
  { id: 'workspace', labelKey: 'settings.nav.workspace', icon: HardDrive, electronOnly: true },
  { id: 'notifications', labelKey: 'settings.nav.notifications', icon: Bell },
  { id: 'advanced', labelKey: 'settings.nav.advanced', icon: Wrench },
];

export const SettingsTabs = ({
  activeSection,
  onSectionChange,
}: Readonly<SettingsTabsProps>): React.JSX.Element => {
  const t = useT();
  const [hoveredTab, setHoveredTab] = useState<SettingsSection | null>(null);
  const isElectron = useMemo(() => isElectronMode(), []);
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => !tab.electronOnly || isElectron),
    [isElectron]
  );

  return (
    <div className="inline-flex gap-1 border-b" style={{ borderColor: 'var(--color-border)' }}>
      {visibleTabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeSection === tab.id;
        const isHovered = hoveredTab === tab.id;

        const getTextColor = (): string => {
          if (isActive) return 'var(--color-text)';
          if (isHovered) return 'var(--color-text-secondary)';
          return 'var(--color-text-muted)';
        };

        return (
          <button
            key={tab.id}
            onClick={() => onSectionChange(tab.id)}
            onMouseEnter={() => setHoveredTab(tab.id)}
            onMouseLeave={() => setHoveredTab(null)}
            className={`flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
              isActive ? 'rounded-md font-medium' : ''
            }`}
            style={{
              backgroundColor: isActive ? 'var(--color-surface-raised)' : 'transparent',
              color: getTextColor(),
            }}
          >
            <Icon className="size-4" />
            <span>{t(tab.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
};
