import { NewSyncer } from "@/components/NewSyncer";
import { RoomFromUrl } from "@/components/room/RoomFromUrl";
import { InvalidRoom } from "@/components/room/InvalidRoom";
import { DEMO_ROOM_ID, IS_DEMO_MODE } from "@/lib/demo";
import { STATIC_ROOM_PLACEHOLDER, validateFullRoomId } from "@/lib/room";
import { redirect } from "next/navigation";

/**
 * A static export (served by the Beatsync Speaker desktop app) has no server to render
 * each room, so it prerenders one placeholder page that every /room/<id> is served from
 * and reads the real room ID from the URL in the browser. Regular builds render rooms
 * on demand.
 */
export function generateStaticParams() {
  return process.env.BEATSYNC_STATIC_EXPORT === "1" ? [{ roomId: STATIC_ROOM_PLACEHOLDER }] : [];
}

export default async function Page({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;

  if (roomId === STATIC_ROOM_PLACEHOLDER) {
    return <RoomFromUrl />;
  }

  if (IS_DEMO_MODE && roomId !== DEMO_ROOM_ID) {
    redirect("/");
  }

  if (!validateFullRoomId(roomId)) {
    return <InvalidRoom roomId={roomId} />;
  }

  return <NewSyncer roomId={roomId} />;
}
