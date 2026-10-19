import { app, BrowserWindow, Menu, nativeImage, screen, Tray } from "electron";
import path from "node:path";
import type { BroadcasterStatus } from "./broadcaster";

const POPOVER_WIDTH = 300;
const POPOVER_HEIGHT = 228;

interface MenuBarOptions {
  preloadPath: string;
  onShowMain: () => void;
}

/**
 * Menu bar widget: a template icon (filled while live) that opens a small popover with
 * the stream status, the room volume slider and start/stop. The popover is a regular
 * renderer page (renderer/tray.html) sharing the main window's preload API.
 */
export class MenuBar {
  private tray: Tray;
  private popover: BrowserWindow | null = null;
  private readonly idleIcon: Electron.NativeImage;
  private readonly liveIcon: Electron.NativeImage;
  private isLive = false;

  constructor(private readonly opts: MenuBarOptions) {
    const resources = path.join(app.getAppPath(), "resources");
    // "Template" images are tinted by macOS for light/dark menu bars; @2x is picked up automatically
    this.idleIcon = nativeImage.createFromPath(path.join(resources, "trayTemplate.png"));
    this.liveIcon = nativeImage.createFromPath(path.join(resources, "trayLiveTemplate.png"));
    this.idleIcon.setTemplateImage(true);
    this.liveIcon.setTemplateImage(true);

    this.tray = new Tray(this.idleIcon);
    this.tray.setToolTip("Beatsync Speaker");
    this.tray.on("click", () => this.toggle());
    this.tray.on("right-click", () => {
      this.tray.popUpContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Beatsync Speaker", click: () => opts.onShowMain() },
          { type: "separator" },
          { label: "Quit Beatsync Speaker", role: "quit" },
        ])
      );
    });
  }

  updateStatus(status: BroadcasterStatus): void {
    const live = status.phase === "live";
    if (live !== this.isLive) {
      this.isLive = live;
      this.tray.setImage(live ? this.liveIcon : this.idleIcon);
    }
    this.tray.setToolTip(
      live
        ? `Beatsync Speaker: live to ${status.listeners} device${status.listeners === 1 ? "" : "s"}`
        : "Beatsync Speaker"
    );
  }

  private createPopover(): BrowserWindow {
    const popover = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      vibrancy: "popover",
      visualEffectState: "active",
      roundedCorners: true,
      webPreferences: {
        preload: this.opts.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    popover.loadFile(path.join(app.getAppPath(), "renderer", "tray.html"));
    // Behave like a menu: clicking anywhere else dismisses it
    popover.on("blur", () => popover.hide());
    popover.on("closed", () => {
      if (this.popover === popover) this.popover = null;
    });
    return popover;
  }

  private toggle(): void {
    this.popover ??= this.createPopover();
    const popover = this.popover;
    if (popover.isVisible()) {
      popover.hide();
      return;
    }

    // Centre under the menu bar icon, kept on screen
    const trayBounds = this.tray.getBounds();
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    const { workArea } = display;
    const x = Math.round(
      Math.min(
        Math.max(trayBounds.x + trayBounds.width / 2 - POPOVER_WIDTH / 2, workArea.x + 8),
        workArea.x + workArea.width - POPOVER_WIDTH - 8
      )
    );
    const y = Math.round(trayBounds.y + trayBounds.height + 4);
    popover.setPosition(x, y, false);
    popover.show();
    popover.focus();
  }

  /** Hide the popover (e.g. after it opened the main window) */
  hidePopover(): void {
    this.popover?.hide();
  }
}
