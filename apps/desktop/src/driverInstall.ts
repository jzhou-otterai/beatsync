import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const HAL_PLUGINS_DIR = "/Library/Audio/Plug-Ins/HAL";
const INSTALLED_DRIVER = path.join(HAL_PLUGINS_DIR, "Beatsync.driver");

const bundleVersion = (driverPath: string): string | null => {
  try {
    const plist = readFileSync(path.join(driverPath, "Contents", "Info.plist"), "utf8");
    return /<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
};

/** Whether the bundled driver is missing from the system or newer than the installed copy */
export const driverNeedsInstall = (bundledDriver: string): boolean => {
  if (!existsSync(INSTALLED_DRIVER)) return true;
  const bundled = Number(bundleVersion(bundledDriver) ?? 0);
  const installed = Number(bundleVersion(INSTALLED_DRIVER) ?? 0);
  return bundled > installed;
};

/** Quote a string for a POSIX shell */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Quote a string as an AppleScript string literal */
const asQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export type DriverInstallResult = { ok: true } | { ok: false; cancelled: boolean; message: string };

/**
 * Copy the bundled driver into the system HAL plug-ins folder and restart Core Audio
 * so the "Beatsync" device appears. Writing to /Library needs admin rights, so this
 * goes through macOS's own administrator prompt — the app never sees the password.
 */
export const installDriver = (bundledDriver: string): Promise<DriverInstallResult> => {
  if (!existsSync(bundledDriver)) {
    return Promise.resolve({ ok: false, cancelled: false, message: `Driver missing at ${bundledDriver}` });
  }

  const shellCommand = [
    `mkdir -p ${shQuote(HAL_PLUGINS_DIR)}`,
    `rm -rf ${shQuote(INSTALLED_DRIVER)}`,
    `cp -R ${shQuote(bundledDriver)} ${shQuote(HAL_PLUGINS_DIR + "/")}`,
    // Core Audio only scans for plug-ins when it starts
    "(launchctl kickstart -k system/com.apple.audio.coreaudiod || killall coreaudiod)",
  ].join(" && ");

  const script =
    `do shell script ${asQuote(shellCommand)} with administrator privileges ` +
    `with prompt ${asQuote("Beatsync Speaker wants to install the Beatsync audio device.")}`;

  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], (err) => {
      if (!err) return resolve({ ok: true });
      const cancelled = /User canceled|\(-128\)/.test(err.message);
      resolve({
        ok: false,
        cancelled,
        message: cancelled ? "Install cancelled" : `Couldn't install the audio device: ${err.message.trim()}`,
      });
    });
  });
};
