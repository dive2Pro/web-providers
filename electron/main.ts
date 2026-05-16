import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import type { FastifyInstance } from "fastify";
import { buildGatewayApp } from "../src/gateway/app";
import { buildApp as buildHelperApp } from "../src/helper/app";
import { BbBrowserClient } from "../src/helper/browser/bb-browser-client";
import {
  buildClaudeCodeLaunchConfig,
  buildClaudeCodeGuide,
  buildClaudeCodeStartupCommand,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_HELPER_PORT,
  createDesktopConfig,
  deserializeDesktopConfig,
  mergeDesktopSettings,
  toPublicDesktopConfig,
  type DesktopConfig,
  type DesktopSettingsInput,
} from "../src/shared/desktop-config";
import { logServiceStarted } from "../src/shared/startup-log";
import { createEmbeddedBrowserTransport } from "./embedded-browser-transport";

const { app, BrowserWindow, WebContentsView, clipboard, ipcMain, shell } = electron;

type RunningServices = {
  helperApp: FastifyInstance;
  gatewayApp: FastifyInstance;
  helperUrl: string;
  gatewayUrl: string;
  startedAt: string;
  notice: string | null;
};

type BrowserHostBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DesktopBrowserTabState = {
  id: string;
  url: string;
  title: string;
  isLoading: boolean;
  lastError: string | null;
};

type DesktopBrowserState = {
  activeTabId: string | null;
  tabs: DesktopBrowserTabState[];
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  lastError: string | null;
};

