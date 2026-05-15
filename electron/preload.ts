import electron from "electron";
import type { DesktopSettingsInput } from "../src/shared/desktop-config";

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("desktopApp", {
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  saveSettings: (settings: DesktopSettingsInput) =>
    ipcRenderer.invoke("desktop:save-settings", settings),
  restartServices: () => ipcRenderer.invoke("desktop:restart-services"),
  getClaudeCommand: (modelId: string) => ipcRenderer.invoke("desktop:get-claude-command", modelId),
  openPath: (kind: "logs" | "bindings" | "config") =>
    ipcRenderer.invoke("desktop:open-path", kind),
  copyText: (value: string) => ipcRenderer.invoke("desktop:copy-text", value),
});
