import { contextBridge, ipcRenderer } from "electron";

// Bridge for the hidden calibration window (renderer/calibration.js)
contextBridge.exposeInMainWorld("calibration", {
  onStart: (cb: (args: unknown) => void) => ipcRenderer.on("cal-start", (_e, args) => cb(args)),
  onMeasure: (cb: (args: unknown) => void) => ipcRenderer.on("cal-measure", (_e, args) => cb(args)),
  onStop: (cb: () => void) => ipcRenderer.on("cal-stop", () => cb()),
  ready: (info: unknown) => ipcRenderer.send("cal-ready", info),
  error: (message: string) => ipcRenderer.send("cal-error", message),
  result: (result: unknown) => ipcRenderer.send("cal-result", result),
});
