/**
 * Main process entry point for claude-devtools.
 *
 * Responsibilities:
 * - Initialize Electron app and main window
 * - Set up IPC handlers for data access
 * - Initialize ServiceContextRegistry with local context
 * - Start file watcher for live updates
 * - Manage application lifecycle
 */

import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  DEV_SERVER_PORT,
  getTrafficLightPositionForZoom,
  WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL,
} from '@shared/constants';
import { createLogger } from '@shared/utils/logger';
import { app, BrowserWindow, ipcMain } from 'electron';
import { existsSync } from 'fs';
import { homedir, totalmem } from 'os';
import { join } from 'path';

import { initializeIpcHandlers, removeIpcHandlers } from './ipc/handlers';
import { shouldForwardContextFileChange } from './utils/contextEventForwarding';
import { getClaudeBasePath, getProjectsBasePath, getTodosBasePath } from './utils/pathDecoder';
import { detectBackend } from './backends';

import type { DataBackendName } from '@shared/types/api';

// Dynamic renderer heap limit — proportional to system RAM so low-end devices
// are not starved.  50% of total RAM, clamped to [2 GB, 4 GB].
// Must run before app.whenReady() so the flag is picked up by the renderer.
const totalMB = Math.floor(totalmem() / (1024 * 1024));
const heapMB = Math.min(4096, Math.max(2048, Math.floor(totalMB * 0.5)));
app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${heapMB}`);

// Window icon path for non-mac platforms.
const getWindowIconPath = (): string | undefined => {
  const isDev = process.env.NODE_ENV === 'development';
  const candidates = isDev
    ? [join(process.cwd(), 'resources/icon.png')]
    : [
        join(process.resourcesPath, 'resources/icon.png'),
        join(__dirname, '../../resources/icon.png'),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

const logger = createLogger('App');
// IPC channel constants (duplicated from @preload to avoid boundary violation)
const SSH_STATUS = 'ssh:status';
const CONTEXT_CHANGED = 'context:changed';
const CONTEXT_FILE_CHANGE = 'context-file-change';
const HTTP_SERVER_START = 'httpServer:start';
const HTTP_SERVER_STOP = 'httpServer:stop';
const HTTP_SERVER_GET_STATUS = 'httpServer:getStatus';

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection in main process:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in main process:', error);
});

import { HttpServer } from './services/infrastructure/HttpServer';
import {
  configManager,
  configManagerPromise,
  LocalFileSystemProvider,
  NotificationManager,
  ServiceContext,
  ServiceContextRegistry,
  SshConnectionManager,
  UpdaterService,
} from './services';

// =============================================================================
// Application State
// =============================================================================

let mainWindow: BrowserWindow | null = null;

// Service registry and global services
let contextRegistry: ServiceContextRegistry;
let notificationManager: NotificationManager;
let updaterService: UpdaterService;
let sshConnectionManager: SshConnectionManager;
let httpServer: HttpServer;

// File watcher event cleanup functions
let fileChangeCleanup: (() => void) | null = null;
let todoChangeCleanup: (() => void) | null = null;
let memoryChangeCleanup: (() => void) | null = null;

// Context-tagged file-change listener cleanups, keyed by context ID.
// One entry per local-type context (primary 'local' + secondary 'local-{backend}').
const contextFileChangeCleanups = new Map<string, () => void>();

/**
 * Resolve production renderer index path.
 * Main bundle lives in dist-electron/main, while renderer lives in out/renderer.
 */
function getRendererIndexPath(): string {
  const candidates = [
    join(__dirname, '../../out/renderer/index.html'),
    join(__dirname, '../renderer/index.html'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * Wires file watcher events from a ServiceContext to the renderer and HTTP SSE clients.
 * Cleans up previous listeners before adding new ones.
 */
function wireFileWatcherEvents(context: ServiceContext): void {
  logger.info(`Wiring FileWatcher events for context: ${context.id}`);

  // Clean up previous listeners
  if (fileChangeCleanup) {
    fileChangeCleanup();
    fileChangeCleanup = null;
  }
  if (todoChangeCleanup) {
    todoChangeCleanup();
    todoChangeCleanup = null;
  }
  if (memoryChangeCleanup) {
    memoryChangeCleanup();
    memoryChangeCleanup = null;
  }

  // Wire file-change events to renderer and HTTP SSE
  const fileChangeHandler = (event: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file-change', event);
    }
    httpServer?.broadcast('file-change', event);
  };
  context.fileWatcher.on('file-change', fileChangeHandler);
  fileChangeCleanup = () => context.fileWatcher.off('file-change', fileChangeHandler);

  // Forward checklist-change events to renderer and HTTP SSE (mirrors file-change pattern above)
  const todoChangeHandler = (event: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('todo-change', event);
    }
    httpServer?.broadcast('todo-change', event);
  };
  context.fileWatcher.on('todo-change', todoChangeHandler);
  todoChangeCleanup = () => context.fileWatcher.off('todo-change', todoChangeHandler);

  // Forward memory-change events to renderer and HTTP SSE
  const memoryChangeHandler = (event: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('memory:changed', event);
    }
    httpServer?.broadcast('memory:changed', event);
  };
  context.fileWatcher.on('memory-change', memoryChangeHandler);
  memoryChangeCleanup = () => context.fileWatcher.off('memory-change', memoryChangeHandler);

  logger.info(`FileWatcher events wired for context: ${context.id}`);
}

/**
 * Wires context-tagged file-change events for a local-type context so the
 * aggregate "All" view can live-update from every backend, not just the
 * active one. Events are sent as `{ contextId, event }` on the
 * 'context-file-change' channel (renderer + HTTP SSE).
 *
 * Events are skipped while the context is active — the active context's
 * events already flow through the untagged 'file-change' wiring installed
 * by wireFileWatcherEvents (avoids duplicate refreshes).
 */
function wireContextFileChangeEvents(context: ServiceContext): void {
  // Rewire: drop any listener attached to a previous instance of this context.
  contextFileChangeCleanups.get(context.id)?.();

  const handler = (event: unknown): void => {
    if (!shouldForwardContextFileChange(contextRegistry.getActiveContextId(), context.id)) {
      return;
    }
    const payload = { contextId: context.id, event };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CONTEXT_FILE_CHANGE, payload);
    }
    httpServer?.broadcast(CONTEXT_FILE_CHANGE, payload);
  };
  context.fileWatcher.on('file-change', handler);
  contextFileChangeCleanups.set(context.id, () =>
    context.fileWatcher.off('file-change', handler)
  );

  logger.info(`Context-tagged file-change events wired for context: ${context.id}`);
}

/**
 * Handles mode switch requests from the HTTP server.
 * Switches the active context back to local when requested.
 */
async function handleModeSwitch(mode: 'local' | 'ssh'): Promise<void> {
  if (mode === 'local' && contextRegistry.getActiveContextId() !== 'local') {
    const { current } = contextRegistry.switch('local');
    onContextSwitched(current);
  }
}

/**
 * Re-wires file watcher events only. No renderer notification.
 * Used for renderer-initiated switches where the renderer already handles state.
 */
export function rewireContextEvents(context: ServiceContext): void {
  wireFileWatcherEvents(context);
}

/**
 * Full callback: re-wire + notify renderer.
 * Used for external/unexpected switches (e.g., HTTP server mode switch).
 */
function onContextSwitched(context: ServiceContext): void {
  rewireContextEvents(context);

  // Notify renderer of context change
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(SSH_STATUS, sshConnectionManager.getStatus());
    mainWindow.webContents.send(CONTEXT_CHANGED, {
      id: context.id,
      type: context.type,
    });
  }
}

interface KnownDataRootEntry {
  backend: DataBackendName;
  dirName: string;
}

/**
 * Known local data roots for Claude Code, Kimi Code, and Codex CLI.
 */
const KNOWN_DATA_ROOTS: KnownDataRootEntry[] = [
  { backend: 'claude', dirName: '.claude' },
  { backend: 'kimi', dirName: '.kimi-code' },
  { backend: 'codex', dirName: '.codex' },
];

/**
 * Resolve projects/sessions directory and backend identifier for a data root.
 */
function getContextDirsForRoot(
  rootPath: string
): { projectsDir: string; todosDir: string; backend: DataBackendName } {
  const fsProvider = new LocalFileSystemProvider();
  const backend = detectBackend(rootPath, fsProvider) ?? 'claude';
  const sessionsDirName = backend === 'kimi' || backend === 'codex' ? 'sessions' : 'projects';
  return {
    projectsDir: join(rootPath, sessionsDirName),
    todosDir: join(rootPath, 'todos'),
    backend,
  };
}

/**
 * Create a secondary local context for the given data root.
 */
function createSecondaryLocalContext(
  rootPath: string,
  backend: DataBackendName,
  contextId: string
): ServiceContext {
  const { projectsDir, todosDir } = getContextDirsForRoot(rootPath);
  return new ServiceContext({
    id: contextId,
    type: 'local',
    fsProvider: new LocalFileSystemProvider(),
    projectsDir,
    todosDir,
    backend,
  });
}

/**
 * Rebuild the set of secondary local contexts (local-claude/kimi/codex) based on the
 * current primary root. Call after primary root changes.
 */
function rebuildSecondaryLocalContexts(primaryRootPath: string): void {
  if (!contextRegistry) {
    return;
  }

  // Dispose existing secondary contexts. If one is currently active, switch to 'local' first.
  const secondaryIds = contextRegistry
    .list()
    .map((ctx) => ctx.id)
    .filter((id) => id.startsWith('local-'));
  for (const id of secondaryIds) {
    try {
      // Drop the context-tagged listener before disposing the context.
      contextFileChangeCleanups.get(id)?.();
      contextFileChangeCleanups.delete(id);
      if (contextRegistry.getActiveContextId() === id) {
        contextRegistry.switch('local');
      }
      contextRegistry.destroy(id);
    } catch (error) {
      logger.error(`Failed to destroy secondary context "${id}":`, error);
    }
  }

  // Register a context for each known root that exists and is not the primary root.
  const home = homedir();
  for (const { backend, dirName } of KNOWN_DATA_ROOTS) {
    const rootPath = join(home, dirName);
    if (!existsSync(rootPath) || rootPath === primaryRootPath) {
      continue;
    }
    try {
      const context = createSecondaryLocalContext(rootPath, backend, `local-${backend}`);
      contextRegistry.registerContext(context);
      if (notificationManager) {
        context.fileWatcher.setNotificationManager(notificationManager);
      }
      context.start();
      // Keep watching even while inactive — tagged events feed the aggregate view.
      wireContextFileChangeEvents(context);
      logger.info(`Registered secondary local context: ${context.id} (${rootPath})`);
    } catch (error) {
      logger.error(`Failed to register secondary context for ${rootPath}:`, error);
    }
  }
}

/**
 * Rebuilds the local ServiceContext using the current configured Claude root paths.
 * Called when general.claudeRootPath changes.
 */
function reconfigureLocalContextForClaudeRoot(): void {
  try {
    // When DATA_ROOT is set explicitly, we never fall back to the configured Claude root.
    if (process.env.DATA_ROOT) {
      logger.info('Skipping Claude root reconfiguration because DATA_ROOT is set');
      return;
    }

    const currentLocal = contextRegistry.get('local');
    if (!currentLocal) {
      logger.error('Cannot reconfigure local context: local context not found');
      return;
    }

    const wasLocalActive = contextRegistry.getActiveContextId() === 'local';
    const primaryRootPath = getClaudeBasePath();
    const projectsDir = getProjectsBasePath();
    const todosDir = getTodosBasePath();

    logger.info(`Reconfiguring local context: projectsDir=${projectsDir}, todosDir=${todosDir}`);

    if (wasLocalActive) {
      currentLocal.stopFileWatcher();
    }

    const replacementLocal = new ServiceContext({
      id: 'local',
      type: 'local',
      fsProvider: new LocalFileSystemProvider(),
      projectsDir,
      todosDir,
      backend: detectBackend(primaryRootPath, new LocalFileSystemProvider()) ?? 'claude',
    });

    if (notificationManager) {
      replacementLocal.fileWatcher.setNotificationManager(notificationManager);
    }
    replacementLocal.start();

    contextRegistry.replaceContext('local', replacementLocal);

    if (wasLocalActive) {
      wireFileWatcherEvents(replacementLocal);
    }
    // The primary 'local' context keeps watching even while inactive
    // (same as secondary local contexts) so the aggregate "All" view
    // receives live updates from it too.
    wireContextFileChangeEvents(replacementLocal);

    // Rebuild secondary contexts to match the new primary root.
    rebuildSecondaryLocalContexts(primaryRootPath);
  } catch (error) {
    logger.error('Failed to reconfigure local context for Claude root change:', error);
  }
}

/**
 * Initializes all services.
 */
function initializeServices(): void {
  logger.info('Initializing services...');

  // Initialize SSH connection manager
  sshConnectionManager = new SshConnectionManager();

  // Create ServiceContextRegistry
  contextRegistry = new ServiceContextRegistry();

  const dataRoot = process.env.DATA_ROOT;
  let primaryRootPath: string;
  let localProjectsDir: string;
  let localTodosDir: string;

  if (dataRoot) {
    primaryRootPath = dataRoot;
    const backendName = detectBackend(dataRoot, new LocalFileSystemProvider());
    switch (backendName) {
      case 'kimi':
      case 'codex':
        localProjectsDir = join(dataRoot, 'sessions');
        localTodosDir = join(dataRoot, 'todos');
        break;
      case 'claude':
      default:
        localProjectsDir = join(dataRoot, 'projects');
        localTodosDir = join(dataRoot, 'todos');
    }
    logger.info(`Using DATA_ROOT: ${dataRoot} (backend: ${backendName ?? 'unknown'})`);
  } else {
    primaryRootPath = getClaudeBasePath();
    localProjectsDir = getProjectsBasePath();
    localTodosDir = getTodosBasePath();
  }

  // Initialize notification manager (singleton, not context-scoped) before contexts start
  notificationManager = NotificationManager.getInstance();

  // Create local context
  const localContext = new ServiceContext({
    id: 'local',
    type: 'local',
    fsProvider: new LocalFileSystemProvider(),
    projectsDir: localProjectsDir,
    todosDir: localTodosDir,
    backend: detectBackend(primaryRootPath, new LocalFileSystemProvider()) ?? 'claude',
  });

  // Register and start local context
  contextRegistry.registerContext(localContext);
  localContext.start();

  logger.info(`Projects directory: ${localContext.projectScanner.getProjectsDir()}`);

  // Set notification manager on local context's file watcher
  localContext.fileWatcher.setNotificationManager(notificationManager);

  // Wire file watcher events for local context
  wireFileWatcherEvents(localContext);
  // Also forward context-tagged events for when 'local' is not the active
  // context (aggregate "All" view live updates).
  wireContextFileChangeEvents(localContext);

  // Register secondary contexts for other detected data roots.
  rebuildSecondaryLocalContexts(primaryRootPath);

  // Initialize updater service
  updaterService = new UpdaterService();
  httpServer = new HttpServer();

  // Initialize IPC handlers with registry
  initializeIpcHandlers(contextRegistry, updaterService, sshConnectionManager, {
    rewire: rewireContextEvents,
    full: onContextSwitched,
    onClaudeRootPathUpdated: (_claudeRootPath: string | null) => {
      reconfigureLocalContextForClaudeRoot();
    },
  });

  // HTTP Server control IPC handlers
  ipcMain.handle(HTTP_SERVER_START, async () => {
    try {
      if (httpServer.isRunning()) {
        return { success: true, data: { running: true, port: httpServer.getPort() } };
      }
      await startHttpServer(handleModeSwitch);
      // Persist the enabled state
      configManager.updateConfig('httpServer', { enabled: true, port: httpServer.getPort() });
      return { success: true, data: { running: true, port: httpServer.getPort() } };
    } catch (error) {
      logger.error('Failed to start HTTP server via IPC:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start server',
      };
    }
  });

  ipcMain.handle(HTTP_SERVER_STOP, async () => {
    try {
      await httpServer.stop();
      // Persist the disabled state
      configManager.updateConfig('httpServer', { enabled: false });
      return { success: true, data: { running: false, port: httpServer.getPort() } };
    } catch (error) {
      logger.error('Failed to stop HTTP server via IPC:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop server',
      };
    }
  });

  ipcMain.handle(HTTP_SERVER_GET_STATUS, () => {
    return { success: true, data: { running: httpServer.isRunning(), port: httpServer.getPort() } };
  });

  // Forward SSH state changes to renderer and HTTP SSE clients
  sshConnectionManager.on('state-change', (status: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(SSH_STATUS, status);
    }
    httpServer.broadcast('ssh:status', status);
  });

  // Forward notification events to HTTP SSE clients
  notificationManager.on('notification-new', (notification: unknown) => {
    httpServer.broadcast('notification:new', notification);
  });
  notificationManager.on('notification-updated', (data: unknown) => {
    httpServer.broadcast('notification:updated', data);
  });
  notificationManager.on('notification-clicked', (data: unknown) => {
    httpServer.broadcast('notification:clicked', data);
  });

  // Start HTTP server if enabled in config
  const appConfig = configManager.getConfig();
  if (appConfig.httpServer?.enabled) {
    void startHttpServer(handleModeSwitch);
  }

  logger.info('Services initialized successfully');
}

/**
 * Starts the HTTP sidecar server with services from the active context.
 */
async function startHttpServer(
  modeSwitchHandler: (mode: 'local' | 'ssh') => Promise<void>
): Promise<void> {
  try {
    const config = configManager.getConfig();
    const activeContext = contextRegistry.getActive();
    const port = await httpServer.start(
      {
        projectScanner: activeContext.projectScanner,
        sessionParser: activeContext.sessionParser,
        subagentResolver: activeContext.subagentResolver,
        chunkBuilder: activeContext.chunkBuilder,
        dataCache: activeContext.dataCache,
        memoryReader: activeContext.memoryReader,
        updaterService,
        sshConnectionManager,
        contextRegistry,
      },
      modeSwitchHandler,
      config.httpServer?.port ?? 3456
    );
    logger.info(`HTTP sidecar server running on port ${port}`);
  } catch (error) {
    logger.error('Failed to start HTTP server:', error);
  }
}

/**
 * Shuts down all services.
 */
function shutdownServices(): void {
  logger.info('Shutting down services...');

  // Stop HTTP server
  if (httpServer?.isRunning()) {
    void httpServer.stop();
  }

  // Clean up file watcher event listeners
  if (fileChangeCleanup) {
    fileChangeCleanup();
    fileChangeCleanup = null;
  }
  if (todoChangeCleanup) {
    todoChangeCleanup();
    todoChangeCleanup = null;
  }
  if (memoryChangeCleanup) {
    memoryChangeCleanup();
    memoryChangeCleanup = null;
  }
  for (const cleanup of contextFileChangeCleanups.values()) {
    cleanup();
  }
  contextFileChangeCleanups.clear();

  // Dispose all contexts (including local)
  if (contextRegistry) {
    contextRegistry.dispose();
  }

  // Dispose SSH connection manager
  if (sshConnectionManager) {
    sshConnectionManager.dispose();
  }

  // Remove IPC handlers
  removeIpcHandlers();

  logger.info('Services shut down successfully');
}

/**
 * Update native traffic-light position and notify renderer of the current zoom factor.
 */
function syncTrafficLightPosition(win: BrowserWindow): void {
  const zoomFactor = win.webContents.getZoomFactor();
  const position = getTrafficLightPositionForZoom(zoomFactor);
  // setWindowButtonPosition is macOS-only (traffic light buttons)
  if (process.platform === 'darwin') {
    win.setWindowButtonPosition(position);
  }
  win.webContents.send(WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL, zoomFactor);
}

/**
 * Creates the main application window.
 */
function createWindow(): void {
  const isMac = process.platform === 'darwin';
  const iconPath = isMac ? undefined : getWindowIconPath();
  const useNativeTitleBar = !isMac && configManager.getConfig().general.useNativeTitleBar;
  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
    backgroundColor: '#1a1a1a',
    ...(useNativeTitleBar ? {} : { titleBarStyle: 'hidden' as const }),
    ...(isMac && { trafficLightPosition: getTrafficLightPositionForZoom(1) }),
    title: 'claude-devtools',
  });

  // Load the renderer
  if (process.env.NODE_ENV === 'development') {
    void mainWindow.loadURL(`http://localhost:${DEV_SERVER_PORT}`);
    mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(getRendererIndexPath()).catch((error: unknown) => {
      logger.error('Failed to load renderer entry HTML:', error);
    });
  }

  // Set traffic light position + notify renderer on first load, and auto-check for updates
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      syncTrafficLightPosition(mainWindow);
      // Auto-check for updates 3 seconds after window loads
      setTimeout(() => updaterService.checkForUpdates(), 3000);
    }
  });

  // Log top-level renderer load failures (helps diagnose blank/black window issues in packaged apps)
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        logger.error(
          `Failed to load renderer (code=${errorCode}): ${errorDescription} - ${validatedURL}`
        );
      }
    }
  );

  // Sync traffic light position when zoom changes (Cmd+/-, Cmd+0)
  // zoom-changed event doesn't fire in Electron 40, so we detect zoom keys directly.
  // Also keeps zoom bounds within a practical readability range.
  const MIN_ZOOM_LEVEL = -3; // ~70%
  const MAX_ZOOM_LEVEL = 5;
  const ZOOM_IN_KEYS = new Set(['+', '=']);
  const ZOOM_OUT_KEYS = new Set(['-', '_']);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (input.type !== 'keyDown') return;

    // Intercept Ctrl+R / Cmd+R to prevent Chromium's built-in page reload,
    // then notify the renderer via IPC so it can refresh the session (fixes #58, #85).
    // We must preventDefault here because Chromium handles Ctrl+R at the browser
    // engine level, which also blocks the keydown from reaching the renderer —
    // hence the IPC bridge.
    if ((input.control || input.meta) && !input.shift && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      mainWindow.webContents.send('session:refresh');
      return;
    }
    // Also block Ctrl+Shift+R (hard reload)
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      return;
    }

    if (!input.meta) return;

    const currentLevel = mainWindow.webContents.getZoomLevel();

    // Block zoom-out beyond minimum
    if (ZOOM_OUT_KEYS.has(input.key) && currentLevel <= MIN_ZOOM_LEVEL) {
      event.preventDefault();
      return;
    }
    // Block zoom-in beyond maximum
    if (ZOOM_IN_KEYS.has(input.key) && currentLevel >= MAX_ZOOM_LEVEL) {
      event.preventDefault();
      return;
    }

    // For zoom keys (including Cmd+0 reset), defer sync until zoom is applied
    if (ZOOM_IN_KEYS.has(input.key) || ZOOM_OUT_KEYS.has(input.key) || input.key === '0') {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          syncTrafficLightPosition(mainWindow);
        }
      }, 100);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Clear main window references
    if (notificationManager) {
      notificationManager.setMainWindow(null);
    }
    if (updaterService) {
      updaterService.setMainWindow(null);
    }
  });

  // Handle renderer process crashes (render-process-gone replaces deprecated 'crashed' event)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process gone:', details.reason, details.exitCode);
    // Could show an error dialog or attempt to reload the window
  });

  // Set main window reference for notification manager and updater
  if (notificationManager) {
    notificationManager.setMainWindow(mainWindow);
  }
  if (updaterService) {
    updaterService.setMainWindow(mainWindow);
  }

  logger.info('Main window created');
}

/**
 * Application ready handler.
 */
void app.whenReady().then(async () => {
  logger.info('App ready, initializing...');
  try {
    // Wait for config to finish loading from disk before using it
    await configManagerPromise;

    // Initialize services first
    initializeServices();

    // Apply configuration settings
    const config = configManager.getConfig();

    // Apply launch at login setting
    app.setLoginItemSettings({
      openAtLogin: config.general.launchAtLogin,
    });

    // Apply dock visibility and icon (macOS)
    if (process.platform === 'darwin') {
      if (!config.general.showDockIcon) {
        app.dock?.hide();
      }
      // macOS app icon is already provided by the signed bundle (.icns)
      // so we avoid runtime setIcon calls that can fail and block startup.
    }

    // Then create window
    createWindow();

    // Listen for notification click events
    notificationManager.on('notification-clicked', (_error) => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (error) {
    logger.error('Startup initialization failed:', error);
    if (!mainWindow) {
      createWindow();
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/**
 * All windows closed handler.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Before quit handler - cleanup.
 */
app.on('before-quit', () => {
  shutdownServices();
});
