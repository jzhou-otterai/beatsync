"use client";

import { cn } from "@/lib/utils";
import { useGlobalStore } from "@/store/global";
import { Bluetooth } from "lucide-react";

// Typical Bluetooth output delays: AirPods ~150-200ms, most speakers 200-300ms
const PRESETS_MS = [0, 150, 200, 250, 300, 400] as const;

/**
 * Bluetooth headphones and speakers play everything a few hundred ms late, and browsers
 * don't say how late. Tapping cycles through typical delays; this device then plays
 * that much earlier, and a live stream's buffer grows to make room for it. Fine-tune
 * with the timing nudge.
 */
export const BluetoothDelayControl = ({ className }: { className?: string }) => {
  const bluetoothDelayMs = useGlobalStore((state) => state.bluetoothDelayMs);
  const setBluetoothDelay = useGlobalStore((state) => state.setBluetoothDelay);

  // An unlisted value (e.g. from an older preset list) cycles back to off
  const next = () =>
    setBluetoothDelay(
      PRESETS_MS[(PRESETS_MS.indexOf(bluetoothDelayMs as (typeof PRESETS_MS)[number]) + 1) % PRESETS_MS.length]
    );

  const on = bluetoothDelayMs > 0;
  return (
    <button
      type="button"
      onClick={next}
      title="Using Bluetooth headphones or a speaker? Tap to match its delay"
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-mono transition-colors cursor-pointer",
        on
          ? "bg-blue-500/15 text-blue-300 hover:bg-blue-500/25"
          : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700",
        className
      )}
    >
      <Bluetooth className="h-3.5 w-3.5" />
      {on ? `Bluetooth ${bluetoothDelayMs}ms` : "Bluetooth off"}
    </button>
  );
};
