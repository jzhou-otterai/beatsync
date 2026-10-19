import type { ExtractWSRequestFrom } from "@beatsync/shared";
import { sendBroadcast } from "@/utils/responses";
import { requireCanMutate } from "@/websocket/middlewares";
import type { HandlerFunction } from "@/websocket/types";

export const handleStartLiveStream: HandlerFunction<ExtractWSRequestFrom["START_LIVE_STREAM"]> = ({
  ws,
  message,
  server,
}) => {
  const { room } = requireCanMutate(ws);
  const { roomId, clientId, username } = ws.data;

  // Live audio replaces file playback — pause the queue so they don't overlap
  const pause = room.pauseFilePlaybackForLiveStream();
  if (pause) {
    sendBroadcast({
      server,
      roomId,
      message: {
        type: "SCHEDULED_ACTION",
        scheduledAction: pause.action,
        serverTimeToExecute: pause.serverTimeToExecute,
      },
    });
  }

  // A new broadcaster takes over from any existing one
  const liveStream = {
    streamId: message.streamId,
    broadcasterClientId: clientId,
    broadcasterUsername: username,
    sourceName: message.sourceName,
    sampleRate: message.sampleRate,
    channels: message.channels,
    latencyMs: message.latencyMs,
    startedAt: Date.now(),
  };
  room.setLiveStream(liveStream);

  sendBroadcast({
    server,
    roomId,
    message: { type: "ROOM_EVENT", event: { type: "LIVE_STREAM_STATE", liveStream } },
  });
};
