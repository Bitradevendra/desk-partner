import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import si from "systeminformation";
import pino from "pino";

const execFileAsync = promisify(execFile);
import {
  FrameType,
  encodeControlPayload,
  HarnessRpcReqSchema,
  type HarnessRpcReq,
} from "@petbot/protocol";
import type { HarnessServer } from "../transport/harness-server.js";

export interface TelemetrySnapshot {
  actionId: "TELEMETRY_SYNC";
  cpuLoadPct: number;
  ramUsedPct: number;
  gpuLoadPct: number;
  cpuPercent: number;
  ramPercent: number;
  gpuPercent: number;
  netRxKBps: number;
  netTxKBps: number;
  batteryPct: number;
  activeWindowTitle: string;
  activeAppName: string;
  activeWindow: string;
  activeApp: string;
  inMeeting: boolean;
  meetingActive: boolean;
  inDeepWorkIde: boolean;
  deepWorkActive: boolean;
  mediaPlaying: boolean;
  mediaTrack: string;
  unreadNotifications: number;
  timestampMs: number;
}

export interface TelemetryMonitorOptions {
  pollingIntervalMs?: number | undefined;
  server?: HarnessServer | undefined;
  logger?: pino.Logger | undefined;
  mock?: boolean | undefined;
}

/**
 * Real-time PC telemetry broadcaster and Smart Meeting / Deep-Work detector.
 */
export class TelemetryMonitor extends EventEmitter {
  private readonly pollingIntervalMs: number;
  private server: HarnessServer | null;
  private readonly logger: pino.Logger;
  public readonly isMock: boolean;

  private timer: NodeJS.Timeout | null = null;
  private isSampling = false;
  private lastSampleTime = Date.now();
  private lastNetRxBytes = 0;
  private lastNetTxBytes = 0;

  // Cached state for fast polling
  private cachedGpuLoad = 0;
  private cachedBatteryPct = 100;
  private cachedActiveWindow = { title: "Desktop", app: "explorer" };
  private cachedInMeeting = false;
  private cachedInDeepWorkIde = false;
  private processScanCounter = 0;

  // Mock override state for tests
  private mockState: Partial<TelemetrySnapshot> = {};

  constructor(options?: TelemetryMonitorOptions) {
    super();
    this.pollingIntervalMs = options?.pollingIntervalMs ?? 1000;
    this.server = options?.server ?? null;
    this.isMock = options?.mock ?? process.env["PETBOT_OS_MOCK"] === "1";
    this.logger =
      options?.logger ??
      pino({
        name: "telemetry-monitor",
        level: process.env["LOG_LEVEL"] ?? "info",
      });
  }

  public setServer(server: HarnessServer): void {
    this.server = server;
  }

  public setMockState(state: Partial<TelemetrySnapshot>): void {
    this.mockState = { ...this.mockState, ...state };
  }

