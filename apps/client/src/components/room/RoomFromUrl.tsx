"use client";
import { NewSyncer } from "@/components/NewSyncer";
import { InvalidRoom } from "@/components/room/InvalidRoom";
import { validateFullRoomId } from "@/lib/room";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

/** Room page of a static export: the room ID only exists in the browser's URL */
export const RoomFromUrl = () => {
  const pathname = usePathname();
  // The prerendered HTML is shared by every room, so render nothing until mounted
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
  if (!mounted) return null;

  const roomId = decodeURIComponent(pathname.split("/")[2] ?? "");
  if (!validateFullRoomId(roomId)) return <InvalidRoom roomId={roomId} />;
  return <NewSyncer key={roomId} roomId={roomId} />;
};
