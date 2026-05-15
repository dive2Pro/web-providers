import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import type { FastifyInstance } from "fastify";
import { buildGatewayApp } from "../src/gateway/app";
import { buildApp as buildHelperApp } from "../src/helper/app";
import {
  BbBrowserClient,
  createBbBrowserTransport,
} from "../src/helper/browser/bb-browser-client";
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

const { app, BrowserWindow, clipboard, ipcMain, shell } = electron;

type RunningServices = {
  helperApp: FastifyInstance;
  gatewayApp: FastifyInstance;
  helperUrl: string;
  gatewayUrl: string;
  startedAt: string;
  notice: string | null;
};

const currentDir = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let desktopConfig: DesktopConfig = createDesktopConfig();
let runningServices: RunningServices | null = null;
let lastServiceError: string | null = null;
let lastServiceNotice: string | null = null;
let isQuitting = false;

await app.whenReady();
desktopConfig = await loadDesktopConfig();
await restartServices();
registerIpcHandlers();
createMainWindow();

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

  void mainWindow.loadFile(join(currentDir, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
    app.focus({ steal: true });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
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

  const browserClient = new BbBrowserClient(createBbBrowserTransport());
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
