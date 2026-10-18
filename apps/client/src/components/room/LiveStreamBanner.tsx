import { useGlobalStore } from "@/store/global";
import { sendWSRequest } from "@/utils/ws";
import { ClientActionEnum } from "@beatsync/shared";
import { Radio } from "lucide-react";

/** Shown in place of the track player while someone is broadcasting live audio into the room */
export const LiveStreamBanner = () => {
  const liveStream = useGlobalStore((state) => state.liveStream);
  const socket = useGlobalStore((state) => state.socket);
  const currentUser = useGlobalStore((state) => state.currentUser);
  const isInitingSystem = useGlobalStore((state) => state.isInitingSystem);

  if (!liveStream) return null;

  const canStop = currentUser?.isAdmin || currentUser?.clientId === liveStream.broadcasterClientId;

  const handleStop = () => {
    if (!socket) return;
    sendWSRequest({ ws: socket, request: { type: ClientActionEnum.enum.STOP_LIVE_STREAM } });
  };

  return (
    <div className="w-full flex justify-center">
      <div className="w-full max-w-[37rem] flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
        <span className="relative flex size-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
        </span>
        <Radio className="size-4 text-red-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white truncate">
            Live from {liveStream.broadcasterUsername}&apos;s {liveStream.sourceName}
          </div>
          <div className="text-xs text-muted-foreground">
            {isInitingSystem
              ? "Start the audio system to hear the stream"
              : `${Math.round(liveStream.latencyMs)}ms buffer · ${liveStream.sampleRate / 1000}kHz ${liveStream.channels === 2 ? "stereo" : "mono"}`}
          </div>
        </div>
        {canStop && (
          <button
            onClick={handleStop}
            className="text-xs text-neutral-300 hover:text-white border border-neutral-700 hover:border-neutral-500 rounded px-2 py-1 transition-colors cursor-pointer"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
};
