import electron from "electron";
import type { DesktopSettingsInput } from "../src/shared/desktop-config";

const { clipboard, contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("desktopApp", {
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  saveSettings: (settings: DesktopSettingsInput) =>
    ipcRenderer.invoke("desktop:save-settings", settings),
  restartServices: () => ipcRenderer.invoke("desktop:restart-services"),
  openPath: (kind: "logs" | "bindings" | "config") =>
    ipcRenderer.invoke("desktop:open-path", kind),
  copyText: (value: string) => clipboard.writeText(value),
});
