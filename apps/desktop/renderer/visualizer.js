// @ts-check
// Sync visualizer: how in sync every device in the room is with this Mac.
//
// "full" mode (main window) is a target. The Mac sits in the centre as the Beatsync
// ring, whose arc fills while its own clock syncs. Each listener is a dot placed by how
// far off it is: rings mark 15 ms (inaudible) and 40 ms. Spokes join each dot to the
// Mac.
//   solid green   verified by ear (the Mac's microphone heard it within 15 ms)
//   ripples       being measured right now
//   amber         corrected, but the last correction wasn't re-checked
//   hollow        clock-synced only, placed at its estimated error (half its round trip)
//   red           couldn't be checked (not heard, or the check failed); sits on the
//                 outer ring, since its timing is unknown
// Each dot carries the device's initial; the list under the target has the details.
//
// "mini" mode (menu bar) is a timeline strip: early on the left, late on the right, the
// Mac in the middle, the in-sync band shaded.

(() => {
  const IN_SYNC_MS = 15;
  const NEAR_MS = 40;
  const SCALE_MAX_MS = 100;
  const COLORS = {
    green: "#22c55e",
    mint: "#86efac",
    amber: "#f59e0b",
    red: "#ef4444",
    grey: "#737373",
    track: "#3f3f3f",
  };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Radius for a timing error: log-ish, so 0-40 ms gets most of the room */
  const radiusFor = (ms, outer) => outer * Math.min(1, Math.log1p(Math.abs(ms) / 4) / Math.log1p(SCALE_MAX_MS / 4));

  /**
   * What we know about a listener's timing.
   * @returns {{ ms: number, signed: number | null, kind: "verified" | "measuring" | "corrected" | "estimated" | "problem" }}
   */
  const describe = (l) => {
    const estimate = Math.max(0.5, (l.rttMs ?? 0) / 2);
    const t = l.timing;
    if (t?.state === "verified") return { ms: Math.abs(t.errorMs), signed: t.errorMs, kind: "verified" };
    if (t?.state === "corrected") return { ms: Math.abs(t.errorMs), signed: t.errorMs, kind: "corrected" };
    if (t?.state === "measuring") return { ms: estimate, signed: null, kind: "measuring" };
    if (t?.state === "not-heard" || t?.state === "failed") return { ms: estimate, signed: null, kind: "problem" };
    return { ms: estimate, signed: null, kind: "estimated" };
  };

  const colorFor = (kind) =>
    ({
      verified: COLORS.green,
      measuring: COLORS.amber,
      corrected: COLORS.amber,
      estimated: COLORS.grey,
      problem: COLORS.red,
    })[kind];

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ mode?: "full" | "mini" }} [options]
   */
  const createVisualizer = (canvas, options = {}) => {
    const mode = options.mode ?? "full";
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    let status = { phase: "idle", ntpMeasurements: 0, ntpTarget: 8, rttMs: 0 };
    /** @type {any[]} */ let listeners = [];
    /** Eased positions/angles per listener, so dots glide instead of jumping */
    const shown = new Map();
    let progress = 0;
    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    new ResizeObserver(resize).observe(canvas);
    resize();

    const connected = () => ["ready", "live"].includes(status.phase);

    const syncFraction = () => {
      switch (status.phase) {
        case "idle":
        case "error":
          return 0.75;
        case "connecting":
          return 0.25;
        case "syncing":
          return Math.min(1, status.ntpMeasurements / Math.max(1, status.ntpTarget));
        default:
          return 1;
      }
    };

    /** The Mac: the Beatsync ring at the centre, its arc showing its own clock sync */
    const drawMac = (cx, cy, r, t) => {
      const phase = status.phase;
      const thickness = r * 0.3;
      ctx.globalAlpha = phase === "idle" ? 0.5 : 1;
      ctx.lineWidth = thickness;
      ctx.strokeStyle = COLORS.track;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      const spin = phase === "connecting" && !reducedMotion ? t * 4 : 0;
      const start = -Math.PI / 2 + spin;
      const fraction = phase === "syncing" ? progress : syncFraction();
      ctx.strokeStyle = phase === "error" ? COLORS.red : "#ffffff";
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, start + Math.max(0.02, fraction) * Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = connected() ? COLORS.green : "#404040";
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    };

    const drawFull = (t) => {
      const cx = width / 2;
      const cy = height / 2 - 4;
      const outer = Math.min(width, height) / 2 - 18;
      const macR = 13;
      const on = connected();

      // Target rings, labelled
      const rings = [
        { ms: IN_SYNC_MS, color: COLORS.green, fill: "rgba(34,197,94,0.07)" },
        { ms: NEAR_MS, color: COLORS.amber, fill: null },
        { ms: SCALE_MAX_MS, color: "#525252", fill: null },
      ];
      for (const ring of rings) {
        const r = radiusFor(ring.ms, outer);
        if (ring.fill && on) {
          ctx.fillStyle = ring.fill;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = ring.color;
        ctx.globalAlpha = on ? 0.55 : 0.2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "10px -apple-system, sans-serif";
        ctx.fillStyle = ring.color;
        ctx.textAlign = "left";
        ctx.fillText(ring.ms === SCALE_MAX_MS ? "100+ ms" : `${ring.ms} ms`, cx + r * 0.71 + 3, cy - r * 0.71 - 2);
        ctx.globalAlpha = 1;
      }

      // Sweep while the Mac's clock syncs
      if (status.phase === "syncing" && !reducedMotion) {
        const a = (t * 2.4) % (Math.PI * 2);
        const sweep = ctx.createConicGradient(a, cx, cy);
        sweep.addColorStop(0, "rgba(245,158,11,0.28)");
        sweep.addColorStop(0.12, "rgba(245,158,11,0)");
        sweep.addColorStop(1, "rgba(245,158,11,0)");
        ctx.fillStyle = sweep;
        ctx.beginPath();
        ctx.arc(cx, cy, outer, 0, Math.PI * 2);
        ctx.fill();
      }

      // Listeners
      const list = on ? listeners : [];
      list.forEach((l, i) => {
        const d = describe(l);
        const targetAngle = -Math.PI / 2 + (i / list.length) * Math.PI * 2 + Math.PI / list.length;
        // Unknown timing goes on the outer ring rather than pretending to be close
        const targetR = d.kind === "problem" ? outer : Math.max(macR + 14, radiusFor(d.ms, outer));
        const s = shown.get(l.clientId) ?? { r: outer, a: targetAngle };
        s.r += (targetR - s.r) * 0.08;
        s.a += (targetAngle - s.a) * 0.08;
        shown.set(l.clientId, s);
        const x = cx + Math.cos(s.a) * s.r;
        const y = cy + Math.sin(s.a) * s.r;
        const color = colorFor(d.kind);

        // Spoke back to the Mac
        ctx.strokeStyle = color;
        ctx.globalAlpha = d.kind === "verified" ? 0.6 : 0.3;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(s.a) * (macR + 6), cy + Math.sin(s.a) * (macR + 6));
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Being measured: ripples
        if (d.kind === "measuring" && !reducedMotion) {
          for (const offset of [0, 0.5]) {
            const p = (t * 0.9 + offset) % 1;
            ctx.strokeStyle = `rgba(245,158,11,${0.6 * (1 - p)})`;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, y, 9 + p * 16, 0, Math.PI * 2);
            ctx.stroke();
          }
        }

        // The dot, with the device's initial (the list below names it)
        const dotR = 9;
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        if (d.kind === "estimated") {
          ctx.lineWidth = 2;
          ctx.strokeStyle = color;
          ctx.fillStyle = "#141414";
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.shadowColor = d.kind === "verified" ? "rgba(34,197,94,0.9)" : "transparent";
          ctx.shadowBlur = d.kind === "verified" ? 10 : 0;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        ctx.font = "700 10px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = d.kind === "estimated" ? color : "#0a0a0a";
        ctx.fillText((l.username.trim()[0] ?? "?").toUpperCase(), x, y + 0.5);
        ctx.textBaseline = "alphabetic";
      });

      drawMac(cx, cy, macR, t);
      ctx.font = "10px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#a3a3a3";
      ctx.fillText("This Mac", cx, cy + macR + 16);
    };

    const drawMini = (t) => {
      const mid = width / 2;
      const y = height / 2 + 2;
      const half = width / 2 - 10;
      const xFor = (ms) => mid + Math.sign(ms) * Math.min(1, Math.abs(ms) / 60) * half;
      const on = connected();

      // In-sync band and axis
      ctx.fillStyle = on ? "rgba(34,197,94,0.14)" : "rgba(255,255,255,0.04)";
      ctx.fillRect(xFor(-IN_SYNC_MS), y - 10, xFor(IN_SYNC_MS) - xFor(-IN_SYNC_MS), 20);
      ctx.strokeStyle = "#404040";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(10, y);
      ctx.lineTo(width - 10, y);
      ctx.stroke();
      ctx.font = "9px -apple-system, sans-serif";
      ctx.fillStyle = "#737373";
      ctx.textAlign = "left";
      ctx.fillText("early", 10, y + 16);
      ctx.textAlign = "right";
      ctx.fillText("late", width - 10, y + 16);

      // The Mac in the middle
      drawMac(mid, y, 6, t);

      // Verified/corrected devices on the line; the rest float above, unplaced
      const list = on ? listeners : [];
      let unplaced = 0;
      for (const l of list) {
        const d = describe(l);
        let x;
        let dy = 0;
        if (d.signed !== null) {
          x = xFor(d.signed);
        } else {
          x = mid + (unplaced % 2 ? 1 : -1) * (14 + Math.floor(unplaced / 2) * 12);
          dy = -12;
          unplaced++;
        }
        const color = colorFor(d.kind);
        if (d.kind === "measuring" && !reducedMotion) {
          const p = (t * 0.9) % 1;
          ctx.strokeStyle = `rgba(245,158,11,${0.6 * (1 - p)})`;
          ctx.beginPath();
          ctx.arc(x, y + dy, 4 + p * 8, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(x, y + dy, 4, 0, Math.PI * 2);
        if (d.kind === "estimated") {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
    };

    const frame = (now) => {
      const t = now / 1000;
      progress += (syncFraction() - progress) * 0.12;
      ctx.clearRect(0, 0, width, height);
      (mode === "mini" ? drawMini : drawFull)(t);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    return {
      setStatus: (next) => {
        status = next;
      },
      setListeners: (next) => {
        listeners = next ?? [];
      },
    };
  };

  /**
   * One line for the whole room: how many devices are confirmed in sync
   * @param {any[]} list
   * @param {{ short?: boolean }} [options] short: fits the menu bar's one-line detail
   */
  const summarize = (list, options = {}) => {
    const short = /** @type {{ short?: boolean }} */ (options).short;
    if (!list.length) return short ? "No other devices yet" : "No other devices in the room yet";
    const kinds = list.map((l) => describe(l).kind);
    const verified = kinds.filter((k) => k === "verified").length;
    const measuring = kinds.filter((k) => k === "measuring").length;
    const byEar = list.some((l) => l.byEar);
    if (!byEar)
      return short
        ? `${list.length} clock-synced`
        : `${list.length} device${list.length === 1 ? "" : "s"} clock-synced (no microphone to check by ear)`;
    // The menu bar's detail line is one short line
    if (short) return `${verified}/${list.length} in sync by ear${measuring ? " · checking" : ""}`;
    const parts = [`${verified} of ${list.length} verified in sync by ear`];
    if (measuring) parts.push("checking one now");
    return parts.join(" · ");
  };

  /** @type {any} */ (window).createVisualizer = createVisualizer;
  /** @type {any} */ (window).describeListenerSync = describe;
  /** @type {any} */ (window).summarizeRoomSync = summarize;
})();
