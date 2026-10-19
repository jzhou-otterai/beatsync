import type { ExtractWSRequestFrom } from "@beatsync/shared";
import { globalManager } from "@/managers";
import { sendUnicast } from "@/utils/responses";
import type { HandlerFunction } from "@/websocket/types";

/** Only the room's current live broadcaster may time its listeners */
const targetSocket = (ws: Parameters<HandlerFunction>[0]["ws"], targetClientId: string) => {
  const room = globalManager.getRoom(ws.data.roomId);
  if (room?.getLiveStream()?.broadcasterClientId !== ws.data.clientId) return null;
  return room.getClientWs(targetClientId) ?? null;
};

export const handleCalibrationChirp: HandlerFunction<ExtractWSRequestFrom["CALIBRATION_CHIRP"]> = ({ ws, message }) => {
  const target = targetSocket(ws, message.targetClientId);
  if (!target) return;
  sendUnicast({
    ws: target,
    message: { type: "CALIBRATION_CHIRP", chirpId: message.chirpId, playAtServerTime: message.playAtServerTime },
  });
};

export const handleCalibrationResult: HandlerFunction<ExtractWSRequestFrom["CALIBRATION_RESULT"]> = ({
  ws,
  message,
}) => {
  const target = targetSocket(ws, message.targetClientId);
  if (!target) return;
  sendUnicast({
    ws: target,
    message: { type: "CALIBRATION_RESULT", chirpId: message.chirpId, correctionMs: message.correctionMs },
  });
};
