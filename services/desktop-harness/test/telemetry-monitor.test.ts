import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TelemetryMonitor, type TelemetrySnapshot } from "../src/os/telemetry-monitor.js";
import { FrameType, decodeFrame, decodeControlPayload, HarnessRpcReqSchema } from "@petbot/protocol";

describe("TelemetryMonitor Real-Time PC Broadcaster & Smart Meeting Detector", () => {
  let monitor: TelemetryMonitor;

  beforeEach(() => {
    monitor = new TelemetryMonitor({
      pollingIntervalMs: 50,
      mock: true,
    });
  });

  afterEach(() => {
    monitor.stop();
  });

  it("samples full telemetry snapshot matching protocol specifications", async () => {
    const snapshot = await monitor.sample();

    expect(snapshot.actionId).toBe("TELEMETRY_SYNC");
    expect(snapshot.cpuLoadPct).toBeGreaterThanOrEqual(0);
    expect(snapshot.cpuLoadPct).toBeLessThanOrEqual(100);
    expect(snapshot.ramUsedPct).toBeGreaterThanOrEqual(0);
    expect(snapshot.ramUsedPct).toBeLessThanOrEqual(100);
    expect(snapshot.gpuLoadPct).toBeGreaterThanOrEqual(0);
    expect(snapshot.gpuLoadPct).toBeLessThanOrEqual(100);

    expect(snapshot.netRxKBps).toBeGreaterThanOrEqual(0);
    expect(snapshot.netTxKBps).toBeGreaterThanOrEqual(0);
    expect(snapshot.batteryPct).toBeGreaterThanOrEqual(0);
    expect(snapshot.batteryPct).toBeLessThanOrEqual(100);

    expect(snapshot.activeWindowTitle).toBeDefined();
    expect(snapshot.activeAppName).toBeDefined();
    expect(typeof snapshot.inMeeting).toBe("boolean");
    expect(typeof snapshot.inDeepWorkIde).toBe("boolean");
    expect(snapshot.timestampMs).toBeGreaterThan(0);
  });

  it("detects Zoom, Microsoft Teams, Meet, Discord, and Slack as active meetings", () => {
    // Zoom active window
    expect(monitor.detectMeeting("Zoom Meeting - Sprint Planning", "zoom.exe")).toBe(true);

    // Microsoft Teams call
    expect(monitor.detectMeeting("Team Sync | Microsoft Teams", "teams.exe")).toBe(true);

    // Google Meet in browser
    expect(monitor.detectMeeting("Meet - abc-defg-hij - Google Chrome", "chrome.exe")).toBe(true);

    // Discord Voice
    expect(monitor.detectMeeting("Discord | #voice-chat", "discord.exe")).toBe(true);

    // Slack Huddle
    expect(monitor.detectMeeting("Slack Huddle with engineering", "slack.exe")).toBe(true);

    // OBS Studio streaming
    expect(monitor.detectMeeting("OBS 30.1.0 - Profile: Live", "obs64.exe")).toBe(true);

    // Regular desktop should NOT trigger meeting
    expect(monitor.detectMeeting("File Explorer", "explorer.exe")).toBe(false);
  });

  it("detects VS Code, Cursor, JetBrains, and Neovim as Deep-Work IDEs", () => {
    expect(monitor.detectDeepWork("main.cpp - Visual Studio Code", "code.exe")).toBe(true);
    expect(monitor.detectDeepWork("telemetry-monitor.ts - Cursor", "cursor.exe")).toBe(true);
    expect(monitor.detectDeepWork("PetBot.java - IntelliJ IDEA", "idea64.exe")).toBe(true);
    expect(monitor.detectDeepWork("nvim widget_vm.cpp", "nvim.exe")).toBe(true);

    // Regular browsing should NOT trigger deep work
    expect(monitor.detectDeepWork("YouTube - Relaxing Music", "chrome.exe")).toBe(false);
  });

  it("broadcasts compact telemetry frame to connected robot session", async () => {
    const mockServer = {
      sendToRobot: vi.fn().mockReturnValue(true),
    };

    monitor.setServer(mockServer as any);

    const snapshot = await monitor.sample();
    const sent = monitor.broadcast(snapshot);

    expect(sent).toBe(true);
    expect(mockServer.sendToRobot).toHaveBeenCalledWith(
      FrameType.HARNESS_RPC_REQ,
      expect.any(Uint8Array)
    );

    // Decode broadcast payload to verify exact fields
    const sentPayload = mockServer.sendToRobot.mock.calls[0]![1];
    const rpcReq = decodeControlPayload(HarnessRpcReqSchema, sentPayload);

    expect(rpcReq.method).toBe("telemetry_sync");
    expect(rpcReq.params["actionId"]).toBe("TELEMETRY_SYNC");
    expect(rpcReq.params["cpuPercent"]).toBe(snapshot.cpuLoadPct);
    expect(rpcReq.params["ramPercent"]).toBe(snapshot.ramUsedPct);
    expect(rpcReq.params["meetingActive"]).toBe(snapshot.inMeeting);
    expect(rpcReq.params["deepWorkActive"]).toBe(snapshot.inDeepWorkIde);
  });

  it("emits telemetry event on periodic timer loop", async () => {
    let eventReceived = false;

    monitor.on("telemetry", (data: TelemetrySnapshot) => {
      if (data.actionId === "TELEMETRY_SYNC") {
        eventReceived = true;
      }
    });

    monitor.start();

    // Await short interval for event
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (eventReceived) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    expect(eventReceived).toBe(true);
  });
});
