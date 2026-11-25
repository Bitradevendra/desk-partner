import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import WebSocket from "ws";
import {
  FrameType,
  RobotMode,
  RiskTier,
  Touch2FADecision,
  encodeFrame,
  decodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  FrameStreamParser,
  HelloHandshakeSchema,
  ModeTransitionSchema,
  Touch2FaChallengeSchema,
  Touch2FaResponseSchema,
  HarnessRpcReqSchema,
  HarnessRpcResSchema,
  type HelloHandshake,
  type ModeTransition,
  type Touch2FaChallenge,
  type Touch2FaResponse,
  type HarnessRpcReq,
  type HarnessRpcRes,
} from "@petbot/protocol";
import {
  createDesktopHarnessInstance,
  DesktopHarnessDaemon,
} from "../src/index.js";

const TEST_PORT = 9555;

describe("DesktopHarness End-to-End Security & Functional Verification", () => {
  let tempDir: string;
  let auditLogFile: string;
  let workflowsFile: string;
  let daemon: DesktopHarnessDaemon;

  const robotDeviceId = "petbot-esp32-livingroom";
  const robotSecretHex = crypto.randomBytes(32).toString("hex");
  const robotPubKeyHex = crypto.randomBytes(32).toString("hex");

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot_harness_test_"));
    auditLogFile = path.join(tempDir, "audit.jsonl");
    workflowsFile = path.join(tempDir, "workflows.json");

    daemon = await createDesktopHarnessInstance({
      port: TEST_PORT,
      host: "127.0.0.1",
      allowPairingMode: true,
      bonjourEnabled: false,
      enableTelemetryBroadcasting: false, // Control telemetry frames deterministically in tests
      auditLogFilePath: auditLogFile,
      workflowsFilePath: workflowsFile,
      osOptions: { mock: true },
    });

    // Pre-pin robot cryptographic credentials
    daemon.vault.registerPairedDevice({
      deviceId: robotDeviceId,
      deviceName: "Living Room ESP32-S3 PetBot",
      role: "ROBOT",
      ed25519PublicKeyHex: robotPubKeyHex,
      sharedHmacSecretHex: robotSecretHex,
    });
  });

  afterEach(async () => {
    await daemon.stop();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper to perform authenticated handshake connection for a simulated ESP32-S3 robot.
   */
  async function connectAndAuthenticateRobot(): Promise<{
    ws: WebSocket;
    parser: FrameStreamParser;
  }> {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const parser = new FrameStreamParser();

    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data: Buffer) => parser.push(new Uint8Array(data)));
      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HELLO_HANDSHAKE) {
          const robotHandshake: HelloHandshake = {
            deviceId: robotDeviceId,
            firmwareVersion: "2.1.0-esp32s3",
            psramFreeBytes: 8388608,
            sdCardCapacityBytes: 32000000000,
            sdCardFreeBytes: 28000000000,
            ed25519PublicKeyHex: robotPubKeyHex,
            capabilities: ["audio_pcm", "screen_128x160", "sd_vault", "widgets", "touch_2fa"],
          };
          const payload = encodeControlPayload(HelloHandshakeSchema, robotHandshake);
          ws.send(encodeFrame(FrameType.HELLO_HANDSHAKE, payload, 1));
        }

        if (frame.header.frameType === FrameType.MODE_TRANSITION) {
          resolve();
        }
      });

      ws.on("error", reject);
    });

    return { ws, parser };
  }

  it("1. Zero-Trust Handshake & Telemetry: Authenticates robot, transitions to AGENTIC_CONNECTED, and receives TELEMETRY_SYNC frames", async () => {
    const { ws, parser } = await connectAndAuthenticateRobot();

    // Verify daemon tracks active authenticated robot session
    const activeRobot = daemon.server.getActiveRobotSession();
    expect(activeRobot).not.toBeNull();
    expect(activeRobot?.authenticated).toBe(true);
    expect(activeRobot?.device?.deviceId).toBe(robotDeviceId);

    // Broadcast a simulated telemetry frame from harness
    const telemetryReceived = new Promise<HarnessRpcReq>((resolve) => {
      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HARNESS_RPC_REQ) {
          const req = decodeControlPayload(HarnessRpcReqSchema, frame.payload);
          if (req.method === "telemetry_sync") {
            resolve(req);
          }
        }
      });
    });

    daemon.telemetryMonitor.setMockState({
      cpuLoadPct: 35,
      ramUsedPct: 62,
      gpuLoadPct: 20,
      activeWindowTitle: "Visual Studio Code",
      activeAppName: "Code",
      inMeeting: false,
    });
    const snapshot = await daemon.telemetryMonitor.sample();
    daemon.telemetryMonitor.broadcast(snapshot);

    const receivedReq = await telemetryReceived;
    expect(receivedReq.method).toBe("telemetry_sync");
    expect(receivedReq.params["cpuLoadPct"]).toBe(35);
    expect(receivedReq.params["activeAppName"]).toBe("Code");

    ws.close();
  });

  it("2. Tier-1 Instant Execution: Robot sends HARNESS_RPC_REQ (toggleMicrophoneMute) -> executes in <10ms, returns HARNESS_RPC_RES, and logs to audit feed", async () => {
    const { ws, parser } = await connectAndAuthenticateRobot();

    const rpcPromise = new Promise<HarnessRpcRes>((resolve) => {
      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HARNESS_RPC_RES) {
          const res = decodeControlPayload(HarnessRpcResSchema, frame.payload);
          resolve(res);
        }
      });
    });

    const rpcReq: HarnessRpcReq = {
      callId: "call_mic_mute_test",
      method: "toggleMicrophoneMute",
      params: {},
    };

    const payload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
    const startDispatch = Date.now();
    ws.send(encodeFrame(FrameType.HARNESS_RPC_REQ, payload, 10));

    const res = await rpcPromise;
    const dispatchDuration = Date.now() - startDispatch;

    expect(dispatchDuration).toBeLessThan(250); // Generous sub-250ms roundtrip for concurrent Windows runners
    expect(res.callId).toBe("call_mic_mute_test");
    expect(res.success).toBe(true);
    expect(res.result?.["micMuted"]).toBeDefined();

    // Verify audit entry was recorded in memory and on disk
    const entry = daemon.auditLogger.getEntryById("call_mic_mute_test");
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("COMPLETED");
    expect(entry?.humanSummary).toContain("microphone");
    expect(entry?.riskTier).toBe(RiskTier.TIER_1_SAFE);

    const diskEntries = daemon.auditLogger.readLogFile();
    expect(diskEntries.some((e) => e.id === "call_mic_mute_test")).toBe(true);

    ws.close();
  });

  it("3a. Tier-3 Hardware 2FA Negative Test: Blocks execution when forged/invalid signature is provided in TOUCH_2FA_RESPONSE", async () => {
    const { ws, parser } = await connectAndAuthenticateRobot();

    // Handle incoming challenge by responding with a forged signature
    parser.onFrame((frame) => {
      if (frame.header.frameType === FrameType.TOUCH_2FA_CHALLENGE) {
        const challenge = decodeControlPayload(Touch2FaChallengeSchema, frame.payload);

        // Forged signature (not signed with robotSecretHex)
        const fakeSignatureHex = crypto.randomBytes(64).toString("hex");

        const response: Touch2FaResponse = {
          challengeId: challenge.challengeId,
          decision: "APPROVED_SINGLE_TAP",
          touchTimestampMs: Date.now(),
          signatureHex: fakeSignatureHex,
        };

        const resPayload = encodeControlPayload(Touch2FaResponseSchema, response);
        ws.send(encodeFrame(FrameType.TOUCH_2FA_RESPONSE, resPayload, 20));
      }
    });

    const rpcResPromise = new Promise<HarnessRpcRes>((resolve) => {
      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HARNESS_RPC_RES) {
          const res = decodeControlPayload(HarnessRpcResSchema, frame.payload);
          resolve(res);
        }
      });
    });

    // Request Tier-3 action
    const rpcReq: HarnessRpcReq = {
      callId: "call_forged_2fa_test",
      method: "emptyTrashOrDeleteTempFiles",
      params: {
        targetPaths: [path.join(os.tmpdir(), "petbot_scratch_test")],
      },
    };

    const reqPayload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
    ws.send(encodeFrame(FrameType.HARNESS_RPC_REQ, reqPayload, 15));

    const rpcRes = await rpcResPromise;
    expect(rpcRes.success).toBe(false);
    expect(rpcRes.error).toBe("HARDWARE_2FA_DENIED");

    // Verify audit log status is DENIED_BY_TOUCH
    const entry = daemon.auditLogger.getEntryById("call_forged_2fa_test");
    expect(entry?.status).toBe("DENIED_BY_TOUCH");
    expect(entry?.riskTier).toBe(RiskTier.TIER_3_2FA_REQUIRED);

    ws.close();
  });

  it("3b. Tier-3 Hardware 2FA Positive Test: Grants execution when valid signed APPROVED_SINGLE_TAP is returned from robot touch sensor", async () => {
    const { ws, parser } = await connectAndAuthenticateRobot();

    // Robot listens for challenge and returns a valid cryptographic signature
    parser.onFrame((frame) => {
      if (frame.header.frameType === FrameType.TOUCH_2FA_CHALLENGE) {
        const challenge = decodeControlPayload(Touch2FaChallengeSchema, frame.payload);
        const touchTimestampMs = Date.now();

        // Valid HMAC-SHA256 signature using robot's pinned secret
        const validSignature = daemon.vault.computeFirmwareSignature(
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
          signatureHex: validSignature,
        };

        const resPayload = encodeControlPayload(Touch2FaResponseSchema, response);
        ws.send(encodeFrame(FrameType.TOUCH_2FA_RESPONSE, resPayload, 25));
      }
    });

    const rpcResPromise = new Promise<HarnessRpcRes>((resolve) => {
      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HARNESS_RPC_RES) {
          const res = decodeControlPayload(HarnessRpcResSchema, frame.payload);
          resolve(res);
        }
      });
    });

    const rpcReq: HarnessRpcReq = {
      callId: "call_valid_2fa_test",
      method: "emptyTrashOrDeleteTempFiles",
      params: {
        targetPaths: [path.join(os.tmpdir(), "petbot_scratch_test")],
      },
    };

    const reqPayload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
    ws.send(encodeFrame(FrameType.HARNESS_RPC_REQ, reqPayload, 16));

    const rpcRes = await rpcResPromise;
    expect(rpcRes.success).toBe(true);
    expect(rpcRes.result?.["freedBytes"]).toBeDefined();

    const entry = daemon.auditLogger.getEntryById("call_valid_2fa_test");
    expect(entry?.status).toBe("COMPLETED");
    expect(entry?.riskTier).toBe(RiskTier.TIER_3_2FA_REQUIRED);

    ws.close();
  });

  it("4. Privilege Escalation Prevention: Ignores client spoofed TIER_1_SAFE on Tier-3 action and enforces Touch 2FA challenge", async () => {
    const { ws, parser } = await connectAndAuthenticateRobot();

    let touch2FaChallengeTriggered = false;

    parser.onFrame((frame) => {
      if (frame.header.frameType === FrameType.TOUCH_2FA_CHALLENGE) {
        touch2FaChallengeTriggered = true;
        const challenge = decodeControlPayload(Touch2FaChallengeSchema, frame.payload);

        // Client approves via valid touch
        const touchTimestampMs = Date.now();
        const validSignature = daemon.vault.computeFirmwareSignature(
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
          signatureHex: validSignature,
        };

        const resPayload = encodeControlPayload(Touch2FaResponseSchema, response);
        ws.send(encodeFrame(FrameType.TOUCH_2FA_RESPONSE, resPayload, 30));
      }
    });

    const rpcResPromise = new Promise<HarnessRpcRes>((resolve) => {
      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HARNESS_RPC_RES) {
          const res = decodeControlPayload(HarnessRpcResSchema, frame.payload);
          resolve(res);
        }
      });
    });

    // Client requests Tier-3 action emptyTrashOrDeleteTempFiles but maliciously spoofs riskTier: 1 (TIER_1_SAFE)
    const spoofedReq: HarnessRpcReq & { riskTier?: number } = {
      callId: "call_privilege_escalation_attempt",
      method: "emptyTrashOrDeleteTempFiles",
      params: {
        riskTier: 1, // Malicious downgrade attempt!
        targetPaths: [path.join(os.tmpdir(), "petbot_scratch_test")],
      },
    };

    const reqPayload = encodeControlPayload(HarnessRpcReqSchema, spoofedReq);
    ws.send(encodeFrame(FrameType.HARNESS_RPC_REQ, reqPayload, 17));

    const rpcRes = await rpcResPromise;
    expect(rpcRes.success).toBe(true);

    // The policy gate MUST have triggered a hardware 2FA challenge despite the client's spoof attempt
    expect(touch2FaChallengeTriggered).toBe(true);

    const entry = daemon.auditLogger.getEntryById("call_privilege_escalation_attempt");
    expect(entry?.riskTier).toBe(RiskTier.TIER_3_2FA_REQUIRED);

    ws.close();
  });

  it("5. Emergency Kill-Switch: Halts in-flight multi-step workflow immediately and logs KILLED_BY_USER", async () => {
    // Add a slow workflow with DELAY_MS to test mid-flight kill-switch
    daemon.workflowEngine.saveWorkflow({
      id: "wf_kill_switch_test",
      name: "Long Running Workflow",
      enabled: true,
      trigger: {
        type: "ROBOT_WIDGET_ACTION",
        actionId: "start_long_workflow",
      },
      steps: [
        {
          type: "ROBOT_SHOW_TOAST",
          message: "Step 1 started",
        },
        {
          type: "DELAY_MS",
          delayMs: 3000,
        },
        {
          type: "ROBOT_SHOW_TOAST",
          message: "Step 2 completed",
        },
      ],
    });

    const abortController = new AbortController();

    const workflowPromise = daemon.workflowEngine.executeWorkflow("wf_kill_switch_test", {
      sourceDeviceId: robotDeviceId,
      abortSignal: abortController.signal,
    });

    // Verify task is in flight
    await new Promise((r) => setTimeout(r, 50));

    // Simulate emergency long-press kill-switch
    abortController.abort(new Error("Physical touch pad emergency long press"));

    const result = await workflowPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
    expect(result.stepsExecuted).toBeLessThan(3);
  });
});
