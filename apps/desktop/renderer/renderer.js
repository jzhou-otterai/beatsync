// @ts-check
const api = /** @type {any} */ (window).beatsync;
const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

const PHASE_LABELS = {
  idle: "Not streaming",
  connecting: "Connecting…",
  syncing: "Syncing clocks…",
  ready: "Connected — waiting for audio",
  live: "Live",
  error: "Error",
};

let running = false;
let lastPhase = "idle";

const readForm = () => ({
  roomId: $("roomId").value.trim(),
  username: $("username").value.trim(),
  routeOutput: $("routeOutput").checked,
  playOnMac: $("playOnMac").checked,
  latencyMs: Number($("latencyMs").value),
  wsUrl: $("wsUrl").value.trim(),
  webUrl: $("webUrl").value.trim(),
});

const fillForm = (s) => {
  $("roomId").value = s.roomId;
  $("username").value = s.username;
  $("routeOutput").checked = s.routeOutput;
  $("playOnMac").checked = s.playOnMac;
  $("macOffset").value = String(s.macOffsetMs ?? 0);
  renderMacOffset();
  $("latencyMs").value = String(s.latencyMs);
  $("wsUrl").value = s.wsUrl;
  $("webUrl").value = s.webUrl;
  updateLatency();
};

const updateLatency = () => {
  $("latencyOut").textContent = `${$("latencyMs").value} ms`;
};

const setRunning = (value) => {
  running = value;
  const btn = $("toggle");
  btn.textContent = running ? "Stop streaming" : "Start streaming";
  btn.classList.toggle("stop", running);
  for (const id of ["roomId", "username", "routeOutput", "playOnMac", "latencyMs", "wsUrl", "webUrl"])
    $(id).disabled = running;
  $("toggle").disabled = !running && !deviceReady;
};

const renderStatus = (status) => {
  $("dot").className = `dot ${status.phase}`;
  renderRoomVolume(status);
  let label = PHASE_LABELS[status.phase] ?? status.phase;
  if (status.phase === "live") label = `Live to ${status.listeners} device${status.listeners === 1 ? "" : "s"}`;
  $("phase").textContent = label;

  const message = $("message");
  message.textContent = status.message ?? "";
  message.classList.toggle("error", status.phase === "error");

  // Only show live numbers while actually connected to the room
  const active = ["syncing", "ready", "live"].includes(status.phase);
  $("rtt").textContent = active && status.ntpMeasurements ? `${status.rttMs.toFixed(1)} ms` : "–";
  $("offset").textContent = active && status.ntpMeasurements ? `${status.offsetMs.toFixed(1)} ms` : "–";
  $("listeners").textContent = active ? String(status.listeners) : "–";
  $("frames").textContent =
    status.phase === "live"
      ? `${status.framesSent}${status.framesDropped ? ` (${status.framesDropped} dropped)` : ""}`
      : "–";

  if (status.phase === "idle") {
    setRunning(false);
    Object.assign(notes, { routedFrom: null, monitoring: null, warning: null });
    $("notes").textContent = "";
  } else if (!running) {
    // Started from the menu bar
    setRunning(true);
  }

  // Install and Microphone permission both happen while starting; show where they ended up
  if (status.phase === "live" && lastPhase !== "live") checkDevice();
  lastPhase = status.phase;
};

$("latencyMs").addEventListener("input", updateLatency);

let deviceReady = false;

const renderDevice = (device) => {
  // Not installed is fine: starting installs it
  deviceReady = device.microphone !== "denied";
  $("deviceDot").className = `dot ${!device.installed ? "syncing" : deviceReady ? "ready" : "error"}`;
  const title = $("deviceTitle");
  const help = $("deviceHelp");
  if (!device.installed) {
    title.textContent = "Beatsync audio device not installed yet";
    help.textContent =
      "It installs automatically when you start streaming. macOS will ask for your password, since it adds a system audio device.";
  } else if (device.microphone === "denied") {
    title.textContent = "Microphone access is off";
    help.textContent =
      "Reading the Beatsync device counts as microphone input. Turn it on in System Settings → Privacy & Security → Microphone.";
  } else {
    title.textContent = "Beatsync audio device ready";
    help.textContent =
      device.microphone === "granted"
        ? "Anything played to “Beatsync” goes to the room. Your Mac's speakers aren't touched."
        : "macOS will ask for Microphone access when you start. That's how the app reads the Beatsync device.";
  }
  $("toggle").disabled = !running && !deviceReady;
};

