/** English strings for the layout area (layout/ and common/ components). */
export const layout: Record<string, string> = {
  // Sidebar
  'layout.resizeSidebar': 'Resize sidebar',
  'layout.selectProject': 'Select Project',
  'layout.collapseSidebar': 'Collapse sidebar ({shortcut})',
  'layout.expandSidebar': 'Expand sidebar',
  'layout.switchRepository': 'Switch Repository',
  'layout.switchProject': 'Switch Project',
  'layout.noRepositoriesFound': 'No repositories found',
  'layout.noProjectsFound': 'No projects found',
  'layout.switchWorktree': 'Switch Worktree',
  'layout.other': 'Other',

  // Tab bar & tabs
  'layout.refreshSession': 'Refresh Session ({shortcut})',
  'layout.newTabDashboard': 'New tab (Dashboard)',
  'layout.notifications': 'Notifications',
  'layout.openedFromSearch': 'Opened from search',
  'layout.pinnedSession': 'Pinned session',
  'layout.closeTab': 'Close Tab',
  'layout.closeTabTooltip': 'Close tab',
  'layout.closeNTabs': 'Close {count} Tabs',
  'layout.closeOtherTabs': 'Close Other Tabs',
  'layout.closeAllTabs': 'Close All Tabs',
  'layout.splitRight': 'Split Right',
  'layout.splitLeft': 'Split Left',
  'layout.pinToSidebar': 'Pin to Sidebar',
  'layout.unpinFromSidebar': 'Unpin from Sidebar',
  'layout.hideFromSidebar': 'Hide from Sidebar',
  'layout.unhideFromSidebar': 'Unhide from Sidebar',
  'layout.renameTab': 'Rename Tab',

  // More menu
  'layout.moreActions': 'More actions',
  'layout.exporting': 'Exporting…',
  'layout.exportAsMarkdown': 'Export as Markdown',
  'layout.exportAsJson': 'Export as JSON',
  'layout.exportAsPlainText': 'Export as Plain Text',
  'layout.settings': 'Settings',

  // Window controls & panes
  'layout.minimize': 'Minimize',
  'layout.maximize': 'Maximize',
  'layout.restore': 'Restore',
  'layout.maxPanesReached': 'Maximum {count} panes reached',

  // Session tab content
  'layout.loadSessionFailed': 'Failed to load session',
  'layout.loadingSession': 'Loading session...',

  // Dialogs & shared widgets
  'layout.closeDialog': 'Close dialog',
  'layout.copyToClipboard': 'Copy to clipboard',

  // Workspace / context switching
  'layout.local': 'Local',
  'layout.switchingTo': 'Switching to {context}...',
  'layout.loadingWorkspace': 'Loading workspace',
  'layout.switchWorkspace': 'Switch Workspace',
  'layout.switchSource': 'Switch Data Source',
  'layout.filterAll': 'All',
  'layout.source.local': 'Local',
  'layout.source.claude': 'Claude Code',
  'layout.source.kimi': 'Kimi Code',
  'layout.source.codex': 'Codex CLI',
  'layout.sourceShort.claude': 'Claude',
  'layout.sourceShort.kimi': 'Kimi',
  'layout.sourceShort.codex': 'Codex',

  // Error boundary
  'layout.somethingWentWrong': 'Something went wrong',
  'layout.unexpectedError':
    'An unexpected error occurred in the application. You can try reloading the page or resetting the error state.',
  'layout.componentStack': 'Component Stack',
  'layout.tryAgain': 'Try Again',
  'layout.reloadApp': 'Reload App',

  // Export
  'layout.exportSession': 'Export Session',
  'layout.exportSessionTooltip': 'Export session',
  'layout.formatMarkdown': 'Markdown',
  'layout.formatJson': 'JSON',
  'layout.formatPlainText': 'Plain Text',
  'layout.formatFixtures': 'Test Fixtures',

  // Ongoing session indicator
  'layout.sessionInProgress': 'Session in progress',
  'layout.sessionInProgressLabel': 'Session in progress...',
  'layout.sessionInProgressBanner': 'Session is in progress...',

  // Repository dropdown
  'layout.selectRepository': 'Select repository...',
  'layout.noRepositoriesAvailable': 'No repositories available',
  'layout.sessionCountOne': '{count} session',
  'layout.sessionCountOther': '{count} sessions',
  'layout.removeRepository': 'Remove repository',

  // Token usage display
  'layout.visibleContext': 'Visible Context',
  'layout.toolOutputs': 'Tool Outputs',
  'layout.taskCoordination': 'Task Coordination',
  'layout.userMessages': 'User Messages',
  'layout.thinkingPlusText': 'Thinking + Text',
  'layout.accumulatedHint': 'Accumulated across entire session without duplication',
  'layout.phaseCount': 'Phase {phase}/{total}',
  'layout.inputTokens': 'Input Tokens',
  'layout.cacheRead': 'Cache Read',
  'layout.cacheWrite': 'Cache Write',
  'layout.outputTokens': 'Output Tokens',
  'layout.total': 'Total',
  'layout.inclClaudeMd': 'incl. CLAUDE.md ×{count}',
  'layout.model': 'Model',

  // Update banner & dialog
  'layout.updatingApp': 'Updating app',
  'layout.updateReady': 'Update ready',
  'layout.restartNow': 'Restart now',
  'layout.updateAvailable': 'Update Available',
  'layout.updateAvailableAria': 'Update available',
  'layout.later': 'Later',
  'layout.download': 'Download',

  // Worktree badge
  'layout.worktreeDefault': 'Default',
  'layout.createdBy': 'Created by {label}',
};