  /**
   * Samples system telemetry and evaluates meeting/deep-work heuristics.
   */
  public async sample(): Promise<TelemetrySnapshot> {
    const now = Date.now();

    if (this.isMock) {
      const mockSnapshot: TelemetrySnapshot = {
        actionId: "TELEMETRY_SYNC",
        cpuLoadPct: this.mockState.cpuLoadPct ?? 35,
        ramUsedPct: this.mockState.ramUsedPct ?? 62,
        gpuLoadPct: this.mockState.gpuLoadPct ?? 18,
        cpuPercent: this.mockState.cpuPercent ?? this.mockState.cpuLoadPct ?? 35,
        ramPercent: this.mockState.ramPercent ?? this.mockState.ramUsedPct ?? 62,
        gpuPercent: this.mockState.gpuPercent ?? this.mockState.gpuLoadPct ?? 18,
        netRxKBps: this.mockState.netRxKBps ?? 120,
        netTxKBps: this.mockState.netTxKBps ?? 45,
        batteryPct: this.mockState.batteryPct ?? 98,
        activeWindowTitle: this.mockState.activeWindowTitle ?? "petbot_protocol.h - Visual Studio Code",
        activeAppName: this.mockState.activeAppName ?? "code",
        activeWindow: this.mockState.activeWindow ?? "petbot_protocol.h - Visual Studio Code",
        activeApp: this.mockState.activeApp ?? "code",
        inMeeting: this.mockState.inMeeting ?? false,
        meetingActive: this.mockState.meetingActive ?? this.mockState.inMeeting ?? false,
        inDeepWorkIde: this.mockState.inDeepWorkIde ?? true,
        deepWorkActive: this.mockState.deepWorkActive ?? this.mockState.inDeepWorkIde ?? true,
        mediaPlaying: this.mockState.mediaPlaying ?? false,
        mediaTrack: this.mockState.mediaTrack ?? "Lo-Fi Beats for Coding",
        unreadNotifications: this.mockState.unreadNotifications ?? 0,
        timestampMs: now,
      };
      return mockSnapshot;
    }

    try {
      // 1. Fast Load & Memory metrics
      const [load, mem] = await Promise.all([
        si.currentLoad().catch(() => ({ currentLoad: 0 })),
        si.mem().catch(() => ({ used: 0, total: 1 })),
      ]);

      const cpuLoadPct = Math.min(100, Math.max(0, Math.round(load.currentLoad)));
      const ramUsedPct = Math.min(
        100,
        Math.max(0, Math.round((mem.used / Math.max(1, mem.total)) * 100))
      );

      // 2. Network delta throughput calculation
      const dtSec = Math.max(0.1, (now - this.lastSampleTime) / 1000);
      this.lastSampleTime = now;

      let netRxKBps = 0;
      let netTxKBps = 0;

      try {
        const netStats = await si.networkStats().catch(() => []);
        const primary = netStats[0];
        if (primary) {
          if (typeof primary.rx_sec === "number" && typeof primary.tx_sec === "number") {
            netRxKBps = Math.round(primary.rx_sec / 1024);
            netTxKBps = Math.round(primary.tx_sec / 1024);
          } else if (this.lastNetRxBytes > 0) {
            netRxKBps = Math.round(Math.max(0, primary.rx_bytes - this.lastNetRxBytes) / (dtSec * 1024));
            netTxKBps = Math.round(Math.max(0, primary.tx_bytes - this.lastNetTxBytes) / (dtSec * 1024));
          }
          this.lastNetRxBytes = primary.rx_bytes;
          this.lastNetTxBytes = primary.tx_bytes;
        }
      } catch {
        // Network sampling fallback
      }

      // 3. Low-frequency background metrics (every ~3-5s or cached)
      this.processScanCounter++;
      if (this.processScanCounter % 3 === 0) {
        this.updateBackgroundMetrics();
      }

      const snapshot: TelemetrySnapshot = {
        actionId: "TELEMETRY_SYNC",
        cpuLoadPct,
        ramUsedPct,
        gpuLoadPct: this.cachedGpuLoad,
        cpuPercent: cpuLoadPct,
        ramPercent: ramUsedPct,
        gpuPercent: this.cachedGpuLoad,
        netRxKBps,
        netTxKBps,
        batteryPct: this.cachedBatteryPct,
        activeWindowTitle: this.cachedActiveWindow.title,
        activeAppName: this.cachedActiveWindow.app,
        activeWindow: this.cachedActiveWindow.title,
        activeApp: this.cachedActiveWindow.app,
        inMeeting: this.cachedInMeeting,
        meetingActive: this.cachedInMeeting,
        inDeepWorkIde: this.cachedInDeepWorkIde,
        deepWorkActive: this.cachedInDeepWorkIde,
        mediaPlaying: false,
        mediaTrack: "",
        unreadNotifications: 0,
        timestampMs: now,
      };

      return snapshot;
    } catch (err) {
      this.logger.warn({ err }, "[TelemetryMonitor] Failed to sample system metrics");
      return {
        actionId: "TELEMETRY_SYNC",
        cpuLoadPct: 0,
        ramUsedPct: 0,
        gpuLoadPct: 0,
        cpuPercent: 0,
        ramPercent: 0,
        gpuPercent: 0,
        netRxKBps: 0,
        netTxKBps: 0,
        batteryPct: 100,
        activeWindowTitle: "Desktop",
        activeAppName: "desktop",
        activeWindow: "Desktop",
        activeApp: "desktop",
        inMeeting: false,
        meetingActive: false,
        inDeepWorkIde: false,
        deepWorkActive: false,
        mediaPlaying: false,
        mediaTrack: "",
        unreadNotifications: 0,
        timestampMs: now,
      };
    }
  }

