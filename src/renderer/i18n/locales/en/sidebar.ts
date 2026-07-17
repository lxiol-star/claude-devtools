/** English strings for the sidebar area. */
export const sidebar: Record<string, string> = {
  // Session list (DateGroupedSessions)
  'sidebar.selectProjectPrompt': 'Select a project to view sessions',
  'sidebar.loadError': 'Error loading sessions',
  'sidebar.noSessions': 'No sessions found',
  'sidebar.noSessionsHint': 'This project has no sessions yet',
  'sidebar.sessions': 'Sessions',
  'sidebar.byContext': 'By Context',
  'sidebar.loadedSoFar':
    '{count} loaded so far — scroll down to load more. Context sorting only ranks loaded sessions.',
  'sidebar.exitSelectionMode': 'Exit selection mode',
  'sidebar.selectSessions': 'Select sessions',
  'sidebar.hideHiddenSessions': 'Hide hidden sessions',
  'sidebar.showHiddenSessions': 'Show hidden sessions',
  'sidebar.sortByContext': 'Sort by context consumption',
  'sidebar.sortByRecent': 'Sort by recent',
  'sidebar.selectedCount': '{count} selected',
  'sidebar.pin': 'Pin',
  'sidebar.hide': 'Hide',
  'sidebar.unhide': 'Unhide',
  'sidebar.pinSelected': 'Pin selected sessions',
  'sidebar.hideSelected': 'Hide selected sessions',
  'sidebar.unhideSelected': 'Unhide selected sessions',
  'sidebar.cancelSelection': 'Cancel selection',
  'sidebar.compare': 'Compare',
  'sidebar.compareSelected': 'Compare selected sessions (2-3)',
  'sidebar.pinned': 'Pinned',
  'sidebar.loadingMore': 'Loading more sessions...',
  'sidebar.scrollToLoadMore': 'Scroll to load more',

  // Date group headers (DateCategory values from utils/dateGrouping)
  'sidebar.dateCategory.today': 'Today',
  'sidebar.dateCategory.yesterday': 'Yesterday',
  'sidebar.dateCategory.previous7Days': 'Previous 7 Days',
  'sidebar.dateCategory.older': 'Older',

  // Session row (SessionItem)
  'sidebar.session': 'Session',
  'sidebar.untitled': 'Untitled',
  'sidebar.totalContextTokens': 'Total Context: {count} tokens',
  'sidebar.contextTokens': 'Context: {count}',
  'sidebar.phase': 'Phase {number}:',
  'sidebar.compactedTo': '(compacted to {count})',

  // Context menu (SessionContextMenu)
  'sidebar.openInCurrentPane': 'Open in Current Pane',
  'sidebar.openInNewTab': 'Open in New Tab',
  'sidebar.splitRightAndOpen': 'Split Right and Open',
  'sidebar.pinSession': 'Pin Session',
  'sidebar.unpinSession': 'Unpin Session',
  'sidebar.hideSession': 'Hide Session',
  'sidebar.unhideSession': 'Unhide Session',
  'sidebar.copied': 'Copied!',
  'sidebar.copySessionId': 'Copy Session ID',
  'sidebar.copyResumeCommand': 'Copy Resume Command',
  'sidebar.click': 'Click',
};
