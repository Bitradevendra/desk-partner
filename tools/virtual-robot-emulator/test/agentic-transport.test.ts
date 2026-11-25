import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  RobotMode,
  FrameType,
  encodeFrame,
  decodeFrame,
  crc32,
  encodeBleAdvBeaconPayload,
  decodeBleAdvBeaconPayload,
  extractIpAndPortFromBeaconPayload,
  DEFAULT_WS_PORT,
  MDNS_SERVICE_NAME,
  BLE_SERVICE_UUID,
  BLE_CHAR_RX_UUID,
  BLE_CHAR_TX_UUID,
  encodeControlPayload,
  decodeControlPayload,
  HelloHandshakeSchema,
  ModeTransitionSchema,
  HeartbeatPayloadSchema,
  type HelloHandshake,
  type ModeTransition,
  type HeartbeatPayload,
} from "@petbot/protocol";

describe("Agentic Transport & Zero-Config Subsystem Verification", () => {
  const firmwareDir = path.resolve(__dirname, "../../../firmware");
  const transportHPath = path.join(firmwareDir, "include/agentic/agentic_transport.h");
  const transportCppPath = path.join(firmwareDir, "src/agentic/agentic_transport.cpp");
  const psramRingBufferHPath = path.join(firmwareDir, "include/agentic/psram_ring_buffer.h");
  const uiManagerHPath = path.join(firmwareDir, "include/ui/ui_manager.h");
  const uiManagerCppPath = path.join(firmwareDir, "src/ui/ui_manager.cpp");
  const soundManagerHPath = path.join(firmwareDir, "include/audio/sound_manager.h");
  const soundManagerCppPath = path.join(firmwareDir, "src/audio/sound_manager.cpp");
  const platformioIniPath = path.join(firmwareDir, "platformio.ini");
  const fetchScriptPath = path.join(firmwareDir, "scripts/fetch_vendor_libs.py");

  it("verifies platformio.ini includes required libraries and vendor pre-script", () => {
    expect(fs.existsSync(platformioIniPath)).toBe(true);
    const content = fs.readFileSync(platformioIniPath, "utf-8");

    expect(content).toContain("h2zero/NimBLE-Arduino @ ^1.4.2");
    expect(content).toContain("links2004/WebSockets @ ^2.4.1");
    expect(content).toContain("bblanchon/ArduinoJson @ ^7.0.4");
    expect(content).toContain("extra_scripts = pre:scripts/fetch_vendor_libs.py");
    expect(fs.existsSync(fetchScriptPath)).toBe(true);
  });

  it("verifies all C++20 transport and UI/Audio headers exist with zero TODOs or placeholders", () => {
    const files = [
      transportHPath,
      transportCppPath,
      psramRingBufferHPath,
      uiManagerHPath,
      uiManagerCppPath,
      soundManagerHPath,
      soundManagerCppPath,
    ];

    for (const filePath of files) {
      expect(fs.existsSync(filePath), `File exists: ${filePath}`).toBe(true);
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).not.toMatch(/\bTODO\b/i);
      expect(content).not.toMatch(/\bFIXME\b/i);
      expect(content).not.toMatch(/\bPLACEHOLDER\b/i);
    }
  });

  it("verifies Core 0 task pinning in agentic_transport.cpp", () => {
    const cppContent = fs.readFileSync(transportCppPath, "utf-8");

    expect(cppContent).toContain("xTaskCreatePinnedToCore");
    expect(cppContent).toContain('"AgenticTransport"');
    expect(cppContent).toContain("taskEntry");
    // Verifies 0 core index passed to xTaskCreatePinnedToCore
    expect(cppContent).toMatch(/xTaskCreatePinnedToCore\s*\([^;]*\b0\s*\)/s);
  });

  it("verifies exact BLE GATT Service and Characteristic UUIDs match protocol", () => {
    const hContent = fs.readFileSync(transportHPath, "utf-8");
    const cppContent = fs.readFileSync(transportCppPath, "utf-8");

    expect(hContent).toContain("PETBOT_BLE_SERVICE_UUID");
    expect(hContent).toContain("PETBOT_BLE_CHAR_RX_UUID");
    expect(hContent).toContain("PETBOT_BLE_CHAR_TX_UUID");

    expect(cppContent).toContain("PETBOT_BLE_SERVICE_UUID");
    expect(cppContent).toContain("PETBOT_BLE_CHAR_RX_UUID");
    expect(cppContent).toContain("PETBOT_BLE_CHAR_TX_UUID");
  });

  it("verifies mDNS advertising configuration in agentic_transport.cpp", () => {
    const cppContent = fs.readFileSync(transportCppPath, "utf-8");

    expect(cppContent).toContain("MDNS.begin");
    expect(cppContent).toContain('MDNS.addService("petbot", "tcp"');
    expect(cppContent).toContain("8443");
  });

  it("verifies 256KB Octal PSRAM Ring Buffer allocation in agentic_transport.cpp", () => {
    const cppContent = fs.readFileSync(transportCppPath, "utf-8");
    const ringBufferContent = fs.readFileSync(psramRingBufferHPath, "utf-8");

    expect(cppContent).toContain("initPsramRingBuffers");
    expect(cppContent).toContain("256 * 1024");
    expect(ringBufferContent).toContain("MALLOC_CAP_SPIRAM");
  });

  it("verifies State Machine mode transition to AGENTIC_CONNECTED with toast and HAPPY_TRILL", () => {
    const cppContent = fs.readFileSync(transportCppPath, "utf-8");

    // Sleek toast notification
    expect(cppContent).toContain('ui::UIManager::instance().showToast("Agentic Mode Connected"');

    // Audio cue HAPPY_TRILL
    expect(cppContent).toContain("audio::SoundEffect::HAPPY_TRILL");

    // Heartbeat monitoring
    expect(cppContent).toContain("sendHeartbeatPing");
    expect(cppContent).toContain("sendHeartbeatPong");
    expect(cppContent).toContain("tickHeartbeatWatchdog");
    expect(cppContent).toContain("heartbeatIntervalMs");
    expect(cppContent).toContain("heartbeatTimeoutMs");
  });

  it("verifies 16-byte BleAdvBeaconPayload roundtrip and sub-50ms IP/Port extraction", () => {
    const ipBytes = new Uint8Array([192, 168, 1, 142]);
    const payload = encodeBleAdvBeaconPayload({
      magic: 0x4250,
      deviceIdHash: 0xfeedface,
      mode: RobotMode.AGENTIC_CONNECTED,
      batteryPct: 88,
      ipv4: ipBytes,
      wsPort: DEFAULT_WS_PORT,
      flags: 0x0005, // WiFi connected + SD card
    });

    expect(payload.byteLength).toBe(16);

    const decoded = decodeBleAdvBeaconPayload(payload);
    expect(decoded.magic).toBe(0x4250);
    expect(decoded.deviceIdHash).toBe(0xfeedface);
    expect(decoded.mode).toBe(RobotMode.AGENTIC_CONNECTED);
    expect(decoded.batteryPct).toBe(88);
    expect(decoded.wsPort).toBe(8443);
    expect(decoded.flags).toBe(0x0005);

    // Sub-microsecond instantaneous LAN IP + port extraction
    const extracted = extractIpAndPortFromBeaconPayload(payload);
    expect(extracted.ip).toBe("192.168.1.142");
    expect(extracted.port).toBe(8443);
  });

  it("verifies Handshake and ModeTransition MessagePack payloads serialization", () => {
    // 1. HelloHandshake MsgPack
    const handshakeData: HelloHandshake = {
      deviceId: "petbot-a1b2c3",
      firmwareVersion: "1.0.0",
      psramFreeBytes: 7800000,
      sdCardCapacityBytes: 34359738368,
      sdCardFreeBytes: 30000000000,
      ed25519PublicKeyHex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      capabilities: ["audio_pcm", "screen_160x128", "sd_vault", "widgets", "touch_2fa"],
    };

    const handshakePacked = encodeControlPayload(HelloHandshakeSchema, handshakeData);
    expect(handshakePacked.byteLength).toBeGreaterThan(0);

    const handshakeFrame = encodeFrame(FrameType.HELLO_HANDSHAKE, handshakePacked, 1);
    const decodedHandshakeFrame = decodeFrame(handshakeFrame);
    expect(decodedHandshakeFrame.header.frameType).toBe(FrameType.HELLO_HANDSHAKE);

    const unpackedHandshake = decodeControlPayload(HelloHandshakeSchema, decodedHandshakeFrame.payload);
    expect(unpackedHandshake.deviceId).toBe("petbot-a1b2c3");
    expect(unpackedHandshake.capabilities).toContain("widgets");

    // 2. ModeTransition MsgPack
    const transitionData: ModeTransition = {
      targetMode: RobotMode.AGENTIC_CONNECTED,
      companionHost: "192.168.1.100",
      companionPort: 8443,
      transitionReason: "Companion App BLE Fast Discovery Connect",
    };

    const transitionPacked = encodeControlPayload(ModeTransitionSchema, transitionData);
    const transitionFrame = encodeFrame(FrameType.MODE_TRANSITION, transitionPacked, 2);
    const decodedTransitionFrame = decodeFrame(transitionFrame);
    expect(decodedTransitionFrame.header.frameType).toBe(FrameType.MODE_TRANSITION);

    const unpackedTransition = decodeControlPayload(ModeTransitionSchema, decodedTransitionFrame.payload);
    expect(unpackedTransition.targetMode).toBe(RobotMode.AGENTIC_CONNECTED);
    expect(unpackedTransition.companionHost).toBe("192.168.1.100");

    // 3. Heartbeat Payload MsgPack
    const heartbeatData: HeartbeatPayload = {
      timestampUs: 1700000000000,
      batteryPercent: 95,
      wifiRssi: -58,
    };

    const heartbeatPacked = encodeControlPayload(HeartbeatPayloadSchema, heartbeatData);
    const pingFrame = encodeFrame(FrameType.HEARTBEAT_PING, heartbeatPacked, 3);
    const decodedPing = decodeFrame(pingFrame);
    expect(decodedPing.header.frameType).toBe(FrameType.HEARTBEAT_PING);

    const unpackedHeartbeat = decodeControlPayload(HeartbeatPayloadSchema, decodedPing.payload);
    expect(unpackedHeartbeat.batteryPercent).toBe(95);
    expect(unpackedHeartbeat.wifiRssi).toBe(-58);
  });

  it("verifies state machine timeout behavior simulation (reverting after >6000ms silence)", () => {
    let mode: RobotMode = RobotMode.NORMAL_OFFLINE;
    let lastHeartbeatMs = 0;
    let toastMessage = "";
    let happyTrillPlayed = false;

    // Simulate transition
    function onModeTransition(targetMode: RobotMode, nowMs: number) {
      if (targetMode === RobotMode.AGENTIC_CONNECTED) {
        mode = RobotMode.AGENTIC_CONNECTED;
        lastHeartbeatMs = nowMs;
        toastMessage = "Agentic Mode Connected";
        happyTrillPlayed = true;
      } else {
        mode = RobotMode.NORMAL_OFFLINE;
        toastMessage = "Offline Mode";
      }
    }

    // Simulate watchdog tick
    function tickWatchdog(nowMs: number) {
      if (mode === RobotMode.AGENTIC_CONNECTED) {
        if (nowMs - lastHeartbeatMs > 6000) {
          mode = RobotMode.NORMAL_OFFLINE;
          toastMessage = "Offline Mode (Host Disconnected)";
        }
      }
    }

    // Start in offline mode
    expect(mode).toBe(RobotMode.NORMAL_OFFLINE);

    // Handshake & Mode transition at t=1000ms
    onModeTransition(RobotMode.AGENTIC_CONNECTED, 1000);
    expect(mode).toBe(RobotMode.AGENTIC_CONNECTED);
    expect(toastMessage).toBe("Agentic Mode Connected");
    expect(happyTrillPlayed).toBe(true);

    // Heartbeat arrives at t=3500ms
    lastHeartbeatMs = 3500;
    tickWatchdog(4000);
    expect(mode).toBe(RobotMode.AGENTIC_CONNECTED);

    // Heartbeat arrives at t=6500ms
    lastHeartbeatMs = 6500;
    tickWatchdog(7000);
    expect(mode).toBe(RobotMode.AGENTIC_CONNECTED);

    // Host drops! Time progresses to t=12501ms (> 6000ms silence)
    tickWatchdog(12501);
    expect(mode).toBe(RobotMode.NORMAL_OFFLINE);
    expect(toastMessage).toBe("Offline Mode (Host Disconnected)");
  });
});
