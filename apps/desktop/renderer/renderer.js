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

const readForm = () => ({
  roomId: $("roomId").value.trim(),
  username: $("username").value.trim(),
  muteLocalOutput: $("muteLocalOutput").checked,
  latencyMs: Number($("latencyMs").value),
  wsUrl: $("wsUrl").value.trim(),
  webUrl: $("webUrl").value.trim(),
});

const fillForm = (s) => {
  $("roomId").value = s.roomId;
  $("username").value = s.username;
  $("muteLocalOutput").checked = s.muteLocalOutput;
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
  for (const id of ["roomId", "username", "muteLocalOutput", "latencyMs", "wsUrl", "webUrl"]) $(id).disabled = running;
};

const renderStatus = (status) => {
  $("dot").className = `dot ${status.phase}`;
  let label = PHASE_LABELS[status.phase] ?? status.phase;
  if (status.phase === "live") label = `Live to ${status.listeners} device${status.listeners === 1 ? "" : "s"}`;
  $("phase").textContent = label;

  const message = $("message");
  message.textContent = status.message ?? "";
  message.classList.toggle("error", status.phase === "error");

  const active = status.phase !== "idle";
  $("rtt").textContent = active && status.ntpMeasurements ? `${status.rttMs.toFixed(1)} ms` : "–";
  $("offset").textContent = active && status.ntpMeasurements ? `${status.offsetMs.toFixed(1)} ms` : "–";
  $("listeners").textContent = active ? String(status.listeners) : "–";
  $("frames").textContent =
    status.phase === "live"
      ? `${status.framesSent}${status.framesDropped ? ` (${status.framesDropped} dropped)` : ""}`
      : "–";

  if (status.phase === "idle") setRunning(false);
};

$("latencyMs").addEventListener("input", updateLatency);

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

api.onStatus(renderStatus);
api.onLevel((level) => {
  // Perceptual-ish scaling so quiet audio still moves the meter
  const pct = Math.min(100, Math.sqrt(level) * 100);
  /** @type {HTMLElement} */ (document.getElementById("level")).style.width = `${pct}%`;
});

api.getInitialState().then(({ settings, status }) => {
  fillForm(settings);
  renderStatus(status);
  setRunning(status.phase !== "idle");
});
