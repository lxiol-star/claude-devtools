import { analytics } from './analytics';
import { annotations } from './annotations';
import { chat } from './chat';
import { common } from './common';
import { comparison } from './comparison';
import { dashboard } from './dashboard';
import { layout } from './layout';
import { memory } from './memory';
import { notifications } from './notifications';
import { search } from './search';
import { settings } from './settings';
import { sidebar } from './sidebar';

export const zh: Record<string, string> = {
  ...common,
  ...sidebar,
  ...chat,
  ...settings,
  ...layout,
  ...search,
  ...dashboard,
  ...notifications,
  ...memory,
  ...annotations,
  ...analytics,
  ...comparison,
};
