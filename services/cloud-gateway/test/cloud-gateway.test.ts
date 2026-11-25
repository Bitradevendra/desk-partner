import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import {
  buildCloudGatewayServer,
  EntitlementEngine,
  FrameType,
  EmotionId,
  AUDIO_FRAME_BYTES,
  AUDIO_SAMPLES_PER_FRAME,
  decodeFrame,
  decodeAudioDownlinkFrame,
  encodeAudioUplinkFrame,
  encodeFrame,
  FrameStreamParser,
  SubscriptionEntitlementSyncSchema,
  decodeControlPayload,
  type CloudGatewayServerInstance,
  type DecodedFrame,
} from "../src/index.js";
import {
  WidgetPackageSchema,
  decompileBytecodeToWidget,
  compileWidgetToBytecode,
  type WidgetPackage,
} from "@petbot/widget-schema";

describe("Cloud Gateway - End-to-End Integration Suite", () => {
  let server: CloudGatewayServerInstance;
  let baseUrl: string;
  let engine: EntitlementEngine;

  beforeEach(async () => {
    engine = new EntitlementEngine({
      jwtSecret: "test-jwt-secret-at-least-32-chars-long-for-tests",
    });

    server = await buildCloudGatewayServer({
      port: 0,
      entitlementEngine: engine,
      logger: false,
    });
    baseUrl = await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
  });

  // ==========================================================================
  // 1. Subscription Entitlement Lifecycle Integration Test
  // ==========================================================================
  describe("Subscription Entitlement Lifecycle", () => {
    it("manages complete lifecycle: register FREE -> voice WS blocks audio -> upgrade PRO -> verify signed JWT & binary sync frame", async () => {
      const userId = "test-user-e2e-1";
      const deviceId = "esp32s3-device-e2e-1";

      // A. Register Device with FREE Tier via REST API
      const registerRes = await server.app.inject({
        method: "POST",
        url: "/api/v1/auth/register-device",
        payload: {
          userId,
          deviceId,
          email: "e2e@petbot.ai",
        },
      });

      expect(registerRes.statusCode).toBe(200);
      const regBody = JSON.parse(registerRes.body);
      expect(regBody.success).toBe(true);
      expect(regBody.tier).toBe("FREE");
      expect(regBody.capabilities.voiceAiEnabled).toBe(false);
      expect(regBody.capabilities.dailyWidgetGenerationsLimit).toBe(3);
      expect(regBody.capabilities.cloudAgenticToolsEnabled).toBe(false);
      expect(regBody.jwt).toBeDefined();

      const freeToken = regBody.jwt;

      // B. Connect to Voice WebSocket with FREE token and verify it blocks/rejects audio streaming
      const wsUrl = `${baseUrl.replace("http", "ws")}/ws/v1/voice-stream?token=${freeToken}&deviceId=${deviceId}`;
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", (err) => reject(err));
      });

      const receivedFrames: DecodedFrame[] = [];
      const parser = new FrameStreamParser();
      parser.onFrame((frame) => {
        receivedFrames.push(frame);
      });

      ws.on("message", (data: Buffer) => {
        parser.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });

      // Stream an AUDIO_UPLINK_FRAME as FREE user
      const dummyPcm = new Uint8Array(AUDIO_FRAME_BYTES);
      const uplinkPayload = encodeAudioUplinkFrame({
        rmsEnergy: 5000,
        vadActive: true,
        audioData: dummyPcm,
      });
      const uplinkFrame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, uplinkPayload, 1);
      ws.send(uplinkFrame);

      // Wait for gateway response
      await new Promise((resolve) => setTimeout(resolve, 350));
      ws.close();

      // Verify gateway responded with rejection alert prompt (ALERT emotion)
      expect(receivedFrames.length).toBeGreaterThan(0);
      const alertFrame = receivedFrames.find(
        (f) => f.header.frameType === FrameType.AUDIO_DOWNLINK_FRAME
      );
      expect(alertFrame).toBeDefined();
      const alertDownlink = decodeAudioDownlinkFrame(alertFrame!.payload);
      expect(alertDownlink.emotionId).toBe(EmotionId.ALERT);

      // C. Upgrade user to PRO via Stripe webhook simulation
      const webhookRes = await server.app.inject({
        method: "POST",
        url: "/api/v1/billing/webhook",
        payload: {
          type: "checkout.session.completed",
          data: {
            object: {
              customer: "cus_e2e_123",
              client_reference_id: userId,
              subscription: "sub_e2e_123",
            },
          },
        },
      });

      expect(webhookRes.statusCode).toBe(200);
      const webhookBody = JSON.parse(webhookRes.body);
      expect(webhookBody.received).toBe(true);
      expect(webhookBody.updatedTier).toBe("PRO");

      // Verify user in EntitlementEngine is now PRO
      const user = engine.getUser(userId);
      expect(user).toBeDefined();
      expect(user!.tier).toBe("PRO");

      // D. Mint Entitlements and verify cryptographic signed JWT & binary sync frame
      const proEntitlements = await engine.mintEntitlementToken(
        userId,
        deviceId,
        "PRO",
        "Atlas"
      );

      expect(proEntitlements.capabilities.voiceAiEnabled).toBe(true);
      expect(proEntitlements.capabilities.cloudAgenticToolsEnabled).toBe(true);
      expect(proEntitlements.capabilities.dailyWidgetGenerationsLimit).toBe(Infinity);

      // Verify EdDSA/JWT claims
      const claims = await engine.verifyEntitlementJwt(proEntitlements.jwt);
      expect(claims.sub).toBe(userId);
      expect(claims.deviceId).toBe(deviceId);
      expect(claims.tier).toBe("PRO");
      expect(claims.voiceAiEnabled).toBe(true);
      expect(claims.allowedPersonas).toContain("Atlas");

      // Verify FrameType.SUBSCRIPTION_ENTITLEMENT_SYNC binary frame
      const syncDecoded = decodeFrame(proEntitlements.binaryFrame);
      expect(syncDecoded.header.frameType).toBe(
        FrameType.SUBSCRIPTION_ENTITLEMENT_SYNC
      );

      const parsedPayload = decodeControlPayload(
        SubscriptionEntitlementSyncSchema,
        syncDecoded.payload
      );
      expect(parsedPayload.tier).toBe("PRO");
      expect(parsedPayload.jwtToken).toBe(proEntitlements.jwt);
      expect(parsedPayload.enabledPersonas).toContain("Atlas");
    });
  });

  // ==========================================================================
  // 2. Bi-Directional Voice + Viseme Streaming Integration Test
  // ==========================================================================
  describe("Bi-Directional Voice + Viseme Streaming", () => {
    it("connects with PRO token, streams 20ms audio frames, executes tool call, and returns synchronized audio/viseme downlinks", async () => {
      const userId = "voice-pro-user";
      const deviceId = "esp32s3-pro-device";

      // Register and set user to PRO
      engine.registerUser(userId, "voice@petbot.ai");
      engine.setUserTier(userId, "PRO");
      engine.registerDevice(userId, deviceId);

      const proToken = (
        await engine.mintEntitlementToken(userId, deviceId, "PRO", "Nova")
      ).jwt;

      // Connect to Voice WebSocket
      const wsUrl = `${baseUrl.replace("http", "ws")}/ws/v1/voice-stream?token=${proToken}&deviceId=${deviceId}`;
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", (err) => reject(err));
      });

      const receivedFrames: DecodedFrame[] = [];
      const parser = new FrameStreamParser();
      parser.onFrame((frame) => {
        receivedFrames.push(frame);
      });

      ws.on("message", (data: Buffer) => {
        parser.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });

      // Stream 4 active speech frames (16kHz 16-bit mono PCM with 400Hz test tone)
      const speechSamples = new Int16Array(AUDIO_SAMPLES_PER_FRAME);
      for (let i = 0; i < AUDIO_SAMPLES_PER_FRAME; i++) {
        speechSamples[i] = Math.round(10000 * Math.sin((2 * Math.PI * 400 * i) / 16000));
      }
      const speechBytes = new Uint8Array(
        speechSamples.buffer,
        speechSamples.byteOffset,
        speechSamples.byteLength
      );

      const speechPayload = encodeAudioUplinkFrame({
        rmsEnergy: 5500,
        vadActive: true,
        audioData: speechBytes,
      });
      const speechFrame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, speechPayload, 1);

      for (let i = 0; i < 4; i++) {
        ws.send(speechFrame);
      }

      // Stream 24 silence frames to trigger VAD silence timeout (450ms)
      const silencePayload = encodeAudioUplinkFrame({
        rmsEnergy: 40,
        vadActive: false,
        audioData: new Uint8Array(AUDIO_FRAME_BYTES),
      });
      const silenceFrame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, silencePayload, 2);

      for (let i = 0; i < 24; i++) {
        ws.send(silenceFrame);
      }

      // Wait for AI brain processing and downlink streaming
      const waitStart = Date.now();
      while (
        receivedFrames.filter((f) => f.header.frameType === FrameType.AUDIO_DOWNLINK_FRAME)
          .length === 0 &&
        Date.now() - waitStart < 2500
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }

      ws.close();

      // Verify tool call frame (HARNESS_RPC_REQ for mute PC mic) was emitted
      const toolFrames = receivedFrames.filter(
        (f) => f.header.frameType === FrameType.HARNESS_RPC_REQ
      );
      expect(toolFrames.length).toBeGreaterThanOrEqual(1);

      // Verify streaming AUDIO_DOWNLINK_FRAME packets arrived
      const downlinkFrames = receivedFrames.filter(
        (f) => f.header.frameType === FrameType.AUDIO_DOWNLINK_FRAME
      );
      expect(downlinkFrames.length).toBeGreaterThan(0);

      // Verify packet structure of downlink frames and audio data
      let totalNonZeroSamples = 0;
      let hasPositiveMouthOpen = false;

      for (const frame of downlinkFrames) {
        const decoded = decodeAudioDownlinkFrame(frame.payload);

        // Emotion ID must be a recognized EmotionId enum value
        expect(Object.values(EmotionId)).toContain(decoded.emotionId);

        // Viseme mouth opening must be 0..255
        expect(decoded.visemeMouthOpen).toBeGreaterThanOrEqual(0);
        expect(decoded.visemeMouthOpen).toBeLessThanOrEqual(255);
        if (decoded.visemeMouthOpen > 0) {
          hasPositiveMouthOpen = true;
        }

        // Eye gaze values must be int8 coordinate ranges
        expect(decoded.eyeGazeX).toBeGreaterThanOrEqual(-128);
        expect(decoded.eyeGazeX).toBeLessThanOrEqual(127);
        expect(decoded.eyeGazeY).toBeGreaterThanOrEqual(-128);
        expect(decoded.eyeGazeY).toBeLessThanOrEqual(127);

        // Audio payload must contain 640 bytes (320 samples @ 16-bit mono PCM = 20ms)
        expect(decoded.audioByteLen).toBe(AUDIO_FRAME_BYTES);
        expect(decoded.audioData.byteLength).toBe(AUDIO_FRAME_BYTES);

        // Accumulate non-zero audio samples from 16kHz PCM stream
        const pcmView = new Int16Array(
          decoded.audioData.buffer,
          decoded.audioData.byteOffset,
          decoded.audioData.byteLength / 2
        );
        for (let i = 0; i < pcmView.length; i++) {
          if (pcmView[i] !== 0) {
            totalNonZeroSamples++;
          }
        }
      }

      // Entire synthesized audio stream must contain real non-zero waveforms
      expect(totalNonZeroSamples).toBeGreaterThan(0);
      expect(hasPositiveMouthOpen).toBe(true);
    });
  });

  // ==========================================================================
  // 3. Zero-Code Studio Generation & Iterative Refinement Integration Test
  // ==========================================================================
  describe("Zero-Code Studio Generation & Iterative Refinement", () => {
    it("generates widget from plain English, refines it iteratively, compiles PBWG bytecode, and verifies zero raw code in summary", async () => {
      // Step A: Initial Generation
      const initialRes = await server.app.inject({
        method: "POST",
        url: "/api/v1/studio/generate",
        payload: {
          prompt: "Create a hydration tracker for 8 cups of water",
        },
      });

      expect(initialRes.statusCode).toBe(200);
      const initialData = JSON.parse(initialRes.body);
      expect(initialData.success).toBe(true);

      // Verify WidgetPackage Schema
      const initialWidget: WidgetPackage = WidgetPackageSchema.parse(initialData.widget);
      expect(initialWidget.manifest.name).toBe("Hydration Goal");
      expect(initialWidget.state["goalCups"]).toBeDefined();
      expect(initialWidget.state["goalCups"]!.initialValue).toBe(8);

      // Verify compiled PBWG binary bytecode
      expect(initialData.bytecodeBase64).toBeDefined();
      const initialBytecode = Buffer.from(initialData.bytecodeBase64, "base64");
      expect(initialBytecode.length).toBeGreaterThan(32);

      // Decompile PBWG bytecode and verify roundtrip integrity
      const decompiledInitial = decompileBytecodeToWidget(new Uint8Array(initialBytecode));
      expect(decompiledInitial.manifest.name).toBe("Hydration Goal");

      // Verify assistantSummary contains NO code blocks, backticks, or raw JSON
      const summary1 = initialData.assistantSummary;
      expect(summary1).toBeDefined();
      expect(summary1).not.toContain("```");
      expect(summary1).not.toContain("`");
      expect(summary1).not.toContain("{");
      expect(summary1).not.toContain("}");
      expect(summary1.length).toBeGreaterThan(15);
      expect(summary1.toLowerCase()).toContain("tap");

      // Step B: Iterative Refinement
      const refineRes = await server.app.inject({
        method: "POST",
        url: "/api/v1/studio/generate",
        payload: {
          prompt: "increase target goal to 12 and change color to emerald green",
          currentWidget: initialWidget,
        },
      });

      expect(refineRes.statusCode).toBe(200);
      const refineData = JSON.parse(refineRes.body);
      expect(refineData.success).toBe(true);

      // Verify Refined WidgetPackage Schema
      const refinedWidget: WidgetPackage = WidgetPackageSchema.parse(refineData.widget);
      expect(refinedWidget.state["goalCups"]!.initialValue).toBe(12);

      // Verify progress bar color is updated to emerald green
      let foundEmeraldColor = false;
      function checkColor(node: any) {
        if (
          node.fgColor === "#10B981" ||
          node.fgColor === "#22C55E" ||
          node.color === "#10B981" ||
          node.color === "#22C55E"
        ) {
          foundEmeraldColor = true;
        }
        if (node.children && Array.isArray(node.children)) {
          for (const child of node.children) checkColor(child);
        }
      }
      checkColor(refinedWidget.ui);
      expect(foundEmeraldColor).toBe(true);

      // Verify refined bytecode compiles and decompiles cleanly
      const refinedBytecode = Buffer.from(refineData.bytecodeBase64, "base64");
      const decompiledRefined = decompileBytecodeToWidget(new Uint8Array(refinedBytecode));
      expect(decompiledRefined.manifest.name).toBe("Hydration Goal");

      // Verify refined summary contains zero raw code
      const summary2 = refineData.assistantSummary;
      expect(summary2).not.toContain("```");
      expect(summary2).not.toContain("`");
      expect(summary2).not.toContain("{");
      expect(summary2).not.toContain("}");
      expect(summary2).toContain("12");

      // Step C: Studio Templates Retrieval
      const templatesRes = await server.app.inject({
        method: "GET",
        url: "/api/v1/studio/templates",
      });

      expect(templatesRes.statusCode).toBe(200);
      const templatesData = JSON.parse(templatesRes.body);
      expect(templatesData.success).toBe(true);
      expect(Array.isArray(templatesData.templates)).toBe(true);
      expect(templatesData.templates.length).toBeGreaterThanOrEqual(4);

      // Verify every template satisfies schema and can compile to bytecode
      for (const tpl of templatesData.templates) {
        expect(tpl.id).toBeDefined();
        expect(tpl.name).toBeDefined();
        expect(tpl.category).toBeDefined();
        expect(tpl.description).toBeDefined();
        expect(tpl.bytecodeBase64).toBeDefined();

        const validatedTplWidget = WidgetPackageSchema.parse(tpl.widget);
        const compiled = compileWidgetToBytecode(validatedTplWidget);
        expect(compiled.byteLength).toBeGreaterThan(32);
      }

      // Verify Mute PC Mic template has linkedWorkflow
      const micTemplate = templatesData.templates.find((t: any) =>
        t.name.toLowerCase().includes("mute")
      );
      expect(micTemplate).toBeDefined();
      expect(micTemplate.linkedWorkflow).toBeDefined();
      expect(micTemplate.linkedWorkflow.steps[0].riskTier).toBe("TIER_1_SAFE");
    });
  });
});
