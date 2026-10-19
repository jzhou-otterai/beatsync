/**
 * Join the room and start playing as soon as clocks are synced, without the "Start System"
 * step. On for the copy of the web app the Beatsync Speaker desktop app hosts on the LAN,
 * where opening the join link should be all a listener does.
 */
export const AUTO_START = process.env.NEXT_PUBLIC_AUTO_START === "1";
