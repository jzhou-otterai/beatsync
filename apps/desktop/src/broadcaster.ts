import {
  ClientActionEnum,
  NTP_CONSTANTS,
  WSResponseSchema,
  type LiveStreamInfoType,
  type PlaybackControlsPermissionsType,
  type WSRequestType,
} from "@beatsync/shared";
import { ServerClock } from "./clock";
import { PcmChunker } from "./pcmChunker";
import type { CaptureFormat } from "./audioCapture";

// How long to wait for the server to confirm START_LIVE_STREAM before assuming it was refused
const START_CONFIRM_TIMEOUT_MS = 4000;
// Reconnect backoff when the server is unreachable or drops us
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
// Stop queueing audio if the socket can't drain (slow uplink) — late audio is useless
const MAX_BUFFERED_BYTES = 512 * 1024;

export type BroadcasterPhase = "idle" | "connecting" | "syncing" | "ready" | "live" | "error";

export interface BroadcasterStatus {
  phase: BroadcasterPhase;
  message?: string;
  rttMs: number;
  offsetMs: number;
  ntpMeasurements: number;
  isAdmin: boolean;
  /** Room-wide volume (0-1) every listener applies; shared with the web app's volume slider */
  globalVolume: number;
  /** Whether this client may change room settings like the volume */
  canControl: boolean;
  listeners: number;
  framesSent: number;
  framesDropped: number;
  reanchors: number;
  liveStream: LiveStreamInfoType | null;
}

export const initialBroadcasterStatus = (): BroadcasterStatus => ({
  phase: "idle",
  rttMs: 0,
  offsetMs: 0,
  ntpMeasurements: 0,
  isAdmin: false,
  globalVolume: 1,
  canControl: false,
  listeners: 0,
  framesSent: 0,
  framesDropped: 0,
  reanchors: 0,
  liveStream: null,
});

export interface BroadcasterOptions {
  wsUrl: string;
  roomId: string;
  username: string;
  clientId: string;
  onStatus: (status: BroadcasterStatus) => void;
  /** The room volume changed (from this app, the web app, or on joining) */
  onGlobalVolume?: (volume: number) => void;
}

/**
 * A Beatsync room client that broadcasts audio instead of playing it.
 *
 * It connects to the same `/ws` endpoint as the web app, keeps a server clock
 * estimate with the same NTP probe exchange, and streams PCM as binary frames
 * stamped with the server time they should play at.
 */
export class Broadcaster {
  private ws: WebSocket | null = null;
  private clock = new ServerClock();
  private ntpTimer: ReturnType<typeof setTimeout> | null = null;
  private chunker: PcmChunker | null = null;
  private streamId: number | null = null;
  private pendingStart: { format: CaptureFormat; latencyMs: number; sourceName: string } | null = null;
  private closedByUser = false;
  private permissions: PlaybackControlsPermissionsType = "ADMIN_ONLY";
  private startTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private status: BroadcasterStatus = initialBroadcasterStatus();

  constructor(private readonly opts: BroadcasterOptions) {}

