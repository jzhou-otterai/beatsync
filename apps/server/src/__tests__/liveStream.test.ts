// Tests the live audio relay: who may start a stream, which binary frames get
// relayed, and that the stream ends when its broadcaster leaves. A bug here is
// silent in dev (one tester is always admin) but lets anyone inject audio into
// a room, or leaves rooms stuck "live" forever.

import type { WSBroadcastType } from "@beatsync/shared";
import { encodeLiveAudioFrame } from "@beatsync/shared";
import type { ServerWebSocket } from "bun";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mockR2 } from "@/__tests__/mocks/r2";
import { createMockServer, createMockWs } from "@/__tests__/mocks/websocket";
import { globalManager } from "@/managers/GlobalManager";
import { handleClose, handleMessage, handleOpen } from "@/routes/websocketHandlers";
import type { BunServer, WSData } from "@/utils/websocket";

let broadcasts: WSBroadcastType[] = [];

mockR2();

void mock.module("@/utils/responses", () => ({
  sendBroadcast: mock(({ message }: { message: WSBroadcastType }) => {
    broadcasts.push(message);
  }),
  sendUnicast: mock(() => {
    /* noop */
  }),
  sendToClient: mock(() => {
    /* noop */
  }),
  corsHeaders: {},
  jsonResponse: mock(() => new Response()),
  errorResponse: mock(() => new Response()),
}));

const ROOM_ID = "live-test-room";
const STREAM_ID = 42;

const withPublish = (ws: ServerWebSocket<WSData>) => {
  (ws as unknown as { publish: ReturnType<typeof mock> }).publish = mock(() => {
    /* noop */
  });
  return ws;
};

const publishCalls = (ws: ServerWebSocket<WSData>) =>
  (ws as unknown as { publish: ReturnType<typeof mock> }).publish.mock.calls.length;

const frame = (streamId: number) =>
  Buffer.from(
    encodeLiveAudioFrame(
      { channels: 2, codec: 0, streamId, seq: 0, playAtServerTime: Date.now() + 400, sampleRate: 48000 },
      new Int16Array(960 * 2)
    )
  );

const startRequest = JSON.stringify({
  type: "START_LIVE_STREAM",
  streamId: STREAM_ID,
  sampleRate: 48000,
  channels: 2,
  latencyMs: 400,
  sourceName: "Mac",
});

const lastLiveState = () => liveStates()[liveStates().length - 1];

const liveStates = () =>
  broadcasts.flatMap((b) => (b.type === "ROOM_EVENT" && b.event.type === "LIVE_STREAM_STATE" ? [b.event] : []));

describe("live stream relay", () => {
  let server: BunServer;
  let admin: ServerWebSocket<WSData>;
  let guest: ServerWebSocket<WSData>;

  beforeEach(() => {
    broadcasts = [];
    server = createMockServer();
    for (const id of globalManager.getRoomIds()) globalManager.deleteRoom(id);

    // First client in a room becomes admin; the room defaults to ADMIN_ONLY controls
    admin = withPublish(createMockWs({ clientId: "admin", roomId: ROOM_ID }));
    guest = withPublish(createMockWs({ clientId: "guest", roomId: ROOM_ID }));
    handleOpen(admin, server);
    handleOpen(guest, server);
  });

  it("refuses a stream from a client without playback control", async () => {
    await handleMessage(guest, startRequest, server);

    expect(globalManager.getRoom(ROOM_ID)!.getLiveStream()).toBeNull();
    expect(liveStates()).toHaveLength(0);

    await handleMessage(guest, frame(STREAM_ID), server);
    expect(publishCalls(guest)).toBe(0);
  });

  it("relays only the active broadcaster's frames for the active stream", async () => {
    await handleMessage(admin, startRequest, server);
    expect(lastLiveState()?.liveStream?.broadcasterClientId).toBe("admin");

    await handleMessage(admin, frame(STREAM_ID), server);
    expect(publishCalls(admin)).toBe(1);

    // Stale stream id (e.g. frames still in flight from a previous session)
    await handleMessage(admin, frame(STREAM_ID + 1), server);
    expect(publishCalls(admin)).toBe(1);

    // Another client can't inject frames into someone else's stream
    await handleMessage(guest, frame(STREAM_ID), server);
    expect(publishCalls(guest)).toBe(0);

    // Garbage binary is dropped rather than relayed
    await handleMessage(admin, Buffer.from([1, 2, 3]), server);
    expect(publishCalls(admin)).toBe(1);
  });

  it("ends the stream for everyone when the broadcaster disconnects", async () => {
    await handleMessage(admin, startRequest, server);
    handleClose(admin, server);

    expect(globalManager.getRoom(ROOM_ID)!.getLiveStream()).toBeNull();
    expect(lastLiveState()?.liveStream).toBeNull();
  });

  it("pauses file playback when a live stream starts", async () => {
    const room = globalManager.getRoom(ROOM_ID)!;
    const url = "https://example.com/song.mp3";
    room.addAudioSource({ url });
    room.updatePlaybackSchedulePlay({ type: "PLAY", audioSource: url, trackTimeSeconds: 10 }, Date.now() - 5000);

    await handleMessage(admin, startRequest, server);

    expect(room.getPlaybackState().type).toBe("paused");
    // Position carries forward from where the track had got to (~15s), not reset to 0
    expect(room.getPlaybackState().trackPositionSeconds).toBeGreaterThan(14);
    const pause = broadcasts.find((b) => b.type === "SCHEDULED_ACTION" && b.scheduledAction.type === "PAUSE");
    expect(pause).toBeDefined();
  });
});