  /**
   * Broadcasts a sampled telemetry packet to the connected ESP32-S3 robot.
   */
  public broadcast(snapshot: TelemetrySnapshot): boolean {
    if (!this.server) {
      return false;
    }

    const rpcReq: HarnessRpcReq = {
      callId: `telemetry_${snapshot.timestampMs}`,
      method: "telemetry_sync",
      params: snapshot,
    };

    const payload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
    const sent = this.server.sendToRobot(FrameType.HARNESS_RPC_REQ, payload);

    if (sent) {
      this.emit("broadcast", snapshot);
    }
    return sent;
  }

  /**
   * Starts periodic polling and broadcasting.
   */
  public start(): void {
    if (this.timer) {
      return;
    }

    // Trigger initial sample immediately
    this.sample()
      .then((snapshot) => {
        this.emit("telemetry", snapshot);
        this.broadcast(snapshot);
      })
      .catch(() => {});

    this.timer = setInterval(async () => {
      if (this.isSampling) return;
      this.isSampling = true;
      try {
        const snapshot = await this.sample();
        this.emit("telemetry", snapshot);
        this.broadcast(snapshot);
      } finally {
        this.isSampling = false;
      }
    }, this.pollingIntervalMs);

    this.logger.info(
      { intervalMs: this.pollingIntervalMs, mock: this.isMock },
      "[TelemetryMonitor] Telemetry monitor started"
    );
  }

