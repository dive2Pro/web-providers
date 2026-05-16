import electron from "electron";
import type { DesktopSettingsInput } from "../src/shared/desktop-config";

const { contextBridge, ipcRenderer } = electron;

type BrowserHostBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

contextBridge.exposeInMainWorld("desktopApp", {
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  saveSettings: (settings: DesktopSettingsInput) =>
    ipcRenderer.invoke("desktop:save-settings", settings),
  restartServices: () => ipcRenderer.invoke("desktop:restart-services"),
  getClaudeCommand: (modelId: string) => ipcRenderer.invoke("desktop:get-claude-command", modelId),
  openPath: (kind: "logs" | "bindings" | "config") =>
    ipcRenderer.invoke("desktop:open-path", kind),
  copyText: (value: string) => ipcRenderer.invoke("desktop:copy-text", value),
  getBrowserState: () => ipcRenderer.invoke("desktop:browser-get-state"),
  navigateBrowser: (url: string) => ipcRenderer.invoke("desktop:browser-navigate", url),
  browserBack: () => ipcRenderer.invoke("desktop:browser-back"),
  browserForward: () => ipcRenderer.invoke("desktop:browser-forward"),
  browserReload: () => ipcRenderer.invoke("desktop:browser-reload"),
  createBrowserTab: (input?: { url?: string; provider?: "deepseek-web" | "qwen-web"; activate?: boolean }) =>
    ipcRenderer.invoke("desktop:browser-create-tab", input),
  activateBrowserTab: (tabId: string) => ipcRenderer.invoke("desktop:browser-activate-tab", tabId),
  closeBrowserTab: (tabId: string) => ipcRenderer.invoke("desktop:browser-close-tab", tabId),
  setBrowserBounds: (bounds: BrowserHostBounds) =>
    ipcRenderer.invoke("desktop:browser-set-bounds", bounds),
  onBrowserState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on("desktop:browser-state", listener);
    return () => ipcRenderer.removeListener("desktop:browser-state", listener);
  },
  onRequestBrowserBoundsSync: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("desktop:browser-request-bounds-sync", listener);
    return () => ipcRenderer.removeListener("desktop:browser-request-bounds-sync", listener);
  },
});
