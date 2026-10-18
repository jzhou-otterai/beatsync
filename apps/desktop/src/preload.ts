import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("beatsync", {
  getInitialState: () => ipcRenderer.invoke("get-initial-state"),
  start: (settings: unknown) => ipcRenderer.invoke("start", settings),
  stop: () => ipcRenderer.invoke("stop"),
  openRoom: () => ipcRenderer.invoke("open-room"),
  copyLanLink: (form: { webUrl: string; roomId: string }) => ipcRenderer.invoke("copy-lan-link", form),
  onStatus: (cb: (status: unknown) => void) => ipcRenderer.on("status", (_e, status) => cb(status)),
  onLevel: (cb: (level: number) => void) => ipcRenderer.on("level", (_e, level: number) => cb(level)),
});
