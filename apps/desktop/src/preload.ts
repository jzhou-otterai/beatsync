import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("beatsync", {
  getInitialState: () => ipcRenderer.invoke("get-initial-state"),
  start: (settings: unknown) => ipcRenderer.invoke("start", settings),
  stop: () => ipcRenderer.invoke("stop"),
  startSaved: () => ipcRenderer.invoke("start-saved"),
  showMain: () => ipcRenderer.invoke("show-main"),
  openRoom: () => ipcRenderer.invoke("open-room"),
  recheckTiming: () => ipcRenderer.invoke("recheck-timing"),
  setRoomVolume: (volume: number) => ipcRenderer.invoke("set-room-volume", volume),
  setMacOffset: (ms: number) => ipcRenderer.invoke("set-mac-offset", ms),
  deviceStatus: () => ipcRenderer.invoke("device-status"),
  installDevice: () => ipcRenderer.invoke("install-device"),
  onDevice: (cb: (status: unknown) => void) => ipcRenderer.on("device", (_e, status) => cb(status)),
  openSoundSettings: () => ipcRenderer.invoke("open-sound-settings"),
  onNote: (cb: (note: unknown) => void) => ipcRenderer.on("note", (_e, note) => cb(note)),
  copyLanLink: (form: { roomId: string; hostLocally: boolean; localPort: number; wsUrl: string; webUrl: string }) =>
    ipcRenderer.invoke("copy-lan-link", form),
  onStatus: (cb: (status: unknown) => void) => ipcRenderer.on("status", (_e, status) => cb(status)),
  onLevel: (cb: (level: number) => void) => ipcRenderer.on("level", (_e, level: number) => cb(level)),
  /** Everyone else in the room and how in sync they are */
  onSyncMap: (cb: (listeners: unknown[]) => void) => ipcRenderer.on("sync-map", (_e, list: unknown[]) => cb(list)),
});
