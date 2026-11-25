import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { WebSocket } from "ws";
import {
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
  DISPLAY_BUFFER_BYTES,
  FrameType,
  RobotMode,
  EmotionId,
  FLAG_FINAL_CHUNK,
  crc32,
  encodeFrame,
  decodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  encodeSdVaultChunk,
  decodeSdVaultAck,
  encodeAudioDownlinkFrame,
  decodeAudioUplinkFrame,
  SdVaultStatus,
  HelloHandshakeSchema,
  ModeTransitionSchema,
  Touch2FaChallengeSchema,
  SdVaultStartSchema,
  SdVaultAckSchema,
  SdVaultListReqSchema,
  SdVaultListResSchema,
  SubscriptionEntitlementSyncSchema,
  type DecodedFrame,
  type Touch2FaChallenge,
  type SdVaultStart,
} from "@petbot/protocol";
import {
  WidgetPackage,
  compileWidgetToBytecode,
} from "@petbot/widget-schema";
import {
  VirtualEsp32S3Robot,
  VirtualRobotServer,
} from "../src/index.js";

describe("VirtualEsp32S3Robot Hardware Software Twin", () => {
  let tempSdDir: string;
  let robot: VirtualEsp32S3Robot;
  let outboundFrames: Uint8Array[] = [];
  let triggeredSounds: string[] = [];
  let logMessages: string[] = [];

  beforeEach(() => {
    tempSdDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot-twin-test-"));
    outboundFrames = [];
    triggeredSounds = [];
    logMessages = [];

    robot = new VirtualEsp32S3Robot({
      deviceId: "PETBOT-TWIN-001",
      firmwareVersion: "2.5.0-alpha",
      sdDirectory: tempSdDir,
      onFrameOutbound: (frame) => outboundFrames.push(frame),
      onSoundTriggered: (sound) => triggeredSounds.push(sound),
      onLogMessage: (msg) => logMessages.push(msg),
    });
  });

  afterEach(() => {
    robot.dispose();
    if (fs.existsSync(tempSdDir)) {
      fs.rmSync(tempSdDir, { recursive: true, force: true });
    }
  });

  describe("1. Display Twin & Telemetry", () => {
    it("initializes with exact 160x128 RGB565 framebuffer and default telemetry", () => {
      const dims = robot.getDisplayDimensions();
      expect(dims.width).toBe(DISPLAY_WIDTH);
      expect(dims.height).toBe(DISPLAY_HEIGHT);
      expect(dims.bufferBytes).toBe(DISPLAY_BUFFER_BYTES);

      const fb = robot.getFramebuffer();
      expect(fb.length).toBe(DISPLAY_WIDTH * DISPLAY_HEIGHT);

      const snapshot = robot.getTelemetrySnapshot();
      expect(snapshot.deviceId).toBe("PETBOT-TWIN-001");
      expect(snapshot.firmwareVersion).toBe("2.5.0-alpha");
      expect(snapshot.mode).toBe(RobotMode.AGENTIC_CONNECTED);
      expect(snapshot.petMood).toBe(EmotionId.HAPPY);
      expect(snapshot.batteryPct).toBe(98);
      expect(snapshot.isCharging).toBe(false);
      expect(snapshot.ed25519PublicKeyHex).toHaveLength(64);
    });

    it("blits direct raw RGB565 frames onto framebuffer", () => {
      const rawFrame = new Uint8Array(DISPLAY_BUFFER_BYTES);
      // Fill with test color 0xF800 (Pure Red in RGB565, little endian: low=0x00, high=0xF8)
      for (let i = 0; i < rawFrame.length; i += 2) {
        rawFrame[i] = 0x00;
        rawFrame[i + 1] = 0xf8;
      }

      robot.renderDirectFrame(rawFrame);
      const fb = robot.getFramebuffer();
      expect(fb[0]).toBe(0xf800);
      expect(fb[100]).toBe(0xf800);
    });
  });

  describe("2. Control Plane Binary Handshake & Mode Transitions", () => {
    it("responds to HEARTBEAT_PING with HEARTBEAT_PONG preserving sequence ID", () => {
      const pingFrame = encodeFrame(FrameType.HEARTBEAT_PING, new Uint8Array(0), 42);
      const result = robot.handleInboundFrame(pingFrame);

      expect(result.response).toBeDefined();
      const decoded = decodeFrame(result.response!);
      expect(decoded.header.frameType).toBe(FrameType.HEARTBEAT_PONG);
      expect(decoded.header.seqId).toBe(42);
    });

    it("responds to HELLO_HANDSHAKE with full device capabilities and public key", () => {
      const helloFrame = encodeFrame(FrameType.HELLO_HANDSHAKE, new Uint8Array(0), 1);
      const result = robot.handleInboundFrame(helloFrame);

      expect(result.response).toBeDefined();
      const decoded = decodeFrame(result.response!);
      expect(decoded.header.frameType).toBe(FrameType.HELLO_HANDSHAKE);

      const handshake = decodeControlPayload(HelloHandshakeSchema, decoded.payload);
      expect(handshake.deviceId).toBe("PETBOT-TWIN-001");
      expect(handshake.firmwareVersion).toBe("2.5.0-alpha");
      expect(handshake.capabilities).toContain("TFT_160X128");
      expect(handshake.capabilities).toContain("TOUCH_CAP");
      expect(handshake.capabilities).toContain("PSRAM_8MB");
      expect(handshake.capabilities).toContain("SD_MMC");
      expect(handshake.ed25519PublicKeyHex).toBe(robot.getTelemetrySnapshot().ed25519PublicKeyHex);
    });

    it("transitions between Normal Offline and Agentic Connected modes", () => {
      const toAgentic = encodeFrame(
        FrameType.MODE_TRANSITION,
        encodeControlPayload(ModeTransitionSchema, {
          targetMode: RobotMode.AGENTIC_CONNECTED,
          companionHost: "127.0.0.1",
          companionPort: 8443,
          transitionReason: "Manual pair test",
        }),
        2
      );
      robot.handleInboundFrame(toAgentic);
      expect(robot.getTelemetrySnapshot().mode).toBe(RobotMode.AGENTIC_CONNECTED);

      const toOffline = encodeFrame(
        FrameType.MODE_TRANSITION,
        encodeControlPayload(ModeTransitionSchema, {
          targetMode: RobotMode.NORMAL_OFFLINE,
          companionHost: "127.0.0.1",
          companionPort: 8443,
          transitionReason: "Manual unpair test",
        }),
        3
      );
      robot.handleInboundFrame(toOffline);
      expect(robot.getTelemetrySnapshot().mode).toBe(RobotMode.NORMAL_OFFLINE);
    });

    it("syncs subscription entitlements", () => {
      const sync = encodeFrame(
        FrameType.SUBSCRIPTION_ENTITLEMENT_SYNC,
        encodeControlPayload(SubscriptionEntitlementSyncSchema, {
          jwtToken: "test-jwt-token-string-12345",
          tier: "PRO",
          expiresAt: Date.now() + 86400000,
          enabledPersonas: ["STUDY_BUDDY", "FOCUS_PET"],
        }),
        4
      );
      robot.handleInboundFrame(sync);
      expect(logMessages.some((msg) => msg.includes("PRO"))).toBe(true);
    });
  });

  describe("3. Virtual Octal PSRAM Widget VM Runtime", () => {
    const testWidget: WidgetPackage = {
      manifest: {
        id: "habits-counter",
        name: "Habits Counter",
        version: "1.0.0",
        author: "Dev Twin",
        iconId: 4,
        refreshIntervalMs: 50,
        requiresAgenticMode: false,
      },
      state: {
        streak: {
          type: "int32",
          initialValue: 5,
          persistToSd: true,
        },
        active: {
          type: "bool",
          initialValue: false,
          persistToSd: false,
        },
      },
      ui: {
        type: "Container",
        x: 0,
        y: 0,
        w: 160,
        h: 128,
        backgroundColor: "#000000",
        borderRadius: 0,
        children: [
          {
            type: "Text",
            x: 10,
            y: 20,
            w: 140,
            h: 30,
            text: "Streak",
            fontSize: "md",
            color: "#FFFFFF",
            align: "center",
          },
        ],
      },
      triggers: [
        {
          event: "ON_LOAD",
          actions: [
            {
              type: "MUTATE_STATE",
              targetKey: "streak",
              operation: "INCREMENT",
              value: 1,
            },
          ],
        },
        {
          event: "ON_TOUCH_TAP",
          actions: [
            {
              type: "MUTATE_STATE",
              targetKey: "streak",
              operation: "INCREMENT",
              value: 1,
            },
            {
              type: "PLAY_SOUND",
              soundId: "SUCCESS",
              frequencyHz: 1200,
              durationMs: 80,
            },
          ],
        },
        {
          event: "ON_TOUCH_DOUBLE_TAP",
          actions: [
            {
              type: "MUTATE_STATE",
              targetKey: "streak",
              operation: "DECREMENT",
              value: 2,
            },
          ],
        },
        {
          event: "ON_TOUCH_LONG_PRESS",
          actions: [
            {
              type: "MUTATE_STATE",
              targetKey: "active",
              operation: "TOGGLE",
            },
          ],
        },
        {
          event: "ON_TOUCH_PETTING",
          actions: [
            {
              type: "SET_EXPRESSION",
              emotion: "HAPPY",
              durationMs: 2000,
            },
          ],
        },
      ],
    };

    it("loads compiled PBWG bytecode, fires ON_LOAD trigger and sets state slots", () => {
      const bytecode = compileWidgetToBytecode(testWidget);
      const deployFrame = encodeFrame(FrameType.WIDGET_DEPLOY, bytecode, 10);

      const result = robot.handleInboundFrame(deployFrame);
      expect(result.parsedWidget).toBeDefined();

      // Initial value was 5, ON_LOAD incremented by 1 -> 6
      expect(robot.getStateSlot("streak")).toBe(6);
      expect(robot.getStateSlot("active")).toBe(false);
    });

    it("reacts to capacitive touch gestures mutating state slots and playing sounds", () => {
      const bytecode = compileWidgetToBytecode(testWidget);
      robot.loadWidgetBytecode(bytecode);
      expect(robot.getStateSlot("streak")).toBe(6);

      // Single tap increments streak and triggers SUCCESS sound
      robot.triggerTouchGesture("SINGLE_TAP");
      expect(robot.getStateSlot("streak")).toBe(7);
      expect(triggeredSounds).toContain("SUCCESS");

      // Double tap decrements streak by 2
      robot.triggerTouchGesture("DOUBLE_TAP");
      expect(robot.getStateSlot("streak")).toBe(5);

      // Long press toggles active
      robot.triggerTouchGesture("LONG_PRESS");
      expect(robot.getStateSlot("active")).toBe(true);
      robot.triggerTouchGesture("LONG_PRESS");
      expect(robot.getStateSlot("active")).toBe(false);

      // Petting sets expression to HAPPY
      robot.triggerTouchGesture("PETTING_RAPID");
      expect(robot.getTelemetrySnapshot().petMood).toBe(EmotionId.HAPPY);
    });
  });

  describe("4. Virtual MicroSD Card Vault Storage", () => {
    it("receives chunked files, verifies SHA-256 and lists vault contents", () => {
      const testFileContent = Buffer.from("Hello ESP32-S3 MicroSD Card Virtual Vault!");
      const sha256 = crypto.createHash("sha256").update(testFileContent).digest("hex");

      // 1. Send SD_VAULT_START
      const startPayload: SdVaultStart = {
        fileId: "vault-doc-001",
        path: "vault-document.txt",
        totalBytes: testFileContent.byteLength,
        totalChunks: 1,
        sha256Hex: sha256,
        direction: "PUSH_TO_ROBOT",
      };
      const startFrame = encodeFrame(
        FrameType.SD_VAULT_START,
        encodeControlPayload(SdVaultStartSchema, startPayload),
        20
      );
      robot.handleInboundFrame(startFrame);

      // Outbound ACK for start
      expect(outboundFrames.length).toBe(1);
      const ack1 = decodeFrame(outboundFrames[0]!);
      expect(ack1.header.frameType).toBe(FrameType.SD_VAULT_ACK);
      const ack1Data = decodeSdVaultAck(ack1.payload);
      expect(ack1Data.status).toBe(SdVaultStatus.OK);
      const transferId = ack1Data.transferId;

      // 2. Send SD_VAULT_CHUNK (Final chunk)
      const chunkPayload = encodeSdVaultChunk({
        transferId,
        chunkIndex: 0,
        chunkCrc32: crc32(testFileContent),
        rawBytes: new Uint8Array(testFileContent),
      });
      const chunkFrame = encodeFrame(FrameType.SD_VAULT_CHUNK, chunkPayload, 21, FLAG_FINAL_CHUNK);
      robot.handleInboundFrame(chunkFrame);

      // Outbound ACK for completion
      expect(outboundFrames.length).toBe(2);
      const ack2 = decodeFrame(outboundFrames[1]!);
      const ack2Data = decodeSdVaultAck(ack2.payload);
      expect(ack2Data.status).toBe(SdVaultStatus.COMPLETED);

      // Verify file is saved in temp directory
      const savedFilePath = path.join(tempSdDir, "vault-document.txt");
      expect(fs.existsSync(savedFilePath)).toBe(true);
      expect(fs.readFileSync(savedFilePath).toString()).toBe("Hello ESP32-S3 MicroSD Card Virtual Vault!");

      // 3. Send SD_VAULT_LIST_REQ
      const listReqFrame = encodeFrame(
        FrameType.SD_VAULT_LIST_REQ,
        encodeControlPayload(SdVaultListReqSchema, { directoryPath: "/" }),
        22
      );
      robot.handleInboundFrame(listReqFrame);

      expect(outboundFrames.length).toBe(3);
      const listResFrame = decodeFrame(outboundFrames[2]!);
      expect(listResFrame.header.frameType).toBe(FrameType.SD_VAULT_LIST_RES);
      const listRes = decodeControlPayload(SdVaultListResSchema, listResFrame.payload);
      expect(listRes.entries.some((e) => e.name === "vault-document.txt")).toBe(true);
    });
  });

  describe("5. Capacitive Touch 2FA & Ed25519 Signing", () => {
    it("signs active 2FA challenge on SINGLE_TAP (APPROVED) with valid Ed25519 signature", () => {
      const challenge: Touch2FaChallenge = {
        challengeId: "2fa-req-7788",
        actionTitle: "Authorize Cloud Deployment",
        riskTier: "TIER_3_2FA_REQUIRED",
        nonce: "random-nonce-12345678",
        expiresInMs: 60000,
      };

      const challengeFrame = encodeFrame(
        FrameType.TOUCH_2FA_CHALLENGE,
        encodeControlPayload(Touch2FaChallengeSchema, challenge),
        30
      );
      robot.handleInboundFrame(challengeFrame);

      const snapshot = robot.getTelemetrySnapshot();
      expect(snapshot.active2FaChallengeId).toBe("2fa-req-7788");
      expect(snapshot.active2FaTitle).toBe("Authorize Cloud Deployment");

      // Trigger physical single tap to approve
      outboundFrames = [];
      const response = robot.triggerTouchGesture("SINGLE_TAP");
      expect(response).not.toBeNull();
      expect(response!.decision).toBe("APPROVED_SINGLE_TAP");
      expect(response!.challengeId).toBe("2fa-req-7788");
      expect(response!.signatureHex).toHaveLength(128); // 64 bytes in hex

      // Outbound frame was also emitted
      expect(outboundFrames.length).toBe(1);
      const frame = decodeFrame(outboundFrames[0]!);
      expect(frame.header.frameType).toBe(FrameType.TOUCH_2FA_RESPONSE);

      // Verify the cryptographic Ed25519 signature
      const messageToVerify = Buffer.from(
        `${challenge.challengeId}:${challenge.nonce}:APPROVED_SINGLE_TAP:${response!.touchTimestampMs}`,
        "utf-8"
      );

      // Build SPKI DER from 32-byte raw Ed25519 public key
      const rawPub = Buffer.from(snapshot.ed25519PublicKeyHex, "hex");
      const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
      const spkiDer = Buffer.concat([spkiHeader, rawPub]);
      const publicKey = crypto.createPublicKey({
        key: spkiDer,
        format: "der",
        type: "spki",
      });

      const isSigValid = crypto.verify(
        null,
        messageToVerify,
        publicKey,
        Buffer.from(response!.signatureHex, "hex")
      );
      expect(isSigValid).toBe(true);

      // Challenge should now be cleared
      expect(robot.getTelemetrySnapshot().active2FaChallengeId).toBeNull();
    });

    it("denies 2FA challenge on LONG_PRESS", () => {
      const challenge: Touch2FaChallenge = {
        challengeId: "2fa-req-deny-1",
        actionTitle: "Delete Cloud Resource",
        riskTier: "TIER_3_2FA_REQUIRED",
        nonce: "random-nonce-deny-9999",
        expiresInMs: 60000,
      };

      robot.handleInboundFrame(
        encodeFrame(FrameType.TOUCH_2FA_CHALLENGE, encodeControlPayload(Touch2FaChallengeSchema, challenge), 31)
      );

      const response = robot.triggerTouchGesture("LONG_PRESS");
      expect(response).not.toBeNull();
      expect(response!.decision).toBe("DENIED_LONG_PRESS");
      expect(robot.getTelemetrySnapshot().active2FaChallengeId).toBeNull();
    });
  });

  describe("6. Virtual Audio Hal", () => {
    it("generates synthetic 16kHz audio uplink frame", () => {
      outboundFrames = [];
      robot.injectSyntheticVoiceUplink(320);

      expect(outboundFrames.length).toBe(1);
      const frame = decodeFrame(outboundFrames[0]!);
      expect(frame.header.frameType).toBe(FrameType.AUDIO_UPLINK_FRAME);

      const uplink = decodeAudioUplinkFrame(frame.payload);
      expect(uplink.vadActive).toBe(true);
      expect(uplink.rmsEnergy).toBe(175);
      expect(uplink.audioData.length).toBe(640); // 320 samples * 2 bytes
    });

    it("handles downlink audio keyframes updating viseme and gaze telemetry", () => {
      const downlinkPayload = encodeAudioDownlinkFrame({
        emotionId: EmotionId.CURIOUS,
        visemeMouthOpen: 215,
        eyeGazeX: -15,
        eyeGazeY: 25,
        audioData: new Uint8Array(160),
      });

      const frame = encodeFrame(FrameType.AUDIO_DOWNLINK_FRAME, downlinkPayload, 40);
      robot.handleInboundFrame(frame);

      const snapshot = robot.getTelemetrySnapshot();
      expect(snapshot.petMood).toBe(EmotionId.CURIOUS);
      expect(snapshot.visemeMouthOpen).toBe(215);
      expect(snapshot.eyeGazeX).toBe(-15);
      expect(snapshot.eyeGazeY).toBe(25);
    });
  });
});

