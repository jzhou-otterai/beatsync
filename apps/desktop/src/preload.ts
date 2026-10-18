import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("beatsync", {
  getInitialState: () => ipcRenderer.invoke("get-initial-state"),
  start: (settings: unknown) => ipcRenderer.invoke("start", settings),
  stop: () => ipcRenderer.invoke("stop"),
  openRoom: () => ipcRenderer.invoke("open-room"),
  deviceStatus: () => ipcRenderer.invoke("device-status"),
  installDevice: () => ipcRenderer.invoke("install-device"),
  onDevice: (cb: (status: unknown) => void) => ipcRenderer.on("device", (_e, status) => cb(status)),
  openSoundSettings: () => ipcRenderer.invoke("open-sound-settings"),
  onRouted: (cb: (previousOutput: string) => void) => ipcRenderer.on("routed", (_e, name: string) => cb(name)),
  copyLanLink: (form: { webUrl: string; roomId: string }) => ipcRenderer.invoke("copy-lan-link", form),
  onStatus: (cb: (status: unknown) => void) => ipcRenderer.on("status", (_e, status) => cb(status)),
  onLevel: (cb: (level: number) => void) => ipcRenderer.on("level", (_e, level: number) => cb(level)),
});
