import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { WebSocket } from "ws";
import {
  FrameType,
  EmotionId,
  RiskTier,
  Touch2FaDecision,
  encodeFrame,
  decodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  HelloHandshakeSchema,
  Touch2FaChallengeSchema,
  Touch2FaResponseSchema,
  HarnessRpcReqSchema,
  FrameStreamParser,
  type HelloHandshake,
  type Touch2FaChallenge,
  type Touch2FaResponse,
  type HarnessRpcReq,
} from "@petbot/protocol";
import { CryptoVault } from "../src/security/crypto-vault.js";
import { HarnessServer } from "../src/transport/harness-server.js";
import { createOSAdapter } from "../src/os/os-adapters.js";
import { OssAgentEcosystemLoader } from "../src/integrations/oss-loader.js";
import { HeadlessPartnerToolBus } from "../src/partner/headless-tool-bus.js";
import {
  RobotLiveHudBridge,
  type TaskStep,
  type HudProgressUpdate,
} from "../src/partner/robot-live-hud-bridge.js";
import { DesktopHarnessDaemon } from "../src/daemon.js";

describe("Autonomous Desktop Partner Harness - Headless Tool Bus & Robot Live HUD", () => {
  let tempDir: string;
  let vault: CryptoVault;
  let server: HarnessServer;
  let ossLoader: OssAgentEcosystemLoader;
  let toolBus: HeadlessPartnerToolBus;
  let hudBridge: RobotLiveHudBridge;
  const TEST_PORT = 9553;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot-partner-test-"));
    vault = new CryptoVault({ baseDir: tempDir });
    server = new HarnessServer({
      port: TEST_PORT,
      host: "127.0.0.1",
      cryptoVault: vault,
      bonjourEnabled: false,
      allowPairingMode: true,
    });
    await server.start();

    const osAdapter = createOSAdapter({ mock: true });
    ossLoader = new OssAgentEcosystemLoader();
    toolBus = new HeadlessPartnerToolBus(ossLoader, osAdapter, server);
    hudBridge = new RobotLiveHudBridge({
      server,
      toolBus,
      default2FaTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    await hudBridge.removeAllListeners();
    await ossLoader.dispose();
    await server.stop();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("registers 25+ production-ready headless tools across 4 categories", () => {
    const tools = toolBus.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(25);

    const categories = new Set(tools.map((t) => t.category));
    expect(categories.has("WORKSPACE_FILES")).toBe(true);
    expect(categories.has("HEADLESS_BROWSER")).toBe(true);
    expect(categories.has("DEV_SYSTEM")).toBe(true);
    expect(categories.has("OS_DEEP_CONTROL")).toBe(true);

    // Verify key headless tools exist
    expect(toolBus.getTool("file_search")).toBeDefined();
    expect(toolBus.getTool("file_read_text")).toBeDefined();
    expect(toolBus.getTool("file_write_text")).toBeDefined();
    expect(toolBus.getTool("file_beam_to_robot_sd")).toBeDefined();
    expect(toolBus.getTool("browser_scrape_text")).toBeDefined();
    expect(toolBus.getTool("browser_take_screenshot")).toBeDefined();
    expect(toolBus.getTool("dev_git_status")).toBeDefined();
    expect(toolBus.getTool("dev_inspect_processes")).toBeDefined();
    expect(toolBus.getTool("os_media_control")).toBeDefined();
    expect(toolBus.getTool("os_clipboard_read_write")).toBeDefined();
  });

  it("executes headless workspace file operations (search, write, read, zip, batch rename)", async () => {
    const testFolder = path.join(tempDir, "workspace");
    fs.mkdirSync(testFolder, { recursive: true });

    // 1. Write text file
    const filePath1 = path.join(testFolder, "doc1.txt");
    const writeRes = await toolBus.executeTool("file_write_text", {
      path: filePath1,
      content: "Hello ESP32-S3 Autonomous Robot Partner!",
    });
    expect(writeRes.success).toBe(true);

    // 2. Read text file
    const readRes = await toolBus.executeTool("file_read_text", { path: filePath1 });
    expect(readRes.content).toBe("Hello ESP32-S3 Autonomous Robot Partner!");

    // 3. Search files
    const searchRes = await toolBus.executeTool("file_search", {
      directory: testFolder,
      query: "doc1",
    });
    expect(searchRes.totalMatches).toBeGreaterThanOrEqual(1);

    // 4. Archive into ZIP
    const zipPath = path.join(testFolder, "bundle.zip");
    const zipRes = await toolBus.executeTool("file_archive_zip", {
      sourcePaths: [filePath1],
      outputZipPath: zipPath,
    });
    expect(zipRes.success).toBe(true);
    expect(fs.existsSync(zipPath)).toBe(true);

    // 5. Extract ZIP
    const extractFolder = path.join(testFolder, "extracted");
    const extractRes = await toolBus.executeTool("file_extract_zip", {
      zipPath,
      destinationDir: extractFolder,
    });
    expect(extractRes.success).toBe(true);
    expect(fs.existsSync(path.join(extractFolder, "doc1.txt"))).toBe(true);

    // 6. Batch rename
    const renameRes = await toolBus.executeTool("file_batch_rename", {
      directory: extractFolder,
      pattern: "doc1",
      replacement: "renamed_doc",
    });
    expect(renameRes.renamedCount).toBe(1);
    expect(fs.existsSync(path.join(extractFolder, "renamed_doc.txt"))).toBe(true);
  });

  it("inspects system processes, ports, git status, and clipboard", async () => {
    // 1. Dev inspect processes
    const procRes = await toolBus.executeTool("dev_inspect_processes", { limit: 5 });
    expect(procRes.totalProcesses).toBeGreaterThan(0);
    expect(Array.isArray(procRes.topProcesses)).toBe(true);

    // 2. Dev inspect ports
    const portRes = await toolBus.executeTool("dev_inspect_ports", {});
    expect(Array.isArray(portRes.openPorts)).toBe(true);

    // 3. Dev git status
    const gitRes = await toolBus.executeTool("dev_git_status", { repoPath: process.cwd() });
    expect(gitRes.isGitRepo).toBe(true);

    // 4. OS clipboard read/write
    const clipRes = await toolBus.executeTool("os_clipboard_read_write", {
      action: "write",
      text: "RobotClipboardTest_42",
    });
    expect(clipRes.success).toBe(true);

    const clipRead = await toolBus.executeTool("os_clipboard_read_write", { action: "read" });
    expect(typeof clipRead.clipboardText).toBe("string");
  });

  it("executes multi-step background task, streaming live HUD updates and completing with HAPPY_TRILL chime", async () => {
    // Simulate connected ESP32-S3 robot
    const robotKeyPair = crypto.generateKeyPairSync("ed25519");
    const robotPubKeyHex = robotKeyPair.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");

    const robotWs = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const parser = new FrameStreamParser();
    const receivedFrames: { type: FrameType; payload: Uint8Array }[] = [];

    await new Promise<void>((resolve) => {
      robotWs.on("open", () => {
        // Send HELLO_HANDSHAKE
        const handshake: HelloHandshake = {
          deviceId: "esp32-s3-test-robot",
          firmwareVersion: "1.0.0",
          psramFreeBytes: 6000000,
          sdCardCapacityBytes: 32000000000,
          sdCardFreeBytes: 30000000000,
          ed25519PublicKeyHex: robotPubKeyHex,
          capabilities: ["screen_128x160", "touch_2fa", "TFT_128X160"],
        };
        const payload = encodeControlPayload(HelloHandshakeSchema, handshake);
        const frame = encodeFrame(FrameType.HELLO_HANDSHAKE, payload, 1);
        robotWs.send(frame);
      });

      robotWs.on("message", (data: Buffer) => {
        parser.push(new Uint8Array(data));
      });

      parser.onFrame((frame) => {
        receivedFrames.push({ type: frame.header.frameType, payload: frame.payload });
        if (frame.header.frameType === FrameType.MODE_TRANSITION) {
          resolve();
        }
      });
    });

    // Clear frames recorded during handshake
    receivedFrames.length = 0;

    // Define 3-step background task
    const taskSteps: TaskStep[] = [
      {
        name: "Scan Project Files",
        riskTier: RiskTier.TIER_1_SAFE,
        execute: async (ctx) => {
          ctx.updateProgress(50, "Halfway scanning files");
          await new Promise((r) => setTimeout(r, 20));
          return { scanned: 42 };
        },
      },
      {
        name: "Compile Telemetry Report",
        riskTier: RiskTier.TIER_1_SAFE,
        execute: async (ctx) => {
          ctx.updateProgress(100, "Report compiled");
          return { status: "compiled" };
        },
      },
      {
        name: "Persist Summary to Disk",
        riskTier: RiskTier.TIER_2_WORKFLOW,
        execute: async () => {
          return { persisted: true };
        },
      },
    ];

    const hudUpdates: HudProgressUpdate[] = [];
    hudBridge.on("progress", (up) => hudUpdates.push(up));

    const taskResult = await hudBridge.executeTaskWithHud({
      name: "Scanning PDFs & Syncing SD...",
      steps: taskSteps,
    });

    await new Promise((r) => setTimeout(r, 80));

    expect(taskResult.success).toBe(true);
    expect(taskResult.stepsExecuted).toBe(3);
    expect(taskResult.stepResults.length).toBe(3);

    // Verify HUD progress was emitted
    expect(hudUpdates.length).toBeGreaterThan(0);
    const lastUpdate = hudUpdates[hudUpdates.length - 1];
    expect(lastUpdate?.progressPercent).toBe(100);
    expect(lastUpdate?.state).toBe("COMPLETED");

    // Verify frames received by the robot
    const rpcFrames = receivedFrames.filter((f) => f.type === FrameType.HARNESS_RPC_REQ);
    expect(rpcFrames.length).toBeGreaterThan(0);

    const rpcMethods = rpcFrames.map((f) => {
      try {
        const decoded = decodeControlPayload(HarnessRpcReqSchema, f.payload);
        return decoded.method;
      } catch {
        return "unknown";
      }
    });

    // Verify task_progress_hud, set_expression (FOCUSED & HAPPY), and play_sound (HAPPY_TRILL) were sent
    expect(rpcMethods).toContain("task_progress_hud");
    expect(rpcMethods).toContain("set_expression");
    expect(rpcMethods).toContain("play_sound");

    // Close robot socket
    robotWs.close();
  });

  it("automatically pauses on RiskTier.TIER_3_2FA_REQUIRED steps, requests physical touch, and resumes upon SINGLE_TAP approval", async () => {
    // Connect simulated physical robot with Ed25519 keypair
    const robotKeyPair = crypto.generateKeyPairSync("ed25519");
    const robotPubKeyHex = robotKeyPair.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");

    const robotWs = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const parser = new FrameStreamParser();
    let challengeReceived: Touch2FaChallenge | null = null;

    await new Promise<void>((resolve) => {
      robotWs.on("open", () => {
        const handshake: HelloHandshake = {
          deviceId: "esp32-s3-2fa-robot",
          firmwareVersion: "1.0.0",
          psramFreeBytes: 6000000,
          sdCardCapacityBytes: 32000000000,
          sdCardFreeBytes: 30000000000,
          ed25519PublicKeyHex: robotPubKeyHex,
          capabilities: ["touch_2fa", "screen_128x160"],
        };
        const payload = encodeControlPayload(HelloHandshakeSchema, handshake);
        const frame = encodeFrame(FrameType.HELLO_HANDSHAKE, payload, 1);
        robotWs.send(frame);
      });

      robotWs.on("message", (data: Buffer) => {
        parser.push(new Uint8Array(data));
      });

      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.MODE_TRANSITION) {
          resolve();
        } else if (frame.header.frameType === FrameType.TOUCH_2FA_CHALLENGE) {
          challengeReceived = decodeControlPayload(Touch2FaChallengeSchema, frame.payload);

          // Simulate user physically tapping capacitive touch sensor (SINGLE_TAP approval)
          const timestamp = Date.now();
          const decision = "APPROVED_SINGLE_TAP";
          const messageToSign = Buffer.from(
            `${challengeReceived.challengeId}:${challengeReceived.nonce}:${decision}:${timestamp}`
          );
          const sig = crypto.sign(null, messageToSign, robotKeyPair.privateKey);

          const response: Touch2FaResponse = {
            challengeId: challengeReceived.challengeId,
            decision,
            touchTimestampMs: timestamp,
            signatureHex: sig.toString("hex"),
          };

          const resPayload = encodeControlPayload(Touch2FaResponseSchema, response);
          const resFrame = encodeFrame(FrameType.TOUCH_2FA_RESPONSE, resPayload, 2);
          robotWs.send(resFrame);
        }
      });
    });

    let executedDestructiveStep = false;

    // Define task containing a Tier 3 step (e.g. deleting or clearing data)
    const taskResult = await hudBridge.executeTaskWithHud({
      name: "Autonomous Workspace Cleanup",
      steps: [
        {
          name: "Safe File Analysis",
          riskTier: RiskTier.TIER_1_SAFE,
          execute: async () => ({ analyzed: true }),
        },
        {
          name: "Purge Stale Build Artifacts",
          riskTier: RiskTier.TIER_3_2FA_REQUIRED,
          execute: async () => {
            executedDestructiveStep = true;
            return { purgedBytes: 1048576 };
          },
        },
      ],
    });

    expect(taskResult.success).toBe(true);
    expect(challengeReceived).not.toBeNull();
    expect(executedDestructiveStep).toBe(true);
    expect(taskResult.stepResults[1]?.required2Fa).toBe(true);
    expect(taskResult.stepResults[1]?.approved2Fa).toBe(true);

    robotWs.close();
  });

  it("halts execution safely if RiskTier.TIER_3_2FA_REQUIRED challenge is rejected or times out", async () => {
    // Connect simulated physical robot
    const robotKeyPair = crypto.generateKeyPairSync("ed25519");
    const robotPubKeyHex = robotKeyPair.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");

    const robotWs = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const parser = new FrameStreamParser();

    await new Promise<void>((resolve) => {
      robotWs.on("open", () => {
        const handshake: HelloHandshake = {
          deviceId: "esp32-s3-reject-robot",
          firmwareVersion: "1.0.0",
          psramFreeBytes: 6000000,
          sdCardCapacityBytes: 32000000000,
          sdCardFreeBytes: 30000000000,
          ed25519PublicKeyHex: robotPubKeyHex,
          capabilities: ["touch_2fa"],
        };
        const payload = encodeControlPayload(HelloHandshakeSchema, handshake);
        const frame = encodeFrame(FrameType.HELLO_HANDSHAKE, payload, 1);
        robotWs.send(frame);
      });

      robotWs.on("message", (data: Buffer) => {
        parser.push(new Uint8Array(data));
      });

      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.MODE_TRANSITION) {
          resolve();
        } else if (frame.header.frameType === FrameType.TOUCH_2FA_CHALLENGE) {
          const challenge = decodeControlPayload(Touch2FaChallengeSchema, frame.payload);

          // Simulate long-press rejection
          const timestamp = Date.now();
          const decision = "DENIED_LONG_PRESS";
          const messageToSign = Buffer.from(
            `${challenge.challengeId}:${challenge.nonce}:${decision}:${timestamp}`
          );
          const sig = crypto.sign(null, messageToSign, robotKeyPair.privateKey);

          const response: Touch2FaResponse = {
            challengeId: challenge.challengeId,
            decision,
            touchTimestampMs: timestamp,
            signatureHex: sig.toString("hex"),
          };

          const resPayload = encodeControlPayload(Touch2FaResponseSchema, response);
          const resFrame = encodeFrame(FrameType.TOUCH_2FA_RESPONSE, resPayload, 2);
          robotWs.send(resFrame);
        }
      });
    });

    let executedDangerousAction = false;

    const taskResult = await hudBridge.executeTaskWithHud({
      name: "Destructive Root Format",
      steps: [
        {
          name: "Format Storage",
          riskTier: RiskTier.TIER_3_2FA_REQUIRED,
          execute: async () => {
            executedDangerousAction = true;
            return { formatted: true };
          },
        },
      ],
    });

    expect(taskResult.success).toBe(false);
    expect(executedDangerousAction).toBe(false);
    expect(taskResult.stepResults[0]?.approved2Fa).toBe(false);

    robotWs.close();
  });

  it("integrates seamlessly into DesktopHarnessDaemon via RPC list_partner_tools and execute_partner_tool", async () => {
    const DAEMON_PORT = 9554;
    const daemon = new DesktopHarnessDaemon({
      port: DAEMON_PORT,
      host: "127.0.0.1",
      allowPairingMode: true,
      bonjourEnabled: false,
      enableTelemetryBroadcasting: false,
    });
    await daemon.start();

    // Verify daemon exposes toolBus and hudBridge
    expect(daemon.toolBus).toBeDefined();
    expect(daemon.hudBridge).toBeDefined();
    expect(daemon.ossLoader).toBeDefined();

    // Connect client
    const clientWs = new WebSocket(`ws://127.0.0.1:${DAEMON_PORT}`);
    const parser = new FrameStreamParser();
    const responses: any[] = [];

    await new Promise<void>((resolve) => {
      clientWs.on("open", () => {
        const handshake: HelloHandshake = {
          deviceId: "companion-client-test",
          firmwareVersion: "1.0.0",
          psramFreeBytes: 0,
          sdCardCapacityBytes: 0,
          sdCardFreeBytes: 0,
          ed25519PublicKeyHex: crypto.randomBytes(32).toString("hex"),
          capabilities: ["rpc_client"],
        };
        const payload = encodeControlPayload(HelloHandshakeSchema, handshake);
        const frame = encodeFrame(FrameType.HELLO_HANDSHAKE, payload, 1);
        clientWs.send(frame);
      });

      clientWs.on("message", (data: Buffer) => {
        parser.push(new Uint8Array(data));
      });

      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HARNESS_RPC_RES) {
          responses.push(frame.payload);
        }
        resolve();
      });
    });

    // 1. Send RPC list_partner_tools
    const listReq: HarnessRpcReq = {
      callId: "req_list_tools",
      method: "list_partner_tools",
      params: {},
    };
    const listPayload = encodeControlPayload(HarnessRpcReqSchema, listReq);
    clientWs.send(encodeFrame(FrameType.HARNESS_RPC_REQ, listPayload, 2));

    await new Promise((r) => setTimeout(r, 100));

    // 2. Send RPC execute_partner_tool (dev_git_status)
    const execReq: HarnessRpcReq = {
      callId: "req_exec_tool",
      method: "execute_partner_tool",
      params: {
        toolName: "dev_git_status",
        params: { repoPath: process.cwd() },
      },
    };
    const execPayload = encodeControlPayload(HarnessRpcReqSchema, execReq);
    clientWs.send(encodeFrame(FrameType.HARNESS_RPC_REQ, execPayload, 3));

    await new Promise((r) => setTimeout(r, 100));

    expect(responses.length).toBeGreaterThanOrEqual(1);

    clientWs.close();
    await daemon.stop();
  });
});
