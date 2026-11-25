import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import {
  createCloudGatewayServer,
  EntitlementEngine,
  PartnerOrchestrator,
  FrameType,
  EmotionId,
  AUDIO_FRAME_BYTES,
  AUDIO_SAMPLES_PER_FRAME,
  decodeFrame,
  decodeAudioDownlinkFrame,
  encodeAudioUplinkFrame,
  encodeFrame,
  FrameStreamParser,
  type CloudGatewayServerInstance,
  type PartnerVoiceTurnResult,
} from "../src/index.js";

describe("PartnerOrchestrator: Autonomous Voice Pipeline & WebSocket Integration", () => {
  let orchestrator: PartnerOrchestrator;
  let server: CloudGatewayServerInstance;
  let baseUrl: string;
  let engine: EntitlementEngine;

  beforeEach(async () => {
    orchestrator = new PartnerOrchestrator({ mockMode: true });

    engine = new EntitlementEngine({
      jwtSecret: "test-jwt-secret-at-least-32-chars-long-for-tests",
    });

    server = await createCloudGatewayServer({
      port: 0,
      entitlementEngine: engine,
      logger: false,
    });
    baseUrl = await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
  });

  it("1. Intent Recognition: correctly identifies partner commands vs general pet chatter", () => {
    // Journey 1
    expect(
      orchestrator.isPartnerCommand(
        "Clean up my Downloads folder, put all PDFs from this week into a folder called 'Invoices', and copy the latest one onto your SD card so I can take it with me."
      )
    ).toBe(true);
    expect(
      orchestrator.detectIntent(
        "Clean up my Downloads folder, put all PDFs from this week into a folder called 'Invoices', and copy the latest one onto your SD card so I can take it with me."
      )
    ).toBe("DOWNLOADS_CLEANUP_AND_SD");

    // Journey 2
    expect(
      orchestrator.isPartnerCommand(
        "Check my unread WhatsApp messages on my phone, tell me if Manideep messaged, and reply that I'll be there in 10 minutes."
      )
    ).toBe(true);
    expect(
      orchestrator.detectIntent(
        "Check my unread WhatsApp messages on my phone, tell me if Manideep messaged, and reply that I'll be there in 10 minutes."
      )
    ).toBe("WHATSAPP_CHECK_AND_REPLY");

    // Journey 3
    expect(
      orchestrator.isPartnerCommand(
        "Mute my mic, close distracting tabs, start a 45-minute deep work timer on your screen, and alert me if my CPU temperature or RAM hits 90%."
      )
    ).toBe(true);
    expect(
      orchestrator.detectIntent(
        "Mute my mic, close distracting tabs, start a 45-minute deep work timer on your screen, and alert me if my CPU temperature or RAM hits 90%."
      )
    ).toBe("DEEP_WORK_AND_SYSTEM_SHIELD");

    // Casual chatter
    expect(orchestrator.isPartnerCommand("Good morning, what's up?")).toBe(false);
    expect(orchestrator.isPartnerCommand("Do a backflip!")).toBe(false);
    expect(orchestrator.isPartnerCommand("What is the capital of France?")).toBe(false);
  });

  it("2. Scenario 1: Downloads cleanup, Invoices organization, and SD Card beaming voice turn", async () => {
    const utterance =
      "Clean up my Downloads folder, put all PDFs from this week into a folder called 'Invoices', and copy the latest one onto your SD card so I can take it with me.";

    const result: PartnerVoiceTurnResult = await orchestrator.handlePartnerVoiceUtterance(utterance, {
      startSeqId: 50,
      speedFactor: 1.0,
    });

    expect(result.isPartnerCommand).toBe(true);
    expect(result.intentType).toBe("DOWNLOADS_CLEANUP_AND_SD");
    expect(result.spokenConfirmation).toContain("Invoices");
    expect(result.spokenConfirmation).toContain("SD card");
    expect(result.spokenEmotion).toBe(EmotionId.HAPPY);
    expect(result.requiresTouch2Fa).toBe(false);

    // Verify audio frames
    expect(result.downlinkFrames.length).toBeGreaterThan(0);
    expect(result.binaryFrames.length).toBe(result.downlinkFrames.length);

    // Verify first binary frame decodes properly
    const firstFrame = result.binaryFrames[0];
    const decoded = decodeFrame(firstFrame);
    expect(decoded.header.frameType).toBe(FrameType.AUDIO_DOWNLINK_FRAME);

    const audioPayload = decodeAudioDownlinkFrame(decoded.payload);
    expect(audioPayload.header.emotionId).toBe(EmotionId.HAPPY);
    expect(audioPayload.audioData.byteLength).toBe(AUDIO_FRAME_BYTES); // 640 bytes PCM
  });

  it("3. Scenario 2: WhatsApp check and 2FA touch background reply voice turn", async () => {
    const utterance =
      "Check my unread WhatsApp messages on my phone, tell me if Manideep messaged, and reply that I'll be there in 10 minutes.";

    const result = await orchestrator.handlePartnerVoiceUtterance(utterance, {
      startSeqId: 100,
    });

    expect(result.isPartnerCommand).toBe(true);
    expect(result.intentType).toBe("WHATSAPP_CHECK_AND_REPLY");
    expect(result.requiresTouch2Fa).toBe(true);
    expect(result.spokenConfirmation).toContain("Manideep");
    expect(result.spokenConfirmation).toContain("10 minutes");
    expect(result.spokenEmotion).toBe(EmotionId.HAPPY);
    expect(result.downlinkFrames.length).toBeGreaterThan(0);
  });

  it("4. Scenario 3: Deep Work Shield voice turn with focused emotion and 45m screen timer", async () => {
    const utterance =
      "Mute my mic, close distracting tabs, start a 45-minute deep work timer on your screen, and alert me if my CPU temperature or RAM hits 90%.";

    const result = await orchestrator.handlePartnerVoiceUtterance(utterance, {
      startSeqId: 200,
    });

    expect(result.isPartnerCommand).toBe(true);
    expect(result.intentType).toBe("DEEP_WORK_AND_SYSTEM_SHIELD");
    expect(result.spokenEmotion).toBe(EmotionId.FOCUSED);
    expect(result.spokenConfirmation).toContain("Deep work initiated");
    expect(result.spokenConfirmation).toContain("45-minute timer");
    expect(result.spokenConfirmation).toContain("90%");
    expect(result.downlinkFrames.length).toBeGreaterThan(0);

    // Eye gaze for focused mode should be centered
    const sampleFrame = result.downlinkFrames[0];
    expect(sampleFrame.eyeGazeX).toBe(0);
    expect(sampleFrame.eyeGazeY).toBe(0);
  });

  it("5. Live WebSocket Gateway: streams synchronized partner audio downlink frames for PRO users", async () => {
    // 1. Register PRO user and device
    engine.registerUser("user-pro-1", "pro@petbot.ai");
    engine.registerDevice("user-pro-1", "esp32-pro-device");

    const proToken = (
      await engine.mintEntitlementToken("user-pro-1", "esp32-pro-device", "PRO")
    ).jwt;

    const wsUrl = `${baseUrl.replace("http", "ws")}/ws/v1/voice-stream?token=${proToken}&deviceId=esp32-pro-device`;
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
    });

    const receivedFrames: ReturnType<typeof decodeFrame>[] = [];
    const parser = new FrameStreamParser();
    parser.onFrame((frame) => {
      receivedFrames.push(frame);
    });

    ws.on("message", (data: Buffer) => {
      parser.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    });

    // Provide mock STT transcription that matches Journey 3
    const voiceManager = server.voiceGatewayManager;
    (voiceManager as any).sttTranscriber = async () =>
      "Mute my mic, close distracting tabs, start a 45-minute deep work timer on your screen, and alert me if my CPU temperature or RAM hits 90%.";

    // Send active speech uplink frames (20 consecutive speech frames to simulate 400ms speech)
    for (let i = 0; i < 20; i++) {
      const pcmSpeech = new Uint8Array(AUDIO_FRAME_BYTES);
      const uplinkPayload = encodeAudioUplinkFrame({
        rmsEnergy: 4500,
        vadActive: true,
        audioData: pcmSpeech,
      });
      const uplinkFrame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, uplinkPayload, i + 1);
      ws.send(uplinkFrame);
      await new Promise((r) => setTimeout(r, 5));
    }

    // Send 25 silence frames to trigger VAD utterance completion (450ms silence timeout)
    for (let i = 20; i < 45; i++) {
      const pcmSilence = new Uint8Array(AUDIO_FRAME_BYTES);
      const uplinkPayload = encodeAudioUplinkFrame({
        rmsEnergy: 100,
        vadActive: false,
        audioData: pcmSilence,
      });
      const uplinkFrame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, uplinkPayload, i + 1);
      ws.send(uplinkFrame);
      await new Promise((r) => setTimeout(r, 5));
    }

    // Wait for the gateway to process the completed utterance and stream downlink frames
    await new Promise((r) => setTimeout(r, 600));

    // Verify that AUDIO_DOWNLINK_FRAME frames were received by the robot client
    const downlinkFrames = receivedFrames.filter(
      (f) => f.header.frameType === FrameType.AUDIO_DOWNLINK_FRAME
    );

    expect(downlinkFrames.length).toBeGreaterThan(0);

    const firstDownlink = decodeAudioDownlinkFrame(downlinkFrames[0].payload);
    expect(firstDownlink.header.emotionId).toBe(EmotionId.FOCUSED);

    ws.close();
  });
});
