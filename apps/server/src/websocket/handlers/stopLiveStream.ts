import type { ExtractWSRequestFrom } from "@beatsync/shared";
import { sendBroadcast } from "@/utils/responses";
import { requireRoom } from "@/websocket/middlewares";
import type { HandlerFunction } from "@/websocket/types";

export const handleStopLiveStream: HandlerFunction<ExtractWSRequestFrom["STOP_LIVE_STREAM"]> = ({ ws, server }) => {
  const { room } = requireRoom(ws);
  const liveStream = room.getLiveStream();
  if (!liveStream) return;

  // Only the broadcaster or an admin can end someone's stream
  const client = room.getClient(ws.data.clientId);
  if (liveStream.broadcasterClientId !== ws.data.clientId && !client?.isAdmin) {
    throw new Error(`Client ${ws.data.clientId} cannot stop live stream owned by ${liveStream.broadcasterClientId}`);
  }

  room.setLiveStream(null);
  sendBroadcast({
    server,
    roomId: ws.data.roomId,
    message: { type: "ROOM_EVENT", event: { type: "LIVE_STREAM_STATE", liveStream: null } },
  });
};
