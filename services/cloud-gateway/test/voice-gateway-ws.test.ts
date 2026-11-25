import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import {
  createCloudGatewayServer,
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
  type CloudGatewayServerInstance,
} from "../src/index.js";

describe("VoiceGatewayWs - Bi-Directional WebSocket & Subscription Gate", () => {
  let server: CloudGatewayServerInstance;
  let baseUrl: string;
  let engine: EntitlementEngine;

  beforeEach(async () => {
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

  it("enforces Subscription Gate: rejects audio uplink for non-PRO user with instant vocal alert", async () => {
    // 1. Register a FREE user and device
    engine.registerUser("user-free-1", "free@petbot.ai");
    engine.registerDevice("user-free-1", "esp32-free-device");

    const freeToken = (
      await engine.mintEntitlementToken("user-free-1", "esp32-free-device", "FREE")
    ).jwt;

    const wsUrl = `${baseUrl.replace("http", "ws")}/ws/v1/voice-stream?token=${freeToken}&deviceId=esp32-free-device`;
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

    // 2. Send an AUDIO_UPLINK_FRAME as a FREE user
    const pcmVoice = new Uint8Array(AUDIO_FRAME_BYTES);
    const uplinkPayload = encodeAudioUplinkFrame({
      rmsEnergy: 4000,
      vadActive: true,
      audioData: pcmVoice,
    });
    const uplinkFrame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, uplinkPayload, 1);

    ws.send(uplinkFrame);

    // 3. Wait for gateway response
    await new Promise((r) => setTimeout(r, 400));

    ws.close();

    // Verify gateway sent AUDIO_DOWNLINK_FRAME alerting user to upgrade
    expect(receivedFrames.length).toBeGreaterThan(0);
    const firstFrame = receivedFrames[0]!;
    expect(firstFrame.header.frameType).toBe(FrameType.AUDIO_DOWNLINK_FRAME);

    const downlink = decodeAudioDownlinkFrame(firstFrame.payload);
    expect(downlink.emotionId).toBe(EmotionId.ALERT);
    expect(downlink.eyeGazeY).toBe(16); // Alert eyes looking up
  });

  it("processes PRO user voice stream, executes tool, and streams synchronized downlink frames", async () => {
    // 1. Register a PRO user and device
    engine.registerUser("user-pro-1", "pro@petbot.ai");
    engine.setUserTier("user-pro-1", "PRO");
    engine.registerDevice("user-pro-1", "esp32-pro-device");

    const proToken = (
      await engine.mintEntitlementToken("user-pro-1", "esp32-pro-device", "PRO", "Nova")
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

    // 2. Send active speech frames
    const voiceSamples = new Int16Array(AUDIO_SAMPLES_PER_FRAME);
    for (let i = 0; i < AUDIO_SAMPLES_PER_FRAME; i++) {
      voiceSamples[i] = Math.round(12000 * Math.sin((2 * Math.PI * 400 * i) / 16000));
    }
    const voiceBytes = new Uint8Array(voiceSamples.buffer, voiceSamples.byteOffset, voiceSamples.byteLength);

    const uplinkPayload = encodeAudioUplinkFrame({
      rmsEnergy: 6000,
      vadActive: true,
      audioData: voiceBytes,
    });
    const uplinkFrame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, uplinkPayload, 1);

    // Send 3 speech frames
    ws.send(uplinkFrame);
    ws.send(uplinkFrame);
    ws.send(uplinkFrame);

    // 3. Send 24 silence frames to trigger silence timeout (450ms)
    const silentPayload = encodeAudioUplinkFrame({
      rmsEnergy: 50,
      vadActive: false,
      audioData: new Uint8Array(AUDIO_FRAME_BYTES),
    });
    const silentFrame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, silentPayload, 2);

    for (let i = 0; i < 24; i++) {
      ws.send(silentFrame);
    }

    // Wait for pipeline processing and downlink streaming
    const waitStart = Date.now();
    while (
      receivedFrames.filter((f) => f.header.frameType === FrameType.HARNESS_RPC_REQ).length === 0 &&
      Date.now() - waitStart < 2000
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }

    ws.close();

    // Verify we received response frames
    expect(receivedFrames.length).toBeGreaterThan(0);

    // Verify at least one tool execution frame (HARNESS_RPC_REQ) was emitted
    const rpcFrames = receivedFrames.filter((f) => f.header.frameType === FrameType.HARNESS_RPC_REQ);
    expect(rpcFrames.length).toBeGreaterThanOrEqual(1);

    // Verify streaming AUDIO_DOWNLINK_FRAME packets arrived
    const downlinkFrames = receivedFrames.filter(
      (f) => f.header.frameType === FrameType.AUDIO_DOWNLINK_FRAME
    );
    expect(downlinkFrames.length).toBeGreaterThan(0);

    const firstDownlink = decodeAudioDownlinkFrame(downlinkFrames[0]!.payload);
    expect(firstDownlink.audioByteLen).toBe(AUDIO_FRAME_BYTES);
    expect(firstDownlink.audioData.byteLength).toBe(AUDIO_FRAME_BYTES);
  });

  it("handles instant Barge-In (Interruption) when user speaks during downlink playback", async () => {
    // 1. Setup PRO connection
    engine.registerUser("user-bargein", "barge@petbot.ai");
    engine.setUserTier("user-bargein", "PRO");
    engine.registerDevice("user-bargein", "esp32-barge-device");

    const proToken = (
      await engine.mintEntitlementToken("user-bargein", "esp32-barge-device", "PRO")
    ).jwt;

    const wsUrl = `${baseUrl.replace("http", "ws")}/ws/v1/voice-stream?token=${proToken}&deviceId=esp32-barge-device`;
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

    const session = server.voiceGatewayManager.getSession("esp32-barge-device");
    expect(session).toBeDefined();

    // Simulate active downlink playback in session
    session!.isStreamingDownlink = true;
    session!.currentDownlinkAbortController = new AbortController();

    // 2. Client sends an AUDIO_UPLINK_FRAME with vadActive = true (Barge-In!)
    const bargePayload = encodeAudioUplinkFrame({
      rmsEnergy: 8000,
      vadActive: true,
      audioData: new Uint8Array(AUDIO_FRAME_BYTES),
    });
    const bargeFrame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, bargePayload, 10);

    ws.send(bargeFrame);

    await new Promise((r) => setTimeout(r, 100));

    // Verify session aborted downlink streaming immediately!
    expect(session!.isStreamingDownlink).toBe(false);

    ws.close();
  });
});