  connect(): void {
    const { wsUrl, roomId, username, clientId } = this.opts;
    const url = new URL(wsUrl);
    url.searchParams.set("roomId", roomId);
    url.searchParams.set("username", username);
    url.searchParams.set("clientId", clientId);

    this.closedByUser = false;
    if (this.status.phase !== "error") this.update({ phase: "connecting", message: undefined });
    const ws = new WebSocket(url.toString());
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      this.clock.reset();
      this.update({ phase: "syncing", message: undefined });
      this.scheduleProbes();
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") this.handleMessage(event.data);
    };
    ws.onclose = () => {
      this.stopProbes();
      this.chunker = null;
      if (this.ws === ws) this.ws = null;
      if (this.closedByUser) return;

      // Keep pendingStart: once we reconnect and resync, the stream restarts by itself
      const retrySeconds = Math.round(this.reconnectDelayMs / 1000);
      this.update({
        phase: "error",
        liveStream: null,
        message: opened
          ? `Lost connection to the server. Reconnecting in ${retrySeconds}s…`
          : `Can't reach a Beatsync server at ${wsUrl}. Is it running, and is it the only thing on that port? Retrying in ${retrySeconds}s…`,
      });
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    };
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopStream();
    this.stopProbes();
    this.ws?.close();
    this.ws = null;
    this.update({ phase: "idle", liveStream: null, listeners: 0 });
  }

  /** Ask the room to switch to our live stream. Audio flows once the server confirms. */
  startStream(format: CaptureFormat, latencyMs: number, sourceName: string): void {
    this.pendingStart = { format, latencyMs, sourceName };
    if (this.clock.isSynced) this.sendStart();
  }

  stopStream(): void {
    if (this.startTimeout) clearTimeout(this.startTimeout);
    this.pendingStart = null;
    this.chunker = null;
    if (this.streamId !== null && this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: ClientActionEnum.enum.STOP_LIVE_STREAM });
    }
    this.streamId = null;
    if (this.status.phase === "live") this.update({ phase: "ready" });
  }

  /** Raw PCM from the capture helper */
  pushPcm(pcm: Buffer): void {
    const ws = this.ws;
    if (!this.chunker || !ws || ws.readyState !== WebSocket.OPEN) return;

    for (const frame of this.chunker.push(pcm)) {
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.status.framesDropped++;
        continue;
      }
      ws.send(frame);
      this.status.framesSent++;
    }
    this.status.reanchors = this.chunker.reanchors;
  }

  /** Set the volume for everyone in the room. Takes effect when the server broadcasts it back. */
  setGlobalVolume(volume: number): void {
    this.send({ type: ClientActionEnum.enum.SET_GLOBAL_VOLUME, volume: Math.max(0, Math.min(1, volume)) });
  }

  getStatus(): BroadcasterStatus {
    return { ...this.status };
  }

  private sendStart(): void {
    if (!this.pendingStart) return;
    const { format, latencyMs, sourceName } = this.pendingStart;
    this.streamId = Math.floor(Math.random() * 0xffffffff);
    this.send({
      type: ClientActionEnum.enum.START_LIVE_STREAM,
      streamId: this.streamId,
      sampleRate: format.sampleRate,
      channels: format.channels,
      latencyMs,
      sourceName,
    });

    // The server only logs permission failures, so treat silence as a refusal
    if (this.startTimeout) clearTimeout(this.startTimeout);
    this.startTimeout = setTimeout(() => {
      if (this.pendingStart && this.status.phase !== "live") {
        this.update({
          phase: "error",
          message:
            "The room didn't accept the stream. Join an empty room, or ask the room admin to make you admin or allow everyone to control playback.",
        });
      }
    }, START_CONFIRM_TIMEOUT_MS);
  }

  private handleMessage(raw: string): void {
    const parsed = WSResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const msg = parsed.data;

    switch (msg.type) {
      case "NTP_RESPONSE": {
        const wasSynced = this.clock.isSynced;
        this.clock.handleResponse(msg);
        this.update({
          rttMs: this.clock.rttMs,
          offsetMs: this.clock.offsetMs,
          ntpMeasurements: this.clock.measurementCount,
        });
        if (!wasSynced && this.clock.isSynced) {
          this.update({ phase: "ready" });
          this.sendStart();
        }
        break;
      }
      case "SCHEDULED_ACTION":
        if (msg.scheduledAction.type === "GLOBAL_VOLUME_CONFIG") {
          this.update({ globalVolume: msg.scheduledAction.volume });
          this.opts.onGlobalVolume?.(msg.scheduledAction.volume);
        }
        break;
      case "LIVENESS_PING":
        this.send({ type: ClientActionEnum.enum.LIVENESS_PONG });
        break;
      case "ROOM_EVENT": {
        const { event } = msg;
        if (event.type === "CLIENT_CHANGE") {
          const self = event.clients.find((c) => c.clientId === this.opts.clientId);
          const isAdmin = self?.isAdmin ?? false;
          this.update({
            isAdmin,
            canControl: isAdmin || this.permissions === "EVERYONE",
            listeners: Math.max(0, event.clients.length - 1),
          });
        } else if (event.type === "SET_PLAYBACK_CONTROLS") {
          this.permissions = event.permissions;
          this.update({ canControl: this.status.isAdmin || event.permissions === "EVERYONE" });
        } else if (event.type === "LIVE_STREAM_STATE") {
          this.handleLiveStreamState(event.liveStream);
        }
        break;
      }
    }
  }

  private handleLiveStreamState(liveStream: LiveStreamInfoType | null): void {
    this.update({ liveStream });
    const isOurs =
      liveStream !== null &&
      liveStream.broadcasterClientId === this.opts.clientId &&
      liveStream.streamId === this.streamId;

    if (isOurs && this.pendingStart) {
      if (this.startTimeout) clearTimeout(this.startTimeout);
      const { format, latencyMs } = this.pendingStart;
      this.chunker = new PcmChunker({
        streamId: liveStream.streamId,
        sampleRate: format.sampleRate,
        channels: format.channels,
        latencyMs,
        serverNow: () => this.clock.now(),
      });
      this.update({ phase: "live", message: undefined, framesSent: 0, framesDropped: 0, reanchors: 0 });
    } else if (!isOurs && this.chunker) {
      // Someone else took over, or an admin stopped us
      this.chunker = null;
      this.pendingStart = null;
      this.streamId = null;
      this.update({
        phase: "ready",
        message: liveStream ? `${liveStream.broadcasterUsername} took over the stream` : "Stream stopped",
      });
    }
  }

  private scheduleProbes(): void {
    this.stopProbes();
    const tick = () => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.clock.sendProbePair(({ t0, probeGroupId, probeGroupIndex }) =>
        this.send({
          type: ClientActionEnum.enum.NTP_REQUEST,
          t0,
          clientRTT: this.clock.rttMs || undefined,
          probeGroupId,
          probeGroupIndex,
        })
      );
      const interval = this.clock.isSynced ? NTP_CONSTANTS.STEADY_STATE_INTERVAL_MS : NTP_CONSTANTS.INITIAL_INTERVAL_MS;
      this.ntpTimer = setTimeout(tick, interval);
    };
    tick();
  }

  private stopProbes(): void {
    if (this.ntpTimer) clearTimeout(this.ntpTimer);
    this.ntpTimer = null;
  }

  private send(request: WSRequestType): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(request));
  }

  private update(patch: Partial<BroadcasterStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus(this.getStatus());
  }
}
