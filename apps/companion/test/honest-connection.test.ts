import { describe, it, expect, beforeEach } from "vitest";
import { RobotMode, EmotionId, FrameType, encodeFrame, encodeAudioUplinkFrame } from "@petbot/protocol";
import { RobotConnectionManager, robotConnection } from "../src/services/robot-connection.js";
import { usePetBotStore } from "../src/store/usePetBotStore.js";
import { automationStudio } from "../src/services/automation-studio.js";
import { pcm16ToWavBytes } from "../src/services/gemini-voice-client.js";

describe("Honest Connectivity & Zero Fake State", () => {
  beforeEach(() => {
    robotConnection.disconnect();
  });

  it("initializes disconnected telemetry with zeroed offline values instead of fake readings", () => {
    const manager = new RobotConnectionManager();
    const telem = manager.getTelemetry();

    expect(manager.getState()).toBe("SEARCHING");
    expect(manager.isConnected()).toBe(false);
    expect(manager.isSimulatorActive()).toBe(false);
    expect(telem.mode).toBe(RobotMode.NORMAL_OFFLINE);
    expect(telem.batteryPct).toBe(0);
    expect(telem.rssi).toBe(0);
    expect(telem.pingMs).toBe(0);
    expect(telem.petMood).toBe(EmotionId.IDLE);
  });

  it("stays in SEARCHING when connect(false) finds no Bluetooth or WebSocket device", async () => {
    const manager = new RobotConnectionManager();
    const state = await manager.connect(false, "127.0.0.1", 19999);

    expect(state).toBe("SEARCHING");
    expect(manager.getState()).toBe("SEARCHING");
    expect(manager.isConnected()).toBe(false);
    expect(manager.isSimulatorActive()).toBe(false);
  });

  it("resets battery, mode, and ping telemetry on disconnect", () => {
    const manager = new RobotConnectionManager();
    manager.bootSimulator();
    expect(manager.getTelemetry().batteryPct).toBe(96);
    expect(manager.getState()).toBe("OFFLINE_SIMULATOR");
    expect(manager.isConnected()).toBe(false);

    manager.disconnect();
    const cleared = manager.getTelemetry();
    expect(manager.getState()).toBe("SEARCHING");
    expect(cleared.mode).toBe(RobotMode.NORMAL_OFFLINE);
    expect(cleared.batteryPct).toBe(0);
    expect(cleared.rssi).toBe(0);
    expect(cleared.pingMs).toBe(0);
  });

  it("keeps store vaultFiles empty and refuses fake transfers/deployments when offline", async () => {
    const state = usePetBotStore.getState();
    expect(state.vaultFiles).toEqual([]);
    expect(await state.refreshVault()).toBe(false);
    expect(await state.setMode(RobotMode.AGENTIC_CONNECTED)).toBe(false);

    const pkg = await automationStudio.compilePromptToAutomation("Morning briefing");
    const deployRes = await automationStudio.deployAndHostOnRobot(pkg);
    expect(deployRes.success).toBe(false);
    expect(deployRes.message).toContain("Not connected");
  });

  it("uses native Capacitor BLE bridge when navigator.bluetooth is absent on Android WebView", async () => {
    const writes: string[] = [];
    const mockPlugin = {
      checkPermissions: async () => ({ bluetooth: true }),
      requestPermission: async () => ({ bluetooth: true }),
      connectBleDevice: async () => ({
        connected: true,
        deviceName: "PetBot-Agent",
        mtuPayloadBytes: 240,
      }),
      writeBleRx: async ({ base64 }: { base64: string }) => {
        writes.push(base64);
        return { success: true };
      },
      disconnectBle: async () => ({ disconnected: true }),
      addListener: async () => ({ remove: async () => {} }),
    };

    (globalThis as any).window = {
      Capacitor: {
        isPluginAvailable: (name: string) => name === "PetBotMobileHarness",
        Plugins: { PetBotMobileHarness: mockPlugin },
      },
    };

    try {
      const manager = new RobotConnectionManager();
      const ok = await manager.connectBluetooth(true);
      expect(ok).toBe(true);
      expect(manager.getState()).toBe("AGENTIC_ONLINE");
      expect(manager.isConnected()).toBe(true);
      expect(writes.length).toBeGreaterThanOrEqual(2); // HELLO_HANDSHAKE + MODE_TRANSITION
      manager.disconnect();
      expect(manager.getState()).toBe("SEARCHING");
    } finally {
      delete (globalThis as any).window;
    }
  });

  it("assembles ESP32 AUDIO_UPLINK_FRAME chunks into a valid RIFF WAV on end-of-utterance and handles open-app commands honestly", async () => {
    const manager = new RobotConnectionManager();
    let capturedWav: Uint8Array | null = null;
    manager.onVoiceUtterance((wav) => {
      capturedWav = wav;
    });

    const pcmChunk = new Uint8Array(640);
    pcmChunk.fill(0x22);
    const frame1 = encodeFrame(
      FrameType.AUDIO_UPLINK_FRAME,
      encodeAudioUplinkFrame({ rmsEnergy: 1200, vadActive: true, audioData: pcmChunk }),
      1
    );
    const endFrame = encodeFrame(
      FrameType.AUDIO_UPLINK_FRAME,
      encodeAudioUplinkFrame({ rmsEnergy: 0, vadActive: false, audioData: new Uint8Array(0) }),
      2
    );

    (manager as any).parser.push(frame1);
    expect(capturedWav).toBeNull();
    (manager as any).parser.push(endFrame);

    expect(capturedWav).not.toBeNull();
    expect(capturedWav!.byteLength).toBe(44 + 640);
    expect(String.fromCharCode(...capturedWav!.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...capturedWav!.subarray(8, 12))).toBe("WAVE");

    const openRes = await usePetBotStore.getState().executeVoiceCommand("open YouTube");
    expect(openRes.actions).toContain("open_app: YouTube");
    expect(openRes.spokenText).toBe("Opening YouTube on your phone.");

    const unknownRes = await usePetBotStore.getState().executeVoiceCommand("quantum flux capacitor");
    expect(unknownRes.spokenText).not.toContain("Processed locally");

    const standaloneWav = pcm16ToWavBytes(pcmChunk, 16000);
    expect(standaloneWav.byteLength).toBe(44 + 640);
  });
});
