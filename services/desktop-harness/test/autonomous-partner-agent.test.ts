import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import WebSocket from "ws";
import {
  FrameType,
  EmotionId,
  RiskTier,
  Touch2FADecision,
  decodeFrame,
  decodeAudioDownlinkFrame,
  encodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  FrameStreamParser,
  HelloHandshakeSchema,
  HarnessRpcReqSchema,
  HarnessRpcResSchema,
  Touch2FaChallengeSchema,
  Touch2FaResponseSchema,
  type HelloHandshake,
  type HarnessRpcReq,
  type HarnessRpcRes,
} from "@petbot/protocol";
import {
  createDesktopHarnessInstance,
  DesktopHarnessDaemon,
  AutonomousPartnerAgent,
  HeadlessPartnerToolBus,
  RobotLiveHudBridge,
  TelemetryMonitor,
  HarnessServer,
  CryptoVault,
  AuditLogger,
  createPlatformAdapter,
} from "../src/index.js";

const TEST_PORT = 9560;

describe("AutonomousPartnerAgent: Plan & Execution Loop", () => {
  let tempDir: string;
  let auditLogFile: string;
  let workflowsFile: string;
  let daemon: DesktopHarnessDaemon;
  let downloadsDir: string;
  let invoicesDir: string;

  const robotDeviceId = "petbot-esp32-agentic";
  const robotSecretHex = crypto.randomBytes(32).toString("hex");
  const robotPubKeyHex = crypto.randomBytes(32).toString("hex");

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot_partner_test_"));
    auditLogFile = path.join(tempDir, "audit.jsonl");
    workflowsFile = path.join(tempDir, "workflows.json");
    downloadsDir = path.join(tempDir, "Downloads");
    invoicesDir = path.join(downloadsDir, "Invoices");

    fs.mkdirSync(downloadsDir, { recursive: true });

    // Seed mock download files
    fs.writeFileSync(path.join(downloadsDir, "invoice_aws_nov.pdf"), "%PDF-1.4 Mock AWS Invoice Content");
    fs.writeFileSync(path.join(downloadsDir, "contract_client.pdf"), "%PDF-1.4 Mock Client Contract Content");
    fs.writeFileSync(path.join(downloadsDir, "random_notes.txt"), "Meeting notes for Tuesday");

    daemon = await createDesktopHarnessInstance({
      port: TEST_PORT,
      host: "127.0.0.1",
      allowPairingMode: true,
      bonjourEnabled: false,
      enableTelemetryBroadcasting: false,
      auditLogFilePath: auditLogFile,
      workflowsFilePath: workflowsFile,
      osOptions: { mock: true },
    });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("gathers comprehensive live context across Desktop, FileSystem, Telemetry, and Mobile", async () => {
    const partnerAgent = daemon.getPartnerAgent();
    expect(partnerAgent).toBeDefined();

    // Set mobile notifications
    partnerAgent.setMockMobileNotifications([
      {
        id: "notif_wa_1",
        sender: "Manideep",
        app: "WhatsApp",
        body: "Hey, are you joining the architecture review call?",
        timestamp: Date.now(),
        replyActionAvailable: true,
      },
    ]);

    const context = await partnerAgent.gatherLiveContext();

    expect(context).toBeDefined();
    expect(context.timestamp).toBeGreaterThan(0);
    expect(context.activeWindow).toBeDefined();
    expect(typeof context.activeWindow.appName).toBe("string");
    expect(context.systemMetrics).toBeDefined();
    expect(typeof context.systemMetrics.cpuPercent).toBe("number");
    expect(context.mobileContext.connected).toBe(true);
    expect(context.mobileContext.unreadNotifications.length).toBe(1);
    expect(context.mobileContext.unreadNotifications[0].sender).toBe("Manideep");
  });

  it("handles Scenario 1: Downloads cleanup, Invoices organization, and SD Card beaming", async () => {
    const partnerAgent = daemon.getPartnerAgent();

    const userCommand =
      "Clean up my Downloads folder, put all PDFs from this week into a folder called 'Invoices', and copy the latest one onto your SD card so I can take it with me.";

    const plan = await partnerAgent.generatePlan(userCommand);

    expect(plan.intentType).toBe("DOWNLOADS_CLEANUP_AND_SD");
    expect(plan.steps.length).toBeGreaterThanOrEqual(3);

    // Verify step actions
    const toolNames = plan.steps.map((s) => s.toolName);
    expect(toolNames).toContain("file_write");
    expect(toolNames).toContain("file_beam_to_robot_sd");

    // Execute plan
    const result = await partnerAgent.executePlan(plan);

    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(plan.steps.length);
    expect(result.spokenConfirmation).toContain("Invoices");
    expect(result.spokenEmotion).toBe(EmotionId.HAPPY);
    expect(result.audioDownlinkFrames).toBeDefined();
    expect(result.audioDownlinkFrames!.length).toBeGreaterThan(0);

    // Verify first audio downlink frame conforms to protocol
    const firstFrame = result.audioDownlinkFrames![0];
    const decodedEnvelope = decodeFrame(firstFrame);
    expect(decodedEnvelope.header.frameType).toBe(FrameType.AUDIO_DOWNLINK_FRAME);

    const audioDownlink = decodeAudioDownlinkFrame(decodedEnvelope.payload);
    expect(audioDownlink.header.emotionId).toBe(EmotionId.HAPPY);
    expect(audioDownlink.audioData.byteLength).toBe(640); // 20ms at 16kHz
  });

  it("handles Scenario 2: WhatsApp check and 2FA hardware-approved background reply", async () => {
    const partnerAgent = daemon.getPartnerAgent();

    partnerAgent.injectMobileNotification({
      id: "wa_manideep_99",
      sender: "Manideep",
      app: "WhatsApp",
      body: "Hey, are you free to chat right now?",
      timestamp: Date.now(),
      replyActionAvailable: true,
    });

    const userCommand =
      "Check my unread WhatsApp messages on my phone, tell me if Manideep messaged, and reply that I'll be there in 10 minutes.";

    const plan = await partnerAgent.generatePlan(userCommand);

    expect(plan.intentType).toBe("WHATSAPP_CHECK_AND_REPLY");
    expect(plan.requiresTouch2Fa).toBe(true);

    const replyStep = plan.steps.find((s) => s.toolName === "mobile_send_reply");
    expect(replyStep).toBeDefined();
    expect(replyStep!.riskTier).toBe(RiskTier.TIER_3_2FA_REQUIRED);

    // Mock hardware touch 2FA approval on the server
    const harnessServer = (daemon as any).server as HarnessServer;
    const origRequest2fa = harnessServer.requestHardwareTouch2FA.bind(harnessServer);
    harnessServer.requestHardwareTouch2FA = async () => true;

    try {
      const result = await partnerAgent.executePlan(plan);
      expect(result.success).toBe(true);
      expect(result.spokenConfirmation).toContain("Manideep");
      expect(result.spokenConfirmation).toContain("10 minutes");
      expect(result.spokenEmotion).toBe(EmotionId.HAPPY);
    } finally {
      harnessServer.requestHardwareTouch2FA = origRequest2fa;
    }
  });

  it("handles Scenario 2 abort: safely cancels Tier-3 action when 2FA hardware touch is denied", async () => {
    const partnerAgent = daemon.getPartnerAgent();

    partnerAgent.injectMobileNotification({
      id: "wa_manideep_100",
      sender: "Manideep",
      app: "WhatsApp",
      body: "Are you coming?",
      timestamp: Date.now(),
      replyActionAvailable: true,
    });

    const userCommand =
      "Check my unread WhatsApp messages on my phone, tell me if Manideep messaged, and reply that I'll be there in 10 minutes.";

    const plan = await partnerAgent.generatePlan(userCommand);

    // Mock hardware touch 2FA denial
    const harnessServer = (daemon as any).server as HarnessServer;
    const origRequest2fa = harnessServer.requestHardwareTouch2FA.bind(harnessServer);
    harnessServer.requestHardwareTouch2FA = async () => false;

    try {
      const result = await partnerAgent.executePlan(plan);
      expect(result.success).toBe(false);
      expect(result.error).toContain("denied or timed out");
    } finally {
      harnessServer.requestHardwareTouch2FA = origRequest2fa;
    }
  });

  it("handles Scenario 3: Deep Work Shield (mic mute, close distracting tabs, 45m screen timer, CPU guard)", async () => {
    const partnerAgent = daemon.getPartnerAgent();

    const userCommand =
      "Mute my mic, close distracting tabs, start a 45-minute deep work timer on your screen, and alert me if my CPU temperature or RAM hits 90%.";

    const plan = await partnerAgent.generatePlan(userCommand);

    expect(plan.intentType).toBe("DEEP_WORK_AND_SYSTEM_SHIELD");
    expect(plan.steps.length).toBeGreaterThanOrEqual(4);

    const toolNames = plan.steps.map((s) => s.toolName);
    expect(toolNames).toContain("os_mic_mute");
    expect(toolNames).toContain("browser_close_tabs");
    expect(toolNames).toContain("robot_start_timer");
    expect(toolNames).toContain("system_guard_thresholds");

    const result = await partnerAgent.executePlan(plan);

    expect(result.success).toBe(true);
    expect(result.spokenConfirmation).toContain("Deep work initiated");
    expect(result.spokenConfirmation).toContain("45-minute timer");
    expect(result.spokenEmotion).toBe(EmotionId.FOCUSED);
    expect(result.audioDownlinkFrames!.length).toBeGreaterThan(0);
  });

  it("integrates with Harness Daemon RPC for remote voice and companion execution", async () => {
    const boundPort = daemon.getBoundPort();
    const ws = new WebSocket(`ws://127.0.0.1:${boundPort}`);
    const parser = new FrameStreamParser();

    ws.on("message", (data: Buffer) => {
      parser.push(new Uint8Array(data));
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        // Authenticate companion client with valid handshake
        const handshake: HelloHandshake = {
          deviceId: "companion-voice-controller",
          firmwareVersion: "1.0.0",
          psramFreeBytes: 0,
          sdCardCapacityBytes: 0,
          sdCardFreeBytes: 0,
          ed25519PublicKeyHex: crypto.randomBytes(32).toString("hex"),
          capabilities: ["rpc_client"],
        };
        const handshakePayload = encodeControlPayload(HelloHandshakeSchema, handshake);
        const initFrame = encodeFrame(FrameType.HELLO_HANDSHAKE, handshakePayload, 1);
        ws.send(initFrame);
      });

      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HELLO_HANDSHAKE) {
          resolve();
        }
      });

      ws.once("error", reject);
    });

    // Brief delay to ensure server session is fully registered and marked authenticated
    await new Promise((r) => setTimeout(r, 100));

    // Send partner_agent_execute RPC request
    const rpcReq: HarnessRpcReq = {
      callId: "call_partner_voice_001",
      method: "partner_agent_execute",
      params: {
        command: "Mute my mic, close distracting tabs, start a 45-minute deep work timer on your screen, and alert me if my CPU temperature or RAM hits 90%.",
      },
    };

    const rpcPayload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
    const rpcFrame = encodeFrame(FrameType.HARNESS_RPC_REQ, rpcPayload, 2);

    const responsePromise = new Promise<HarnessRpcRes>((resolve) => {
      parser.onFrame((frame) => {
        if (frame.header.frameType === FrameType.HARNESS_RPC_RES) {
          const res = decodeControlPayload(HarnessRpcResSchema, frame.payload);
          if (res.callId === "call_partner_voice_001") {
            resolve(res);
          }
        }
      });
    });

    ws.send(rpcFrame);

    const rpcRes = await responsePromise;
    expect(rpcRes.success).toBe(true);
    expect(rpcRes.result).toBeDefined();
    expect(rpcRes.result.spokenConfirmation).toContain("Deep work initiated");

    ws.close();
  }, 15000);
});