type BrowserTabRecord = {
  id: string;
  view: InstanceType<typeof WebContentsView>;
  state: DesktopBrowserTabState;
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BROWSER_URL = "https://chat.deepseek.com/";
const BROWSER_PARTITION = "persist:web-providers-browser";
const EMBEDDED_BROWSER_USER_AGENT = buildEmbeddedBrowserUserAgent();

let mainWindow: BrowserWindow | null = null;
let browserTabs = new Map<string, BrowserTabRecord>();
let activeBrowserTabId: string | null = null;
let browserTabSequence = 0;
let browserHostBounds: BrowserHostBounds = { x: 0, y: 0, width: 0, height: 0 };
let desktopConfig: DesktopConfig = createDesktopConfig();
let runningServices: RunningServices | null = null;
let lastServiceError: string | null = null;
let lastServiceNotice: string | null = null;
let isQuitting = false;
let browserHostReadyResolver: (() => void) | null = null;
let browserHostReadyPromise: Promise<void> | null = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

app.userAgentFallback = EMBEDDED_BROWSER_USER_AGENT;

await app.whenReady();
desktopConfig = await loadDesktopConfig();
await restartServices();
registerIpcHandlers();
createMainWindow();

app.on("second-instance", () => {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", (event) => {
  if (!runningServices) {
    return;
  }

  event.preventDefault();
  void stopServices().finally(() => {
    runningServices = null;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !isQuitting) {
    void app.quit();
  }
});

function registerIpcHandlers() {
  ipcMain.handle("desktop:get-state", async () => getDesktopState());
  ipcMain.handle(
    "desktop:save-settings",
    async (_event, settings: DesktopSettingsInput) => {
      desktopConfig = mergeDesktopSettings(desktopConfig, settings);
      await saveDesktopConfig(desktopConfig);
      return restartServices();
    },
  );
  ipcMain.handle("desktop:restart-services", async () => restartServices());
  ipcMain.handle("desktop:get-claude-command", async (_event, modelId: string) =>
    getClaudeCodeCommand(modelId),
  );
  ipcMain.handle("desktop:copy-text", async (_event, value: string) => {
    clipboard.writeText(value);
  });
  ipcMain.handle("desktop:open-path", async (_event, kind: "logs" | "bindings" | "config") => {
    const paths = getRuntimePaths();
    const targetPath =
      kind === "logs"
        ? paths.requestLogDir
        : kind === "bindings"
          ? paths.sessionBindingDir
          : paths.configPath;
    await mkdir(kind === "config" ? dirname(targetPath) : targetPath, {
      recursive: true,
    });
    return shell.openPath(targetPath);
  });
  ipcMain.handle("desktop:browser-get-state", async () => getDesktopBrowserState());
  ipcMain.handle("desktop:browser-navigate", async (_event, target: string) =>
    navigateBrowser(target),
  );
  ipcMain.handle("desktop:browser-back", async () => {
    const activeTab = getActiveBrowserTabRecord();
    activeTab?.view.webContents.goBack();
    return getDesktopBrowserState();
  });
  ipcMain.handle("desktop:browser-forward", async () => {
    const activeTab = getActiveBrowserTabRecord();
    activeTab?.view.webContents.goForward();
    return getDesktopBrowserState();
  });
  ipcMain.handle("desktop:browser-reload", async () => {
    const activeTab = getActiveBrowserTabRecord();
    activeTab?.view.webContents.reload();
    return getDesktopBrowserState();
  });
  ipcMain.handle(
    "desktop:browser-create-tab",
    async (
      _event,
      input?: { url?: string; provider?: "deepseek-web" | "qwen-web"; activate?: boolean },
    ) => {
      await createBrowserTab({
        url: input?.provider === "qwen-web"
          ? "https://chat.qwen.ai/"
          : input?.provider === "deepseek-web"
            ? DEFAULT_BROWSER_URL
            : input?.url,
        activate: input?.activate ?? true,
      });
      return getDesktopBrowserState();
    },
  );
  ipcMain.handle("desktop:browser-activate-tab", async (_event, tabId: string) => {
    setActiveBrowserTab(tabId);
    return getDesktopBrowserState();
  });
  ipcMain.handle("desktop:browser-close-tab", async (_event, tabId: string) =>
    closeBrowserTab(tabId),
  );
  ipcMain.handle("desktop:browser-set-bounds", async (_event, bounds: BrowserHostBounds) => {
    browserHostBounds = sanitizeBrowserHostBounds(bounds);
    resolveBrowserHostReadyIfNeeded();
    syncBrowserViewBounds();
    return getDesktopBrowserState();
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 960,
    minHeight: 700,
    backgroundColor: "#f4efe4",
    autoHideMenuBar: true,
    show: false,
    title: "Web Providers Desktop",
    webPreferences: {
      preload: join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (browserTabs.size === 0) {
    void createBrowserTab({
      url: DEFAULT_BROWSER_URL,
      activate: true,
    });
  } else {
    for (const tab of browserTabs.values()) {
      addBrowserTabViewToWindow(tab);
    }
    if (!activeBrowserTabId) {
      activeBrowserTabId = browserTabs.keys().next().value ?? null;
    }
    syncBrowserViewBounds();
  }

  void mainWindow.loadFile(join(currentDir, "renderer", "index.html"));
  mainWindow.webContents.on("did-finish-load", () => {
    requestBrowserBoundsSync();
    syncBrowserViewBounds();
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
    requestBrowserBoundsSync();
    syncBrowserViewBounds();
    emitBrowserState();
  });
  for (const eventName of [
    "resize",
    "show",
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
  ] as const) {
    mainWindow.on(eventName, () => {
      requestBrowserBoundsSync();
      syncBrowserViewBounds();
    });
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createBrowserTabRecord(input?: { url?: string }) {
  const url = normalizeBrowserUrl(input?.url ?? DEFAULT_BROWSER_URL);
  const id = `embedded-tab-${++browserTabSequence}`;
  const view = new WebContentsView({
    webPreferences: {
      partition: BROWSER_PARTITION,
    },
  });
  view.setBorderRadius(22);
  view.setVisible(false);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

  const record: BrowserTabRecord = {
    id,
    view,
    state: {
      id,
      url,
      title: "Embedded Browser",
      isLoading: false,
      lastError: null,
    },
  };

  const { webContents } = view;
  webContents.setUserAgent(EMBEDDED_BROWSER_USER_AGENT);
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) {
      void createBrowserTab({ url, activate: true });
      return { action: "deny" };
    }

    void shell.openExternal(url);
    return { action: "deny" };
  });
  attachBrowserTabListeners(record);
  browserTabs.set(record.id, record);
  addBrowserTabViewToWindow(record);
  return record;
}

function addBrowserTabViewToWindow(record: BrowserTabRecord) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.contentView.addChildView(record.view);
}

function attachBrowserTabListeners(record: BrowserTabRecord) {
  const { webContents } = record.view;

  webContents.on("page-title-updated", (_event, title) => {
    record.state.title = title || "Embedded Browser";
    emitBrowserState();
  });
  webContents.on("did-start-loading", () => {
    record.state.isLoading = true;
    record.state.lastError = null;
    syncBrowserTabStateFromWebContents(record.id);
  });
  webContents.on("did-stop-loading", () => {
    record.state.isLoading = false;
    syncBrowserTabStateFromWebContents(record.id);
  });
  webContents.on("did-navigate", (_event, url) => {
    record.state.url = url;
    record.state.lastError = null;
    syncBrowserTabStateFromWebContents(record.id);
  });
  webContents.on("did-navigate-in-page", (_event, url) => {
    record.state.url = url;
    syncBrowserTabStateFromWebContents(record.id);
  });
  webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) {
        return;
      }

      record.state.url = validatedUrl || record.state.url;
      record.state.isLoading = false;
      record.state.lastError = errorDescription || "Failed to load page";
      syncBrowserTabStateFromWebContents(record.id);
    },
  );
}