const checkDevice = async () => renderDevice(await api.deviceStatus());

$("recheckDevice").addEventListener("click", checkDevice);
api.onDevice(renderDevice);
$("openSound").addEventListener("click", () => api.openSoundSettings());
// What the helper did with the Mac's own audio while starting
const notes = { routedFrom: null, monitoring: null, warning: null };
api.onNote((note) => {
  Object.assign(notes, note);
  const parts = [];
  if (notes.routedFrom)
    parts.push(`Mac output switched to Beatsync (was ${notes.routedFrom}); it switches back when you stop.`);
  if (notes.monitoring)
    parts.push(`Also playing on ${notes.monitoring.device}, ${notes.monitoring.delayMs} ms behind to match the room.`);
  if (notes.warning) parts.push(notes.warning);
  const el = $("notes");
  el.textContent = parts.join(" ");
  el.classList.toggle("error", !!notes.warning);
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (running) {
    await api.stop();
    setRunning(false);
    return;
  }
  setRunning(true);
  await api.start(readForm());
});

$("openRoom").addEventListener("click", () => api.openRoom());

let lanResultTimer;
$("copyLan").addEventListener("click", async () => {
  const { roomId, webUrl } = readForm();
  const result = await api.copyLanLink({ roomId, webUrl });
  const el = $("lanResult");
  el.textContent = result.ok ? `Copied ${result.url}` : result.message;
  el.classList.toggle("error", !result.ok);
  clearTimeout(lanResultTimer);
  lanResultTimer = setTimeout(() => (el.textContent = ""), 8000);
});

// Room volume: one slider for every device in the room (and this Mac). Changes go to
// the server, which broadcasts them back, so the web app's slider and this one agree.
let draggingVolume = false;
let volumeSendTimer = null;
const roomVolume = $("roomVolume");

const renderRoomVolume = (status) => {
  const connected = ["ready", "live"].includes(status.phase);
  roomVolume.disabled = !connected || !status.canControl;
  if (!draggingVolume) roomVolume.value = String(Math.round(status.globalVolume * 100));
  $("roomVolumeOut").textContent = connected ? `${roomVolume.value}%` : "–";
  $("roomVolumeHelp").textContent =
    connected && !status.canControl
      ? "Only the room admin can change this (or make playback controls open to everyone)"
      : "Sets the volume on every other device in the room. This Mac follows its own volume keys";
};

roomVolume.addEventListener("input", () => {
  draggingVolume = true;
  $("roomVolumeOut").textContent = `${roomVolume.value}%`;
  // Throttle: the server rebroadcasts every change to the whole room
  if (volumeSendTimer) return;
  volumeSendTimer = setTimeout(() => {
    volumeSendTimer = null;
    api.setRoomVolume(Number(roomVolume.value) / 100);
  }, 60);
});
roomVolume.addEventListener("change", () => {
  draggingVolume = false;
  api.setRoomVolume(Number(roomVolume.value) / 100);
});

// Mac timing: live fine-tuning of the Mac's local copy against the room
const renderMacOffset = () => {
  const ms = Number($("macOffset").value);
  $("macOffsetOut").textContent = ms === 0 ? "0 ms" : `${ms > 0 ? "+" : ""}${ms} ms (${ms > 0 ? "later" : "earlier"})`;
};
$("macOffset").addEventListener("input", () => {
  renderMacOffset();
  api.setMacOffset(Number($("macOffset").value));
});
$("playOnMac").addEventListener("change", () => {
  $("macOffset").disabled = !$("playOnMac").checked;
});

api.onStatus(renderStatus);
api.onLevel((level) => {
  // Perceptual-ish scaling so quiet audio still moves the meter
  const pct = Math.min(100, Math.sqrt(level) * 100);
  /** @type {HTMLElement} */ (document.getElementById("level")).style.width = `${pct}%`;
});

checkDevice();

api.getInitialState().then(({ settings, status }) => {
  fillForm(settings);
  renderStatus(status);
  setRunning(status.phase !== "idle");
});
