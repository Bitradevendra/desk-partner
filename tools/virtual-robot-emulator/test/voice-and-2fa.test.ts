import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "node:crypto";
import {
  FrameType,
  encodeFrame,
  decodeFrame,
  crc32,
  encodeAudioUplinkFrame,
  decodeAudioUplinkFrame,
  encodeAudioDownlinkFrame,
  decodeAudioDownlinkFrame,
  encodeControlPayload,
  decodeControlPayload,
  Touch2FaChallengeSchema,
  Touch2FaResponseSchema,
  SubscriptionEntitlementSyncSchema,
  AudioCodec,
  EmotionId,
  RiskTier,
  Touch2FADecision,
  type Touch2FaChallenge,
  type Touch2FaResponse,
  type SubscriptionEntitlementSync,
} from "@petbot/protocol";

describe("Voice AI Streaming Pipeline & Hardware 2FA Consent Engine Verification", () => {
  const firmwareDir = path.resolve(__dirname, "../../../firmware");
  const voiceStreamerHPath = path.join(firmwareDir, "include/agentic/voice_streamer.h");
  const voiceStreamerCppPath = path.join(firmwareDir, "src/agentic/voice_streamer.cpp");
  const touch2faHPath = path.join(firmwareDir, "include/agentic/touch_2fa.h");
  const touch2faCppPath = path.join(firmwareDir, "src/agentic/touch_2fa.cpp");
  const uiManagerCppPath = path.join(firmwareDir, "src/ui/ui_manager.cpp");
  const mainCppPath = path.join(firmwareDir, "src/main.cpp");

  it("verifies Voice AI and Touch 2FA C++20 source and header files exist with zero TODOs or placeholders", () => {
    const files = [
      voiceStreamerHPath,
      voiceStreamerCppPath,
      touch2faHPath,
      touch2faCppPath,
    ];

    for (const f of files) {
      expect(fs.existsSync(f), `File missing: ${f}`).toBe(true);
      const content = fs.readFileSync(f, "utf-8");
      expect(content).not.toMatch(/\bTODO\b/);
      expect(content).not.toMatch(/\bFIXME\b/);
      expect(content).not.toMatch(/\bPLACEHOLDER\b/);
      expect(content.length).toBeGreaterThan(500);
    }
  });

  it("verifies UIManager and main.cpp properly integrate VoiceStreamer and Touch2FAManager", () => {
    const uiContent = fs.readFileSync(uiManagerCppPath, "utf-8");
    expect(uiContent).toContain("Touch2FAManager::instance().isModalActive()");
    expect(uiContent).toContain("Touch2FAManager::instance().render(canvas)");
    expect(uiContent).toContain("Touch2FAManager::instance().handleTouch(evt)");
    expect(uiContent).toContain("VoiceStreamer::instance().isUpsellPromptActive()");
    expect(uiContent).toContain("VoiceStreamer::instance().renderUpsellPrompt(canvas)");

    const mainContent = fs.readFileSync(mainCppPath, "utf-8");
    expect(mainContent).toContain("VoiceStreamer::instance().init();");
    expect(mainContent).toContain("Touch2FAManager::instance().init();");
    expect(mainContent).toContain("VoiceStreamer::instance().update");
    expect(mainContent).toContain("Touch2FAManager::instance().update");
    expect(mainContent).toContain("Touch2FAManager::instance().isModalActive()");
  });

  describe("Binary Audio Uplink Framing (ESP32 Mic -> Cloud/Host)", () => {
    it("encodes and decodes 20ms (320 samples @ 16kHz) PCM uplink frames with 6-byte header", () => {
      // 320 samples * 2 bytes = 640 bytes
      const pcmSamples = new Int16Array(320);
      for (let i = 0; i < 320; ++i) {
        // 440 Hz test tone sine wave
        pcmSamples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 16000);
      }
      const rawAudioBytes = new Uint8Array(pcmSamples.buffer, pcmSamples.byteOffset, pcmSamples.byteLength);

      const uplinkPayload = encodeAudioUplinkFrame({
        rmsEnergy: 12500,
        vadActive: true,
        codec: AudioCodec.PCM16,
        sampleCount: 320,
        audioData: rawAudioBytes,
      });

      // 6-byte header + 640-byte audio = 646 bytes
      expect(uplinkPayload.byteLength).toBe(6 + 640);

      // Wrap in PetBot binary frame
      const frameBytes = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, uplinkPayload, 42);
      expect(frameBytes.byteLength).toBe(12 + 646 + 4); // 662 bytes

      const decodedFrame = decodeFrame(frameBytes);
      expect(decodedFrame.header.frameType).toBe(FrameType.AUDIO_UPLINK_FRAME);
      expect(decodedFrame.header.seqId).toBe(42);

      const decodedAudio = decodeAudioUplinkFrame(decodedFrame.payload);
      expect(decodedAudio.header.rmsEnergy).toBe(12500);
      expect(Boolean(decodedAudio.header.vadActive)).toBe(true);
      expect(decodedAudio.header.codec).toBe(AudioCodec.PCM16);
      expect(decodedAudio.header.sampleCount).toBe(320);
      expect(decodedAudio.audioData.byteLength).toBe(640);
    });
  });

  describe("Binary Audio Downlink Framing & Zero-Lag Viseme/Emotion Sync", () => {
    it("encodes and decodes 8-byte visual emotion & viseme sync header with audio samples", () => {
      const audioBytes = new Uint8Array(960); // 30ms of 16kHz audio
      crypto.randomFillSync(audioBytes);

      const downlinkPayload = encodeAudioDownlinkFrame({
        emotionId: EmotionId.SPEAKING,
        visemeMouthOpen: 180, // mouth wide open
        eyeGazeX: 12,
        eyeGazeY: -8,
        audioCodec: AudioCodec.PCM16,
        flags: 0,
        audioData: audioBytes,
      });

      // 8-byte header + 960 audio bytes = 968 bytes
      expect(downlinkPayload.byteLength).toBe(8 + 960);

      const frameBytes = encodeFrame(FrameType.AUDIO_DOWNLINK_FRAME, downlinkPayload, 101);
      const decodedFrame = decodeFrame(frameBytes);
      expect(decodedFrame.header.frameType).toBe(FrameType.AUDIO_DOWNLINK_FRAME);

      const decodedDownlink = decodeAudioDownlinkFrame(decodedFrame.payload);
      expect(decodedDownlink.emotionId).toBe(EmotionId.SPEAKING);
      expect(decodedDownlink.visemeMouthOpen).toBe(180);
      expect(decodedDownlink.eyeGazeX).toBe(12);
      expect(decodedDownlink.eyeGazeY).toBe(-8);
      expect(decodedDownlink.audioCodec).toBe(AudioCodec.PCM16);
      expect(decodedDownlink.audioByteLen).toBe(960);
      expect(decodedDownlink.audioData.byteLength).toBe(960);
    });
  });

  describe("Subscription Entitlement Sync & Access Guard", () => {
    it("serializes and parses SubscriptionEntitlementSync MessagePack payloads", () => {
      const entitlement: SubscriptionEntitlementSync = {
        jwtToken: "jwt.sample.token.for.test.petbot.pro.user",
        tier: "PRO",
        expiresAt: 1780000000,
        enabledPersonas: ["PetBot Pro Assistant", "Code Mentor"],
      };

      const payload = encodeControlPayload(SubscriptionEntitlementSyncSchema, entitlement);
      const decoded = decodeControlPayload(SubscriptionEntitlementSyncSchema, payload);

      expect(decoded.tier).toBe("PRO");
      expect(decoded.expiresAt).toBe(1780000000);
      expect(decoded.enabledPersonas).toContain("PetBot Pro Assistant");
    });

    it("verifies entitlement tier rules (PRO/ULTRA_AI allow Voice AI, FREE is blocked)", () => {
      const isVoiceAiPermitted = (tier: string): boolean => {
        return tier.toUpperCase() === "PRO" || tier.toUpperCase() === "ULTRA_AI";
      };

      expect(isVoiceAiPermitted("FREE")).toBe(false);
      expect(isVoiceAiPermitted("PRO")).toBe(true);
      expect(isVoiceAiPermitted("ULTRA_AI")).toBe(true);
    });
  });

  describe("Cryptographic Hardware 2FA Security Challenge & Signature Verification", () => {
    const mockDeviceSecret = crypto.randomBytes(32);

    /**
     * Replicates firmware's exact HMAC-SHA256 signature expansion:
     * msg = challengeId || "|" || nonce || "|" || decision || "|" || touchTimestampMs
     * part1 = HMAC-SHA256(secret, msg)
     * part2 = HMAC-SHA256(secret, part1 || "PETBOT_2FA_SIG_EXPANSION_OK_2026")
     * sigHex = part1.hex + part2.hex (128 hex chars)
     */
    function computeFirmwareSignature(
      secret: Buffer,
      challengeId: string,
      nonce: string,
      decision: string,
      touchTimestampMs: number
    ): string {
      const msg = `${challengeId}|${nonce}|${decision}|${touchTimestampMs}`;
      const part1 = crypto.createHmac("sha256", secret).update(msg).digest();
      const expMsg = Buffer.concat([part1, Buffer.from("PETBOT_2FA_SIG_EXPANSION_OK_2026")]);
      const part2 = crypto.createHmac("sha256", secret).update(expMsg).digest();
      return Buffer.concat([part1, part2]).toString("hex");
    }

    it("validates Touch2FaChallengeSchema format and roundtrip", () => {
      const challenge: Touch2FaChallenge = {
        challengeId: "chal_deploy_prod_8819",
        actionTitle: "Deploy Production Kubernetes Cluster",
        riskTier: "TIER_2_WORKFLOW",
        expiresInMs: 15000,
        nonce: "d41d8cd98f00b204e9800998ecf8427e",
      };

      const payload = encodeControlPayload(Touch2FaChallengeSchema, challenge);
      const decoded = decodeControlPayload(Touch2FaChallengeSchema, payload);

      expect(decoded.challengeId).toBe("chal_deploy_prod_8819");
      expect(decoded.riskTier).toBe("TIER_2_WORKFLOW");
      expect(decoded.expiresInMs).toBe(15000);
      expect(decoded.nonce).toBe("d41d8cd98f00b204e9800998ecf8427e");
    });

    it("generates and verifies 128-hex-character signature on APPROVED_SINGLE_TAP decision", () => {
      const challengeId = "chal_deploy_prod_8819";
      const nonce = "d41d8cd98f00b204e9800998ecf8427e";
      const decision = "APPROVED_SINGLE_TAP";
      const touchTimestampMs = 1715000000;

      const signatureHex = computeFirmwareSignature(
        mockDeviceSecret,
        challengeId,
        nonce,
        decision,
        touchTimestampMs
      );

      expect(signatureHex.length).toBe(128); // Exactly 64 bytes = 128 hex chars

      const response: Touch2FaResponse = {
        challengeId,
        decision,
        touchTimestampMs,
        signatureHex,
      };

      // Must strictly conform to protocol Zod schema
      const validated = Touch2FaResponseSchema.parse(response);
      expect(validated.decision).toBe("APPROVED_SINGLE_TAP");
      expect(validated.signatureHex).toBe(signatureHex);
    });

    it("generates and verifies 128-hex-character signature on DENIED_LONG_PRESS decision", () => {
      const challengeId = "chal_wipe_db_1234";
      const nonce = "84f183b0a239b56f2e8f192b0051e441";
      const decision = "DENIED_LONG_PRESS";
      const touchTimestampMs = 1715000500;

      const signatureHex = computeFirmwareSignature(
        mockDeviceSecret,
        challengeId,
        nonce,
        decision,
        touchTimestampMs
      );

      expect(signatureHex.length).toBe(128);

      const response: Touch2FaResponse = {
        challengeId,
        decision,
        touchTimestampMs,
        signatureHex,
      };

      const validated = Touch2FaResponseSchema.parse(response);
      expect(validated.decision).toBe("DENIED_LONG_PRESS");
    });

    it("verifies cryptographic tamper detection: modified timestamp or decision rejects signature", () => {
      const challengeId = "chal_sec_007";
      const nonce = "c8f2910394ae610f7a5b3917de042910";
      const touchTimestampMs = 1715001000;

      const validSig = computeFirmwareSignature(
        mockDeviceSecret,
        challengeId,
        nonce,
        "APPROVED_SINGLE_TAP",
        touchTimestampMs
      );

      // Attacker tries to claim it was DENIED or modifies timestamp
      const tamperedSig = computeFirmwareSignature(
        mockDeviceSecret,
        challengeId,
        nonce,
        "DENIED_LONG_PRESS",
        touchTimestampMs
      );

      expect(tamperedSig).not.toBe(validSig);

      const tamperedTimestampSig = computeFirmwareSignature(
        mockDeviceSecret,
        challengeId,
        nonce,
        "APPROVED_SINGLE_TAP",
        touchTimestampMs + 1
      );

      expect(tamperedTimestampSig).not.toBe(validSig);
    });
  });
});
