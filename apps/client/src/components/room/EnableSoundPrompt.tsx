"use client";
import { audioContextManager, isAudioContextPaused } from "@/lib/audioContextManager";
import { useGlobalStore } from "@/store/global";
import { Volume2 } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * With AUTO_START there's no "Start System" click, and browsers only let audio start
 * after the page gets a tap or key press (iOS always; Chrome and Safari for a site you
 * haven't played media on). While audio is held back, any tap or key press turns it on;
 * this overlay says so.
 */
export const EnableSoundPrompt = () => {
  const hasStarted = useGlobalStore((state) => state.hasUserStartedSystem);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!hasStarted) return;
    const check = () => setBlocked(isAudioContextPaused(audioContextManager.getState()));
    const unlock = () =>
      void audioContextManager
        .resume()
        .catch(() => {})
        .finally(check);
    check();
    const timer = setInterval(check, 500);
    for (const event of ["pointerdown", "keydown", "touchend"]) {
      document.addEventListener(event, unlock, { capture: true });
    }
    return () => {
      clearInterval(timer);
      for (const event of ["pointerdown", "keydown", "touchend"]) {
        document.removeEventListener(event, unlock, { capture: true });
      }
    };
  }, [hasStarted]);

  if (!blocked) return null;
  return (
    <button
      type="button"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-neutral-950/85 text-white backdrop-blur-sm cursor-pointer"
    >
      <Volume2 className="size-8 text-primary" />
      <span className="text-base font-medium">Tap anywhere to turn on sound</span>
      <span className="text-sm text-neutral-400">Your browser needs a tap before it plays audio</span>
    </button>
  );
};
