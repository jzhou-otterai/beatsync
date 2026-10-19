// electron-builder afterPack hook: ad-hoc sign the app when no Developer ID identity is
// available. Apple Silicon refuses to launch a downloaded app whose signature is broken
// (electron-builder's own resource edits break Electron's), so "unsigned" isn't an option.
// With a Developer ID (CSC_LINK / keychain), electron-builder re-signs over this afterwards.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  // A universal build packs arm64 and x64 into "-temp" folders and merges them, which
  // needs their files identical; sign only the merged app
  if (context.appOutDir.endsWith("-temp")) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  console.log(`  • ad-hoc signed ${path.basename(app)}`);
};
