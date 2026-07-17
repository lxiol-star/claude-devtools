/**
 * Accent color per data backend.
 * Used by the source filter chips (SidebarHeader) and the session source
 * badge (SessionItem) so both stay visually consistent.
 */

import type { DataBackendName } from '@shared/types/api';

export const SOURCE_COLORS: Record<DataBackendName, string> = {
  claude: '#a855f7',
  kimi: '#10b981',
  codex: '#3b82f6',
};

/** Display order for backend chips in the source filter row. */
export const SOURCE_ORDER: DataBackendName[] = ['claude', 'kimi', 'codex'];
