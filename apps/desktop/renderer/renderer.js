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
  latencyMs: Number($("latencyMs").value),
  wsUrl: $("wsUrl").value.trim(),
  webUrl: $("webUrl").value.trim(),
});

const fillForm = (s) => {
  $("roomId").value = s.roomId;
  $("username").value = s.username;
  $("routeOutput").checked = s.routeOutput;
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
  for (const id of ["roomId", "username", "routeOutput", "latencyMs", "wsUrl", "webUrl"]) $(id).disabled = running;
  $("toggle").disabled = !running && !deviceReady;
};

const renderStatus = (status) => {
  $("dot").className = `dot ${status.phase}`;
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

  if (status.phase === "idle") setRunning(false);
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
api.onRouted((previousOutput) => {
  const el = $("lanResult");
  el.classList.remove("error");
  el.textContent = `Mac output switched to Beatsync (was ${previousOutput}). It switches back when you stop.`;
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
