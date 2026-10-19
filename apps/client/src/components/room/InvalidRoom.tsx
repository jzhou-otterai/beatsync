export const InvalidRoom = ({ roomId }: { roomId: string }) => (
  <div className="flex flex-col items-center justify-center h-screen gap-2">
    <div>
      Invalid room ID: <span className="font-bold">{roomId}</span>.
    </div>
    <div className="text-sm text-gray-500">Please enter a valid 6-digit numeric code.</div>
  </div>
);