  /**
   * Stops the polling loop.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info("[TelemetryMonitor] Telemetry monitor stopped");
  }

  /**
   * Queries active foreground window name and process.
   */
  private async queryActiveWindow(): Promise<{ title: string; app: string }> {
    try {
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process | Where-Object { $_.MainWindowTitle } | Sort-Object -Descending WS | Select-Object -First 1 | ForEach-Object { "$($_.ProcessName)|$($_.MainWindowTitle)" })`,
          ],
          { timeout: 1500 }
        );
        const parts = stdout.trim().split("|");
        if (parts.length >= 2 && parts[0] && parts[1]) {
          return { app: parts[0], title: parts.slice(1).join("|") };
        }
      } else if (process.platform === "darwin") {
        const { stdout } = await execFileAsync(
          "osascript",
          [
            "-e",
            'tell application "System Events" to get name of first application process whose frontmost is true',
          ],
          { timeout: 1500 }
        );
        const app = stdout.trim();
        return { app: app || "Desktop", title: app || "Desktop" };
      } else if (process.platform === "linux") {
        const { stdout } = await execFileAsync(
          "xdotool",
          ["getwindowfocus", "getwindowname"],
          { timeout: 1500 }
        );
        const title = stdout.trim();
        return { app: "desktop", title: title || "Desktop" };
      }
    } catch {
      // Fallback
    }
    return { app: "Desktop", title: "Desktop" };
  }

  /**
   * Asynchronous background scan for GPU, Battery, Active Window, and Meeting Detection.
   */
  private updateBackgroundMetrics(): void {
    Promise.all([
      si.graphics().catch(() => ({ controllers: [] })),
      si.battery().catch(() => ({ percent: 100 })),
      this.queryActiveWindow(),
      si.processes().catch(() => ({ list: [] })),
    ])
      .then(([graphics, battery, win, procList]) => {
        // GPU
        const primaryGpu = graphics.controllers?.[0];
        if (primaryGpu && typeof primaryGpu.utilizationGpu === "number") {
          this.cachedGpuLoad = Math.min(100, Math.max(0, Math.round(primaryGpu.utilizationGpu)));
        }

        // Battery
        if (typeof battery.percent === "number") {
          this.cachedBatteryPct = Math.min(100, Math.max(0, Math.round(battery.percent)));
        }

        // Active Window
        this.cachedActiveWindow = win;

        // Smart Meeting Detector
        this.cachedInMeeting = this.detectMeeting(win.title, win.app, procList.list);

        // Smart Deep-Work IDE Detector
        this.cachedInDeepWorkIde = this.detectDeepWork(win.title, win.app, procList.list);
      })
      .catch(() => {});
  }

  /**
   * Evaluates whether Zoom, Teams, Meet, Discord, OBS, or Slack is active.
   */
  public detectMeeting(
    windowTitle: string,
    windowApp: string,
    processes: Array<{ name?: string }> = []
  ): boolean {
    const titleLower = windowTitle.toLowerCase();
    const appLower = windowApp.toLowerCase();

    // Direct active window checks
    if (
      titleLower.includes("zoom meeting") ||
      titleLower.includes("zoom") ||
      titleLower.includes("microsoft teams") ||
      titleLower.includes("meet - ") ||
      titleLower.includes("google meet") ||
      titleLower.includes("discord") ||
      titleLower.includes("slack call") ||
      titleLower.includes("slack huddle") ||
      titleLower.includes("obs ")
    ) {
      return true;
    }

    if (
      appLower.includes("zoom") ||
      appLower.includes("teams") ||
      appLower.includes("discord") ||
      appLower.includes("obs")
    ) {
      return true;
    }

    // Process list checks
    const meetingProcessNames = [
      "zoom.exe",
      "zoom",
      "zoom.us",
      "teams.exe",
      "teams",
      "ms-teams.exe",
      "discord.exe",
      "discord",
      "obs64.exe",
      "obs32.exe",
      "obs",
      "webex.exe",
      "webex",
    ];

    for (const p of processes) {
      const name = p.name?.toLowerCase();
      if (name && meetingProcessNames.some((m) => name.includes(m))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Evaluates whether a primary programming IDE is currently focused.
   */
  public detectDeepWork(
    windowTitle: string,
    windowApp: string,
    processes: Array<{ name?: string }> = []
  ): boolean {
    const titleLower = windowTitle.toLowerCase();
    const appLower = windowApp.toLowerCase();

    if (
      titleLower.includes("visual studio code") ||
      titleLower.includes("cursor") ||
      titleLower.includes("pycharm") ||
      titleLower.includes("clion") ||
      titleLower.includes("intellij") ||
      titleLower.includes("webstorm") ||
      titleLower.includes("neovim") ||
      titleLower.includes("nvim") ||
      titleLower.includes("vim") ||
      titleLower.includes("xcode")
    ) {
      return true;
    }

    const ideProcessNames = [
      "code.exe",
      "code",
      "cursor.exe",
      "cursor",
      "idea64.exe",
      "idea.exe",
      "pycharm64.exe",
      "clion64.exe",
      "webstorm64.exe",
      "nvim.exe",
      "nvim",
      "vim.exe",
      "vim",
      "xcode",
    ];

    for (const p of processes) {
      const name = p.name?.toLowerCase();
      if (name && ideProcessNames.some((ide) => name.includes(ide))) {
        return true;
      }
    }

    return (
      appLower.includes("code") ||
      appLower.includes("cursor") ||
      appLower.includes("nvim") ||
      appLower.includes("vim") ||
      appLower.includes("idea")
    );
  }
}