function getBrowserTabRecord(tabId: string) {
  return browserTabs.get(tabId) ?? null;
}

function getActiveBrowserTabRecord() {
  return activeBrowserTabId ? getBrowserTabRecord(activeBrowserTabId) : null;
}

function listBrowserTabStates() {
  return [...browserTabs.values()].map((tab) => ({ ...tab.state }));
}

function getDesktopBrowserState(): DesktopBrowserState {
  const activeTab = getActiveBrowserTabRecord();
  const webContents = activeTab?.view.webContents ?? null;

  return {
    activeTabId: activeTab?.id ?? null,
    tabs: listBrowserTabStates(),
    url: activeTab?.state.url ?? DEFAULT_BROWSER_URL,
    title: activeTab?.state.title ?? "Embedded Browser",
    canGoBack: webContents ? webContents.navigationHistory.canGoBack() : false,
    canGoForward: webContents ? webContents.navigationHistory.canGoForward() : false,
    isLoading: activeTab?.state.isLoading ?? false,
    lastError: activeTab?.state.lastError ?? null,
  };
}

function emitBrowserState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("desktop:browser-state", getDesktopBrowserState());
}

function requestBrowserBoundsSync() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("desktop:browser-request-bounds-sync");
}

function sanitizeBrowserHostBounds(bounds: BrowserHostBounds): BrowserHostBounds {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

function hasRenderableBrowserHostBounds() {
  return browserHostBounds.width > 0 && browserHostBounds.height > 0;
}

function ensureBrowserHostReadyPromise() {
  if (hasRenderableBrowserHostBounds()) {
    return Promise.resolve();
  }

  if (!browserHostReadyPromise) {
    browserHostReadyPromise = new Promise<void>((resolve) => {
      browserHostReadyResolver = resolve;
    });
  }

  return browserHostReadyPromise;
}

function resolveBrowserHostReadyIfNeeded() {
  if (!hasRenderableBrowserHostBounds()) {
    return;
  }

  browserHostReadyResolver?.();
  browserHostReadyResolver = null;
  browserHostReadyPromise = null;
}

function syncBrowserViewBounds() {
  const hasRenderableArea = hasRenderableBrowserHostBounds();
  for (const tab of browserTabs.values()) {
    const isActive = tab.id === activeBrowserTabId && hasRenderableArea;
    tab.view.setVisible(isActive);
    tab.view.setBounds(
      isActive
        ? browserHostBounds
        : { x: 0, y: 0, width: 0, height: 0 },
    );
  }
}

async function navigateBrowser(target: string) {
  const activeTab = getActiveBrowserTabRecord() ?? await createBrowserTab({
    url: DEFAULT_BROWSER_URL,
    activate: true,
  });
  return navigateBrowserInTab(activeTab.id, target);
}

async function navigateBrowserInTab(tabId: string, target: string) {
  const tab = getBrowserTabRecord(tabId) ?? createBrowserTabRecord({ url: target });
  if (!browserTabs.has(tab.id)) {
    browserTabs.set(tab.id, tab);
  }
  const nextUrl = normalizeBrowserUrl(target);
  tab.state.url = nextUrl;
  tab.state.isLoading = true;
  tab.state.lastError = null;
  if (activeBrowserTabId !== tab.id) {
    setActiveBrowserTab(tab.id);
  }
  emitBrowserState();
  if (!hasRenderableBrowserHostBounds()) {
    await ensureBrowserHostReadyPromise();
  }
  await tab.view.webContents.loadURL(nextUrl);
  syncBrowserTabStateFromWebContents(tab.id);
  return getDesktopBrowserState();
}

function syncBrowserTabStateFromWebContents(tabId: string) {
  const tab = getBrowserTabRecord(tabId);

  if (!tab) {
    return;
  }

  const { webContents } = tab.view;
  tab.state = {
    ...tab.state,
    url: webContents.getURL() || tab.state.url,
    title: webContents.getTitle() || tab.state.title,
    isLoading: webContents.isLoading(),
  };
  emitBrowserState();
}

function setActiveBrowserTab(tabId: string) {
  if (!browserTabs.has(tabId)) {
    return;
  }

  activeBrowserTabId = tabId;
  syncBrowserViewBounds();
  emitBrowserState();
}

async function createBrowserTab(input?: { url?: string; activate?: boolean }) {
  const record = createBrowserTabRecord({
    url: input?.url ?? DEFAULT_BROWSER_URL,
  });
  if (input?.activate ?? true) {
    activeBrowserTabId = record.id;
  } else if (!activeBrowserTabId) {
    activeBrowserTabId = record.id;
  }

  syncBrowserViewBounds();
  emitBrowserState();
  await navigateBrowserInTab(record.id, record.state.url);
  return record;
}

async function closeBrowserTab(tabId: string) {
  const record = getBrowserTabRecord(tabId);
  if (!record) {
    return getDesktopBrowserState();
  }

  const existingTabIds = [...browserTabs.keys()];
  const index = existingTabIds.indexOf(tabId);
  let replacementTabId =
    activeBrowserTabId === tabId
      ? (existingTabIds[index + 1] ?? existingTabIds[index - 1] ?? null)
      : activeBrowserTabId;

  if (existingTabIds.length === 1) {
    const replacement = await createBrowserTab({
      url: DEFAULT_BROWSER_URL,
      activate: false,
    });
    replacementTabId = replacement.id;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(record.view);
  }

  browserTabs.delete(tabId);
  if (!record.view.webContents.isDestroyed()) {
    record.view.webContents.destroy();
  }

  activeBrowserTabId = replacementTabId;
  syncBrowserViewBounds();
  emitBrowserState();
  return getDesktopBrowserState();
}

function normalizeBrowserUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_BROWSER_URL;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return new URL(`https://${trimmed}`).toString();
  }
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function buildEmbeddedBrowserUserAgent() {
  const chromeVersion = process.versions.chrome || "136.0.0.0";
  return [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "AppleWebKit/537.36 (KHTML, like Gecko)",
    `Chrome/${chromeVersion}`,
    "Safari/537.36",
  ].join(" ");
}

