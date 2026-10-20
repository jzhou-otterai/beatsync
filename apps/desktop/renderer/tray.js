// @ts-check
// Menu bar popover: status, room volume and start/stop, mirroring the main window.
const api = /** @type {any} */ (window).beatsync;
const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

const PHASE_LABELS = {
  idle: "Not streaming",
  connecting: "Connecting…",
  syncing: "Syncing clocks…",
  ready: "Connected",
  live: "Live",
  error: "Error",
};

let phase = "idle";
/** Everyone else in the room and how in sync they are (from the main process) */
let syncMap = [];
let draggingVolume = false;
let volumeSendTimer = null;
const volume = $("volume");
const visualizer = /** @type {any} */ (window).createVisualizer(document.getElementById("viz"), { mode: "mini" });

const render = (status) => {
  phase = status.phase;
  $("dot").className = `dot ${status.phase}`;
  $("phase").textContent =
    status.phase === "live"
      ? `Live to ${status.listeners} device${status.listeners === 1 ? "" : "s"}`
      : (PHASE_LABELS[status.phase] ?? status.phase);
  // Say what the sync is doing, not just that it's happening
  const n = Math.min(status.ntpMeasurements, status.ntpTarget);
  $("detail").textContent =
    status.message ??
    (status.phase === "syncing"
      ? `Syncing clocks: ${n} of ${status.ntpTarget} samples`
      : status.phase === "live"
        ? /** @type {any} */ (window).summarizeRoomSync(syncMap, { short: true })
        : status.phase === "ready"
          ? "In sync · play something on the Mac"
          : "");
  visualizer.setStatus(status);
  visualizer.setListeners(["ready", "live"].includes(status.phase) ? syncMap : []);

  const connected = ["ready", "live"].includes(status.phase);
  volume.disabled = !connected || !status.canControl;
  if (!draggingVolume) volume.value = String(Math.round(status.globalVolume * 100));
  $("volumeOut").textContent = connected ? `${volume.value}%` : "–";
  $("volumeHelp").textContent =
    connected && !status.canControl
      ? "Only the room admin can change this"
      : "Every other device in the room (not this Mac)";

  const running = status.phase !== "idle";
  const toggle = $("toggle");
  toggle.textContent = running ? "Stop streaming" : "Start streaming";
  toggle.classList.toggle("stop", running);
};

volume.addEventListener("input", () => {
  draggingVolume = true;
  $("volumeOut").textContent = `${volume.value}%`;
  if (volumeSendTimer) return;
  volumeSendTimer = setTimeout(() => {
    volumeSendTimer = null;
    api.setRoomVolume(Number(volume.value) / 100);
  }, 60);
});
volume.addEventListener("change", () => {
  draggingVolume = false;
  api.setRoomVolume(Number(volume.value) / 100);
});

$("toggle").addEventListener("click", async () => {
  if (phase !== "idle") {
    await api.stop();
    return;
  }
  const result = await api.startSaved();
  if (!result.ok) $("detail").textContent = result.message;
});

$("openMain").addEventListener("click", () => api.showMain());

api.onStatus(render);
// Room sync at a glance: dots on an early/late strip, and a one-line summary
api.onSyncMap((list) => {
  syncMap = list;
  visualizer.setListeners(["ready", "live"].includes(phase) ? list : []);
  if (["ready", "live"].includes(phase))
    $("detail").textContent = /** @type {any} */ (window).summarizeRoomSync(list, { short: true });
});
api.getInitialState().then(({ status }) => render(status));
