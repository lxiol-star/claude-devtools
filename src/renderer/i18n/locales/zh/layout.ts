/** layout 分区的中文文案（layout/ 与 common/ 组件）。 */
export const layout: Record<string, string> = {
  // 侧边栏
  'layout.resizeSidebar': '调整侧边栏宽度',
  'layout.selectProject': '选择项目',
  'layout.collapseSidebar': '收起侧边栏（{shortcut}）',
  'layout.expandSidebar': '展开侧边栏',
  'layout.switchRepository': '切换仓库',
  'layout.switchProject': '切换项目',
  'layout.noRepositoriesFound': '未找到仓库',
  'layout.noProjectsFound': '未找到项目',
  'layout.switchWorktree': '切换工作树',
  'layout.other': '其他',

  // 标签栏与标签页
  'layout.refreshSession': '刷新会话（{shortcut}）',
  'layout.newTabDashboard': '新建标签页（仪表盘）',
  'layout.notifications': '通知',
  'layout.openedFromSearch': '从搜索中打开',
  'layout.pinnedSession': '已置顶的会话',
  'layout.closeTab': '关闭标签页',
  'layout.closeTabTooltip': '关闭标签页',
  'layout.closeNTabs': '关闭 {count} 个标签页',
  'layout.closeOtherTabs': '关闭其他标签页',
  'layout.closeAllTabs': '关闭所有标签页',
  'layout.splitRight': '向右拆分',
  'layout.splitLeft': '向左拆分',
  'layout.pinToSidebar': '置顶到侧边栏',
  'layout.unpinFromSidebar': '从侧边栏取消置顶',
  'layout.hideFromSidebar': '在侧边栏中隐藏',
  'layout.unhideFromSidebar': '在侧边栏中显示',
  'layout.renameTab': '重命名标签页',

  // 更多菜单
  'layout.moreActions': '更多操作',
  'layout.exporting': '正在导出…',
  'layout.exportAsMarkdown': '导出为 Markdown',
  'layout.exportAsJson': '导出为 JSON',
  'layout.exportAsPlainText': '导出为纯文本',
  'layout.settings': '设置',

  // 窗口控制与面板
  'layout.minimize': '最小化',
  'layout.maximize': '最大化',
  'layout.restore': '还原',
  'layout.maxPanesReached': '已达到 {count} 个面板的上限',

  // 会话标签页内容
  'layout.loadSessionFailed': '加载会话失败',
  'layout.loadingSession': '正在加载会话…',

  // 对话框与共享组件
  'layout.closeDialog': '关闭对话框',
  'layout.copyToClipboard': '复制到剪贴板',

  // 工作区 / 上下文切换
  'layout.local': '本地',
  'layout.switchingTo': '正在切换到 {context}…',
  'layout.loadingWorkspace': '正在加载工作区',
  'layout.switchWorkspace': '切换工作区',
  'layout.switchSource': '切换数据源',
  'layout.filterAll': '全部',
  'layout.source.local': '本地',
  'layout.source.claude': 'Claude Code',
  'layout.source.kimi': 'Kimi Code',
  'layout.source.codex': 'Codex CLI',
  'layout.sourceShort.claude': 'Claude',
  'layout.sourceShort.kimi': 'Kimi',
  'layout.sourceShort.codex': 'Codex',

  // 错误边界
  'layout.somethingWentWrong': '出错了',
  'layout.unexpectedError': '应用程序遇到意外错误。你可以尝试重新加载页面或重置错误状态。',
  'layout.componentStack': '组件堆栈',
  'layout.tryAgain': '重试',
  'layout.reloadApp': '重新加载应用',

  // 导出
  'layout.exportSession': '导出会话',
  'layout.exportSessionTooltip': '导出会话',
  'layout.formatMarkdown': 'Markdown',
  'layout.formatJson': 'JSON',
  'layout.formatPlainText': '纯文本',
  'layout.formatFixtures': '测试用例',

  // 会话进行中指示器
  'layout.sessionInProgress': '会话进行中',
  'layout.sessionInProgressLabel': '会话进行中…',
  'layout.sessionInProgressBanner': '会话正在进行中…',

  // 仓库下拉菜单
  'layout.selectRepository': '选择仓库…',
  'layout.noRepositoriesAvailable': '没有可用的仓库',
  'layout.sessionCountOne': '{count} 个会话',
  'layout.sessionCountOther': '{count} 个会话',
  'layout.removeRepository': '移除仓库',

  // Token 用量显示
  'layout.visibleContext': '可见上下文',
  'layout.toolOutputs': '工具输出',
  'layout.taskCoordination': '任务协调',
  'layout.userMessages': '用户消息',
  'layout.thinkingPlusText': '思考 + 文本',
  'layout.accumulatedHint': '累计统计整个会话，不重复计算',
  'layout.phaseCount': '阶段 {phase}/{total}',
  'layout.inputTokens': '输入 Token',
  'layout.cacheRead': '缓存读取',
  'layout.cacheWrite': '缓存写入',
  'layout.outputTokens': '输出 Token',
  'layout.total': '总计',
  'layout.inclClaudeMd': '含 CLAUDE.md ×{count}',
  'layout.model': '模型',

  // 更新横幅与对话框
  'layout.updatingApp': '正在更新应用',
  'layout.updateReady': '更新已就绪',
  'layout.restartNow': '立即重启',
  'layout.updateAvailable': '发现新版本',
  'layout.updateAvailableAria': '发现新版本',
  'layout.later': '稍后',
  'layout.download': '下载',

  // 工作树徽章
  'layout.worktreeDefault': '默认',
  'layout.createdBy': '由 {label} 创建',
};
