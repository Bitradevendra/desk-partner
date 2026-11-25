import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { WebSocket } from "ws";
import { HarnessServer, type PeerSession } from "../src/transport/harness-server.js";
import { CryptoVault } from "../src/security/crypto-vault.js";
import {
  FrameType,
  RobotMode,
  RiskTier,
  encodeFrame,
  decodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  HelloHandshakeSchema,
  ModeTransitionSchema,
  Touch2FaChallengeSchema,
  Touch2FaResponseSchema,
  HarnessRpcReqSchema,
  HarnessRpcResSchema,
  FrameStreamParser,
  type HelloHandshake,
  type ModeTransition,
  type Touch2FaChallenge,
  type Touch2FaResponse,
  type HarnessRpcReq,
  type HarnessRpcRes,
} from "@petbot/protocol";

describe("HarnessServer WebSocket Transport & Zero-Trust Handshake", () => {
  let tempDir: string;
  let vault: CryptoVault;
  let server: HarnessServer;
  const TEST_PORT = 9443;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot-server-test-"));
    vault = new CryptoVault({ baseDir: tempDir });
    server = new HarnessServer({
      port: TEST_PORT,
      host: "127.0.0.1",
      cryptoVault: vault,
      bonjourEnabled: false, // Disabled for unit tests to avoid mDNS collisions
      allowPairingMode: false,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("starts HTTP/WebSocket server and reports status", async () => {
    expect(server.isRunning()).toBe(true);
    expect(server.port).toBe(TEST_PORT);
  });

  it("initiates HELLO_HANDSHAKE on incoming client connection", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const parser = new FrameStreamParser();

    const receivedFrame = await new Promise<any>((resolve, reject) => {
      ws.on("open", () => {});
      ws.on("message", (data: Buffer) => {
        parser.push(new Uint8Array(data));
      });
      parser.onFrame((frame) => {
        resolve(frame);
      });
      ws.on("error", reject);
    });

    expect(receivedFrame.header.frameType).toBe(FrameType.HELLO_HANDSHAKE);
    const serverHandshake = decodeControlPayload(HelloHandshakeSchema, receivedFrame.payload);
    expect(serverHandshake.deviceId).toBe(vault.getIdentity().deviceId);
    expect(serverHandshake.ed25519PublicKeyHex).toBe(vault.getIdentity().ed25519PublicKeyHex);

    ws.close();
  });

  it("authenticates paired robot and triggers MODE_TRANSITION to AGENTIC_CONNECTED in <50ms", async () => {
    const robotDeviceId = "petbot-esp32-livingroom";
    const robotSecretHex = crypto.randomBytes(32).toString("hex");
    const robotPubKeyHex = crypto.randomBytes(32).toString("hex");

    // Pre-register paired robot in vault
    vault.registerPairedDevice({
      deviceId: robotDeviceId,
      deviceName: "Living Room Robot",
      role: "ROBOT",
      ed25519PublicKeyHex: robotPubKeyHex,
      sharedHmacSecretHex: robotSecretHex,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const parser = new FrameStreamParser();
    const framesReceived: any[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data: Buffer) => {
        parser.push(new Uint8Array(data));
      });

      parser.onFrame((frame) => {
        framesReceived.push(frame);

        if (frame.header.frameType === FrameType.HELLO_HANDSHAKE) {
          // Send Robot's HELLO_HANDSHAKE response back to server
          const robotHandshake: HelloHandshake = {
            deviceId: robotDeviceId,
            firmwareVersion: "1.0.0",
            psramFreeBytes: 8388608,
            sdCardCapacityBytes: 32000000000,
            sdCardFreeBytes: 28000000000,
            ed25519PublicKeyHex: robotPubKeyHex,
            capabilities: ["audio_pcm", "screen_128x160", "sd_vault", "widgets", "touch_2fa"],
          };
          const payload = encodeControlPayload(HelloHandshakeSchema, robotHandshake);
          const responseFrame = encodeFrame(FrameType.HELLO_HANDSHAKE, payload, 1);
          ws.send(responseFrame);
        }

        if (frame.header.frameType === FrameType.MODE_TRANSITION) {
          resolve();
        }
      });

      ws.on("error", reject);
    });

    // Check MODE_TRANSITION frame
    const modeFrame = framesReceived.find((f) => f.header.frameType === FrameType.MODE_TRANSITION);
    expect(modeFrame).toBeDefined();

    const modeTransition = decodeControlPayload(ModeTransitionSchema, modeFrame.payload);
    expect(modeTransition.targetMode).toBe(RobotMode.AGENTIC_CONNECTED);
    expect(modeTransition.transitionReason).toBe("DESKTOP_HARNESS_DISCOVERY_CONNECT");

    // Check active robot session
    const activeRobot = server.getActiveRobotSession();
    expect(activeRobot).not.toBeNull();
    expect(activeRobot?.authenticated).toBe(true);
    expect(activeRobot?.device?.deviceId).toBe(robotDeviceId);

    ws.close();
  });

  it("rejects unauthenticated peer frames and closes socket if not paired", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);

    const closeCode = await new Promise<number>((resolve) => {
      ws.on("open", () => {
        // Send unauthenticated RPC frame without handshake
        const rpcPayload = encodeControlPayload(HarnessRpcReqSchema, {
          callId: "unauth_1",
          method: "system_shutdown",
          params: {},
        });
        const badFrame = encodeFrame(FrameType.HARNESS_RPC_REQ, rpcPayload, 99);
        ws.send(badFrame);

        // Then send handshake with unknown/unpaired device ID
        const fakeHandshake: HelloHandshake = {
          deviceId: "unknown-hacker-device",
          firmwareVersion: "0.0.1",
          psramFreeBytes: 0,
          sdCardCapacityBytes: 0,
          sdCardFreeBytes: 0,
          ed25519PublicKeyHex: crypto.randomBytes(32).toString("hex"),
          capabilities: [],
        };
        const hsPayload = encodeControlPayload(HelloHandshakeSchema, fakeHandshake);
        ws.send(encodeFrame(FrameType.HELLO_HANDSHAKE, hsPayload, 100));
      });

      ws.on("close", (code) => {
        resolve(code);
      });
    });

    expect(closeCode).toBe(4401); // Unauthorized: Device not paired
  });

  it("executes end-to-end requestHardwareTouch2FA with physical capacitive verification", async () => {
    const robotDeviceId = "petbot-esp32-touch2fa";
    const robotSecretHex = crypto.randomBytes(32).toString("hex");
    const robotPubKeyHex = crypto.randomBytes(32).toString("hex");

    vault.registerPairedDevice({
      deviceId: robotDeviceId,
      deviceName: "Touch2FA Robot",
      role: "ROBOT",
      ed25519PublicKeyHex: robotPubKeyHex,
      sharedHmacSecretHex: robotSecretHex,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const parser = new FrameStreamParser();

    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data: Buffer) => parser.push(new Uint8Array(data)));
      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HELLO_HANDSHAKE) {
          const robotHandshake: HelloHandshake = {
            deviceId: robotDeviceId,
            firmwareVersion: "1.0.0",
            psramFreeBytes: 8388608,
            sdCardCapacityBytes: 32000000000,
            sdCardFreeBytes: 28000000000,
            ed25519PublicKeyHex: robotPubKeyHex,
            capabilities: ["screen_128x160", "touch_2fa"],
          };
          const payload = encodeControlPayload(HelloHandshakeSchema, robotHandshake);
          ws.send(encodeFrame(FrameType.HELLO_HANDSHAKE, payload, 1));
        } else if (frame.header.frameType === FrameType.MODE_TRANSITION) {
          resolve();
        }
      });
      ws.on("error", reject);
    });

    // Set up handler on robot client for TOUCH_2FA_CHALLENGE
    parser.onFrame((frame) => {
      if (frame.header.frameType === FrameType.TOUCH_2FA_CHALLENGE) {
        const challenge = decodeControlPayload(Touch2FaChallengeSchema, frame.payload);
        const touchTimestampMs = Date.now();

        // Simulate user single-tap physical touch approval
        const signatureHex = vault.computeFirmwareSignature(
          robotSecretHex,
          challenge.challengeId,
          challenge.nonce,
          "APPROVED_SINGLE_TAP",
          touchTimestampMs
        );

        const response: Touch2FaResponse = {
          challengeId: challenge.challengeId,
          decision: "APPROVED_SINGLE_TAP",
          touchTimestampMs,
          signatureHex,
        };

        const resPayload = encodeControlPayload(Touch2FaResponseSchema, response);
        ws.send(encodeFrame(FrameType.TOUCH_2FA_RESPONSE, resPayload, 50));
      }
    });

    // Trigger requestHardwareTouch2FA on server
    const isApproved = await server.requestHardwareTouch2FA(
      "Approve SSH Deployment to Production",
      RiskTier.TIER_3_2FA_REQUIRED,
      5000
    );

    expect(isApproved).toBe(true);

    ws.close();
  });

  it("handles incoming media_play_pause RPC from robot single-tap", async () => {
    const robotDeviceId = "petbot-esp32-media";
    const robotSecretHex = crypto.randomBytes(32).toString("hex");
    const robotPubKeyHex = crypto.randomBytes(32).toString("hex");

    vault.registerPairedDevice({
      deviceId: robotDeviceId,
      deviceName: "Media Robot",
      role: "ROBOT",
      ed25519PublicKeyHex: robotPubKeyHex,
      sharedHmacSecretHex: robotSecretHex,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const parser = new FrameStreamParser();

    await new Promise<void>((resolve) => {
      ws.on("message", (data: Buffer) => parser.push(new Uint8Array(data)));
      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HELLO_HANDSHAKE) {
          const robotHandshake: HelloHandshake = {
            deviceId: robotDeviceId,
            firmwareVersion: "1.0.0",
            psramFreeBytes: 8388608,
            sdCardCapacityBytes: 32000000000,
            sdCardFreeBytes: 28000000000,
            ed25519PublicKeyHex: robotPubKeyHex,
            capabilities: ["screen_128x160", "touch_2fa"],
          };
          ws.send(
            encodeFrame(
              FrameType.HELLO_HANDSHAKE,
              encodeControlPayload(HelloHandshakeSchema, robotHandshake),
              1
            )
          );
        } else if (frame.header.frameType === FrameType.MODE_TRANSITION) {
          resolve();
        }
      });
    });

    let mediaControlFired = false;
    server.on("mediaControl", (event) => {
      if (event.action === "play_pause") {
        mediaControlFired = true;
      }
    });

    // Robot sends HARNESS_RPC_REQ: media_play_pause
    const rpcReq: HarnessRpcReq = {
      callId: "call_media_101",
      method: "media_play_pause",
      params: {},
    };
    ws.send(
      encodeFrame(
        FrameType.HARNESS_RPC_REQ,
        encodeControlPayload(HarnessRpcReqSchema, rpcReq),
        20
      )
    );

    const rpcResFrame = await new Promise<any>((resolve) => {
      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HARNESS_RPC_RES) {
          resolve(frame);
        }
      });
    });

    expect(mediaControlFired).toBe(true);
    const rpcRes = decodeControlPayload(HarnessRpcResSchema, rpcResFrame.payload);
    expect(rpcRes.callId).toBe("call_media_101");
    expect(rpcRes.success).toBe(true);
    expect(rpcRes.result).toEqual({ status: "toggled" });

    ws.close();
  });
});