describe("VirtualRobotServer Full-Stack Network Integration", () => {
  let server: VirtualRobotServer;
  let wsPort: number;
  let httpPort: number;

  beforeEach(async () => {
    // Bind to ephemeral ports (0) to eliminate collisions
    server = new VirtualRobotServer({
      wsPort: 0,
      httpPort: 0,
      advertiseBonjour: false,
    });
    await server.start();
    const ports = server.getBoundPorts();
    wsPort = ports.wsPort;
    httpPort = ports.httpPort;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("serves HTTP status endpoint with live hardware telemetry", async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deviceId).toBeDefined();
    expect(data.ed25519PublicKeyHex).toHaveLength(64);
  });

  it("serves raw RGB565/RGBA framebuffer endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/framebuffer`);
    expect(res.status).toBe(200);
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBe(DISPLAY_WIDTH * DISPLAY_HEIGHT * 4);
  });

  it("triggers capacitive touch gesture via HTTP POST endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/touch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gesture: "SINGLE_TAP" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.gesture).toBe("SINGLE_TAP");
  });

  it("accepts binary WebSocket connections and responds to frames", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
    });

    const pingFrame = encodeFrame(FrameType.HEARTBEAT_PING, new Uint8Array(0), 1234);

    const receivedFramePromise = new Promise<DecodedFrame>((resolve) => {
      ws.on("message", (data) => {
        const buf = Buffer.isBuffer(data) ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
        const decoded = decodeFrame(buf);
        resolve(decoded);
      });
    });

    ws.send(pingFrame);

    const received = await receivedFramePromise;
    expect(received.header.frameType).toBe(FrameType.HEARTBEAT_PONG);
    expect(received.header.seqId).toBe(1234);

    ws.close();
  });
});