async function loadDesktopConfig() {
  const { configPath } = getRuntimePaths();
  try {
    const content = await readFile(configPath, "utf8");
    return deserializeDesktopConfig(JSON.parse(content) as unknown);
  } catch {
    const fresh = createDesktopConfig();
    await saveDesktopConfig(fresh);
    return fresh;
  }
}

async function saveDesktopConfig(config: DesktopConfig) {
  const { configPath } = getRuntimePaths();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function restartServices() {
  await stopServices();

  try {
    runningServices = await startServices(desktopConfig);
    lastServiceError = null;
    lastServiceNotice = runningServices.notice;
  } catch (error) {
    runningServices = null;
    lastServiceError = toErrorMessage(error);
    lastServiceNotice = null;
  }

  return getDesktopState();
}

async function stopServices() {
  if (!runningServices) {
    return;
  }

  const current = runningServices;
  runningServices = null;
  await Promise.allSettled([current.gatewayApp.close(), current.helperApp.close()]);
}

async function startServices(config: DesktopConfig): Promise<RunningServices> {
  const { requestLogDir, sessionBindingDir } = getRuntimePaths();
  await mkdir(requestLogDir, { recursive: true });
  await mkdir(sessionBindingDir, { recursive: true });
  const helperPort = await resolveAvailablePort(DEFAULT_HELPER_PORT);
  const gatewayPort = await resolveAvailablePort(
    DEFAULT_GATEWAY_PORT,
    helperPort === DEFAULT_GATEWAY_PORT ? helperPort + 1 : DEFAULT_GATEWAY_PORT,
  );
  const fallbackMessages: string[] = [];
  if (helperPort !== DEFAULT_HELPER_PORT) {
    fallbackMessages.push(
      `Helper port ${DEFAULT_HELPER_PORT} was busy, using ${helperPort} instead.`,
    );
  }
  if (gatewayPort !== DEFAULT_GATEWAY_PORT) {
    fallbackMessages.push(
      `Gateway port ${DEFAULT_GATEWAY_PORT} was busy, using ${gatewayPort} instead.`,
    );
  }

  const browserClient = new BbBrowserClient(
    createEmbeddedBrowserTransport({
      getTabById: (tabId) => {
        const tab = getBrowserTabRecord(tabId);
        return tab
          ? {
              id: tab.id,
              url: tab.state.url,
              webContents: tab.view.webContents,
            }
          : null;
      },
      listTabs: () =>
        [...browserTabs.values()].map((tab) => ({
          id: tab.id,
          url: tab.state.url,
          webContents: tab.view.webContents,
        })),
      getActiveTab: () => {
        const tab = getActiveBrowserTabRecord();
        return tab
          ? {
              id: tab.id,
              url: tab.state.url,
              webContents: tab.view.webContents,
            }
          : null;
      },
      createTab: async (url) => {
        const tab = await createBrowserTab({
          url,
          activate: true,
        });
        return {
          id: tab.id,
          url: tab.state.url,
          webContents: tab.view.webContents,
        };
      },
    }),
  );
  const helperApp = buildHelperApp({
    token: config.helperToken,
    browserClient,
    requestLogDir,
    sessionBindingDir,
  });

  let helperUrl = "";
  let gatewayApp: FastifyInstance | null = null;

  try {
    helperUrl = await helperApp.listen({
      host: "127.0.0.1",
      port: helperPort,
    });
    logServiceStarted("helper", helperUrl);

    gatewayApp = buildGatewayApp({
      openAiToken: config.gatewayToken,
      anthropicToken: config.gatewayToken,
      helperBaseUrl: helperUrl,
      helperToken: config.helperToken,
      requestLogDir,
    });

    const gatewayUrl = await gatewayApp.listen({
      host: "127.0.0.1",
      port: gatewayPort,
    });
    logServiceStarted("gateway", gatewayUrl);

    return {
      helperApp,
      gatewayApp,
      helperUrl,
      gatewayUrl,
      startedAt: new Date().toISOString(),
      notice: fallbackMessages.length > 0 ? fallbackMessages.join(" ") : null,
    };
  } catch (error) {
    await Promise.allSettled([
      gatewayApp?.close(),
      helperApp.close(),
    ]);
    throw error;
  }
}

function getDesktopState() {
  const { requestLogDir, sessionBindingDir, configPath } = getRuntimePaths();
  const gatewayUrl =
    runningServices?.gatewayUrl ?? `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;

  return {
    config: toPublicDesktopConfig(desktopConfig),
    service: {
      running: Boolean(runningServices),
      helperUrl: runningServices?.helperUrl ?? null,
      gatewayUrl: runningServices?.gatewayUrl ?? null,
      startedAt: runningServices?.startedAt ?? null,
      lastError: lastServiceError,
      notice: lastServiceNotice,
      requestLogDir,
      sessionBindingDir,
      configPath,
    },
    claudeCode: buildClaudeCodeGuide({
      gatewayUrl,
      gatewayToken: desktopConfig.gatewayToken,
    }),
  };
}

async function getClaudeCodeCommand(modelId: string) {
  if (!runningServices?.gatewayUrl) {
    throw new Error("Start the desktop services before copying the Claude Code command.");
  }

  const launchConfig = buildClaudeCodeLaunchConfig({
    claudeConfigDir: "$PWD/.claude-web-providers",
    gatewayUrl: runningServices.gatewayUrl,
    gatewayToken: desktopConfig.gatewayToken,
    modelId,
  });

  return buildClaudeCodeStartupCommand(launchConfig);
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getRuntimePaths() {
  const desktopRootDir = join(app.getPath("userData"), "desktop-runtime");

  return {
    requestLogDir: join(desktopRootDir, "request-logs"),
    sessionBindingDir: join(desktopRootDir, "session-bindings"),
    configPath: join(app.getPath("userData"), "desktop-config.json"),
  };
}

async function resolveAvailablePort(preferredPort: number, startPort = preferredPort) {
  for (let port = startPort; port <= 65535; port += 1) {
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }

  throw new Error(`No available port found starting from ${startPort}.`);
}

function isPortAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "127.0.0.1");
  });
}
