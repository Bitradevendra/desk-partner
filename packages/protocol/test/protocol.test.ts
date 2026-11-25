import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  FRAME_MAGIC,
  FRAME_VERSION,
  FRAME_HEADER_SIZE,
  FRAME_TRAILER_SIZE,
  FRAME_OVERHEAD_SIZE,
  FLAG_NONE,
  FLAG_ACK_REQUIRED,
  FLAG_FINAL_CHUNK,
  FLAG_PRIORITY_REALTIME,
  FrameType,
  FrameFlags,
  RobotMode,
  EmotionId,
  RiskTier,
  Touch2FADecision,
  AudioCodec,
  crc32,
  encodeFrame,
  decodeFrame,
  AUDIO_DOWNLINK_HEADER_SIZE,
  AUDIO_UPLINK_HEADER_SIZE,
  SD_CHUNK_HEADER_SIZE,
  OTA_CHUNK_HEADER_SIZE,
  OTA_ACK_PAYLOAD_SIZE,
  BLE_BEACON_PAYLOAD_SIZE,
  encodeAudioDownlinkFrame,
  decodeAudioDownlinkFrame,
  encodeAudioUplinkFrame,
  decodeAudioUplinkFrame,
  encodeSdVaultChunk,
  decodeSdVaultChunk,
  encodeSdVaultAck,
  decodeSdVaultAck,
  SdVaultStatus,
  encodeOtaUpdateChunk,
  decodeOtaUpdateChunk,
  encodeOtaUpdateAck,
  decodeOtaUpdateAck,
  OtaAckStatus,
  encodeControlPayload,
  decodeControlPayload,
  HelloHandshakeSchema,
  ModeTransitionSchema,
  SdVaultStartSchema,
  OtaUpdateStartSchema,
  OtaUpdateAckSchema,
  Touch2FaChallengeSchema,
  Touch2FaResponseSchema,
  HarnessRpcReqSchema,
  HarnessRpcResSchema,
  SubscriptionEntitlementSyncSchema,
  encodeBleAdvBeacon,
  decodeBleAdvBeacon,
  encodeBleAdvBeaconPayload,
  decodeBleAdvBeaconPayload,
  extractIpAndPortFromBeaconPayload,
  BLE_BEACON_SIZE_BYTES,
  BLE_BEACON_MAGIC,
  FrameStreamParser,
} from "../src/index.js";

describe("IEEE 802.3 CRC32 Implementation", () => {
  it("calculates exact standard test vectors", () => {
    // Standard test vector: "123456789" ASCII -> 0xCBF43926
    const testVector = new TextEncoder().encode("123456789");
    const checksum = crc32(testVector);
    expect(checksum).toBe(0xcbf43926);

    // Empty buffer CRC32 -> 0x00000000
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
  });
});

describe("Wire Layout & Little-Endian Alignment Specifications", () => {
  it("verifies PetBotFrameHeader exact 12-byte Little-Endian alignment", () => {
    const rawPayload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const seqId = 0x1234;
    const flags = FrameFlags.AckRequired | FrameFlags.PriorityRealtime;

    const frame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, rawPayload, seqId, flags);

    // Total length: 12 (header) + 4 (payload) + 4 (crc32) = 20 bytes
    expect(frame.byteLength).toBe(12 + 4 + 4);

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

    // Byte 0..1: Magic (0x4250 -> 'P','B')
    expect(view.getUint16(0, true)).toBe(0x4250);
    expect(frame[0]).toBe(0x50); // 'P'
    expect(frame[1]).toBe(0x42); // 'B'

    // Byte 2: Version 0x01
    expect(view.getUint8(2)).toBe(0x01);

    // Byte 3: FrameType (0x10)
    expect(view.getUint8(3)).toBe(FrameType.AUDIO_UPLINK_FRAME);

    // Byte 4: Flags (0x01 | 0x10 = 0x11)
    expect(view.getUint8(4)).toBe(flags);

    // Byte 5: Reserved (0x00)
    expect(view.getUint8(5)).toBe(0x00);

    // Byte 6..7: Sequence ID (0x1234 -> 0x34, 0x12 in Little-Endian)
    expect(view.getUint16(6, true)).toBe(0x1234);
    expect(frame[6]).toBe(0x34);
    expect(frame[7]).toBe(0x12);

    // Byte 8..11: Payload Length (4 -> 0x04, 0x00, 0x00, 0x00 in Little-Endian)
    expect(view.getUint32(8, true)).toBe(4);
    expect(frame[8]).toBe(0x04);
    expect(frame[9]).toBe(0x00);
    expect(frame[10]).toBe(0x00);
    expect(frame[11]).toBe(0x00);
  });

  it("verifies AudioDownlinkHeader exact 8-byte Little-Endian layout", () => {
    const audioData = new Uint8Array(640);
    const downlink = encodeAudioDownlinkFrame({
      emotionId: EmotionId.HAPPY,
      visemeMouthOpen: 215,
      eyeGazeX: -40,
      eyeGazeY: 55,
      audioCodec: AudioCodec.PCM16,
      flags: 0x02,
      audioByteLen: 640,
      audioData,
    });

    expect(AUDIO_DOWNLINK_HEADER_SIZE).toBe(8);
    expect(downlink.byteLength).toBe(8 + 640);

    const view = new DataView(downlink.buffer, downlink.byteOffset, 8);
    expect(view.getUint8(0)).toBe(EmotionId.HAPPY); // 0x01
    expect(view.getUint8(1)).toBe(215);
    expect(view.getInt8(2)).toBe(-40);
    expect(view.getInt8(3)).toBe(55);
    expect(view.getUint8(4)).toBe(AudioCodec.PCM16); // 0x00
    expect(view.getUint8(5)).toBe(0x02);
    expect(view.getUint16(6, true)).toBe(640); // 0x0280 -> 0x80, 0x02
    expect(downlink[6]).toBe(0x80);
    expect(downlink[7]).toBe(0x02);

    const decoded = decodeAudioDownlinkFrame(downlink);
    expect(decoded.header.emotionId).toBe(EmotionId.HAPPY);
    expect(decoded.header.visemeMouthOpen).toBe(215);
    expect(decoded.header.eyeGazeX).toBe(-40);
    expect(decoded.header.eyeGazeY).toBe(55);
    expect(decoded.header.audioCodec).toBe(AudioCodec.PCM16);
    expect(decoded.header.flags).toBe(0x02);
    expect(decoded.header.audioByteLen).toBe(640);
  });

  it("verifies SdVaultChunkHeader exact 12-byte Little-Endian layout", () => {
    const rawBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const chunk = encodeSdVaultChunk({
      transferId: 0x12345678,
      chunkIndex: 0x00000003,
      chunkCrc32: 0xaabbccdd,
      rawBytes,
    });

    expect(SD_CHUNK_HEADER_SIZE).toBe(12);
    expect(chunk.byteLength).toBe(12 + 4);

    const view = new DataView(chunk.buffer, chunk.byteOffset, 12);
    expect(view.getUint32(0, true)).toBe(0x12345678);
    expect(chunk[0]).toBe(0x78);
    expect(chunk[1]).toBe(0x56);
    expect(chunk[2]).toBe(0x34);
    expect(chunk[3]).toBe(0x12);

    expect(view.getUint32(4, true)).toBe(0x00000003);
    expect(chunk[4]).toBe(0x03);

    expect(view.getUint32(8, true)).toBe(0xaabbccdd);
    expect(chunk[8]).toBe(0xdd);
    expect(chunk[9]).toBe(0xcc);
    expect(chunk[10]).toBe(0xbb);
    expect(chunk[11]).toBe(0xaa);

    const decoded = decodeSdVaultChunk(chunk);
    expect(decoded.header.transferId).toBe(0x12345678);
    expect(decoded.header.chunkIndex).toBe(3);
    expect(decoded.header.chunkCrc32).toBe(0xaabbccdd);
  });

  it("verifies BleAdvBeaconPayload exact 16-byte Little-Endian layout", () => {
    const ipv4 = new Uint8Array([192, 168, 1, 77]);
    const beaconPayload = encodeBleAdvBeaconPayload({
      magic: 0x4250,
      deviceIdHash: 0x87654321,
      mode: RobotMode.AGENTIC_CONNECTED,
      batteryPct: 92,
      ipv4,
      wsPort: 8443,
      flags: 0x0007,
    });

    expect(BLE_BEACON_PAYLOAD_SIZE).toBe(16);
    expect(beaconPayload.byteLength).toBe(16);

    const view = new DataView(beaconPayload.buffer, beaconPayload.byteOffset, 16);
    expect(view.getUint16(0, true)).toBe(0x4250);
    expect(view.getUint32(2, true)).toBe(0x87654321);
    expect(view.getUint8(6)).toBe(RobotMode.AGENTIC_CONNECTED);
    expect(view.getUint8(7)).toBe(92);
    expect(beaconPayload[8]).toBe(192);
    expect(beaconPayload[9]).toBe(168);
    expect(beaconPayload[10]).toBe(1);
    expect(beaconPayload[11]).toBe(77);
    expect(view.getUint16(12, true)).toBe(8443);
    expect(view.getUint16(14, true)).toBe(0x0007);

    const decoded = decodeBleAdvBeaconPayload(beaconPayload);
    expect(decoded.deviceIdHash).toBe(0x87654321);
    expect(decoded.mode).toBe(RobotMode.AGENTIC_CONNECTED);
    expect(decoded.batteryPct).toBe(92);
    expect(decoded.wsPort).toBe(8443);
  });
});

describe("Real-time Audio Downlink Benchmark & Keyframe Synchronization", () => {
  it("roundtrips AUDIO_DOWNLINK_FRAME with 640B PCM + HAPPY emotion in under 0.05ms", () => {
    const pcmAudio = new Uint8Array(640);
    for (let i = 0; i < pcmAudio.length; i++) {
      pcmAudio[i] = (i * 3) & 0xff;
    }

    const downlinkParams = {
      emotionId: EmotionId.HAPPY,
      visemeMouthOpen: 220,
      eyeGazeX: -15,
      eyeGazeY: 30,
      audioCodec: AudioCodec.PCM16,
      flags: 0,
      audioByteLen: 640,
      audioData: pcmAudio,
    };

    // Warm-up JIT
    for (let i = 0; i < 500; i++) {
      const payload = encodeAudioDownlinkFrame(downlinkParams);
      const frame = encodeFrame(FrameType.AUDIO_DOWNLINK_FRAME, payload, i, FLAG_PRIORITY_REALTIME);
      const decodedFrame = decodeFrame(frame);
      const decodedDownlink = decodeAudioDownlinkFrame(decodedFrame.payload);
      if (decodedDownlink.emotionId !== EmotionId.HAPPY) {
        throw new Error("Sanity check failed");
      }
    }

    // Benchmark measurement
    const iterations = 2000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const payload = encodeAudioDownlinkFrame(downlinkParams);
      const frame = encodeFrame(FrameType.AUDIO_DOWNLINK_FRAME, payload, i, FLAG_PRIORITY_REALTIME);
      const decodedFrame = decodeFrame(frame);
      const decodedDownlink = decodeAudioDownlinkFrame(decodedFrame.payload);
      // Access fields
      if (decodedDownlink.audioData.byteLength !== 640) {
        throw new Error("Benchmark verification failed");
      }
    }

    const elapsedMs = performance.now() - start;
    const avgMs = elapsedMs / iterations;

    console.log(
      `[Benchmark] Audio Downlink Round-trip: ${avgMs.toFixed(4)} ms/op (${iterations} iterations in ${elapsedMs.toFixed(2)} ms)`
    );

    // Must be well under 0.05ms (50 microseconds)
    expect(avgMs).toBeLessThan(0.05);
  });
});

describe("SD Vault Chunked Transfer Simulation & Fragmentation Handling", () => {
  it("splits 64KB buffer into 16KB chunks, streams through fragmented parser, and reassembles with 100% SHA-256 match", () => {
    // 1. Generate 64KB deterministic payload
    const totalSize = 65536; // 64 KiB
    const originalBuffer = new Uint8Array(totalSize);
    for (let i = 0; i < totalSize; i++) {
      originalBuffer[i] = ((i * 31) ^ (i >> 8)) & 0xff;
    }

    const expectedSha256 = crypto
      .createHash("sha256")
      .update(originalBuffer)
      .digest("hex");

    // 2. Chunk into 16KB chunks
    const chunkSize = 16384; // 16 KiB
    const totalChunks = totalSize / chunkSize;
    expect(totalChunks).toBe(4);

    const encodedFrames: Uint8Array[] = [];
    const transferId = 0xcafe1234;

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const chunkData = originalBuffer.subarray(
        chunkIdx * chunkSize,
        (chunkIdx + 1) * chunkSize
      );
      const chunkCrc = crc32(chunkData);

      const packedChunk = encodeSdVaultChunk({
        transferId,
        chunkIndex: chunkIdx,
        chunkCrc32: chunkCrc,
        rawBytes: chunkData,
      });

      const flags = chunkIdx === totalChunks - 1 ? FLAG_FINAL_CHUNK : FLAG_NONE;
      const frame = encodeFrame(FrameType.SD_VAULT_CHUNK, packedChunk, chunkIdx + 1, flags);
      encodedFrames.push(frame);
    }

    // 3. Concatenate all encoded frames into a single continuous byte stream
    const totalWireBytes = encodedFrames.reduce((acc, f) => acc + f.byteLength, 0);
    const wireStream = new Uint8Array(totalWireBytes);
    let wireOffset = 0;
    for (const frame of encodedFrames) {
      wireStream.set(frame, wireOffset);
      wireOffset += frame.byteLength;
    }

    // 4. Fragment the stream into small irregular chunks to simulate TCP / BLE packet fragmentation
    const fragments: Uint8Array[] = [];
    const fragmentSizes = [17, 71, 253, 11, 512, 1024, 89, 4096, 33];
    let streamReadOffset = 0;
    let sizeIdx = 0;

    while (streamReadOffset < wireStream.byteLength) {
      const sliceSize = Math.min(
        fragmentSizes[sizeIdx % fragmentSizes.length]!,
        wireStream.byteLength - streamReadOffset
      );
      fragments.push(wireStream.subarray(streamReadOffset, streamReadOffset + sliceSize));
      streamReadOffset += sliceSize;
      sizeIdx++;
    }

    // 5. Ingest fragments into FrameStreamParser
    const parser = new FrameStreamParser();
    const receivedFrames: ReturnType<typeof parser.push> = [];

    for (const frag of fragments) {
      const frames = parser.push(frag);
      receivedFrames.push(...frames);
    }

    expect(receivedFrames.length).toBe(4);
    expect(parser.bufferedBytes).toBe(0);

    // 6. Verify each chunk's CRC32 and reassemble the 64KB file
    const reassembled = new Uint8Array(totalSize);

    for (let i = 0; i < receivedFrames.length; i++) {
      const decodedFrame = receivedFrames[i]!;
      expect(decodedFrame.header.frameType).toBe(FrameType.SD_VAULT_CHUNK);
      expect(decodedFrame.header.seqId).toBe(i + 1);

      const chunk = decodeSdVaultChunk(decodedFrame.payload);
      expect(chunk.transferId).toBe(transferId);
      expect(chunk.chunkIndex).toBe(i);

      // Verify CRC32 of individual chunk
      const computedChunkCrc = crc32(chunk.rawBytes);
      expect(chunk.chunkCrc32).toBe(computedChunkCrc);

      // Place into reassembly buffer
      reassembled.set(chunk.rawBytes, i * chunkSize);
    }

    // 7. Verify 100% SHA-256 match
    const actualSha256 = crypto
      .createHash("sha256")
      .update(reassembled)
      .digest("hex");

    expect(actualSha256).toBe(expectedSha256);
  });
});

describe("FrameStreamParser Fault-Tolerance & Auto-Recovery", () => {
  it("hunts past garbage bytes, recovers from corrupted CRC, and emits subsequent valid frames intact", () => {
    const parser = new FrameStreamParser();
    const errors: Error[] = [];
    parser.onError((err) => errors.push(err));

    const validPayload1 = new Uint8Array([0x10, 0x20, 0x30]);
    const validFrame1 = encodeFrame(FrameType.HEARTBEAT_PING, validPayload1, 10);

    const validPayload2 = new Uint8Array([0x40, 0x50, 0x60, 0x70]);
    const validFrame2 = encodeFrame(FrameType.HEARTBEAT_PONG, validPayload2, 11);

    // Corrupted frame with tampered CRC32
    const badFrame = new Uint8Array(encodeFrame(FrameType.HARNESS_RPC_REQ, new Uint8Array([1, 2, 3]), 99));
    badFrame[badFrame.byteLength - 1] = (badFrame[badFrame.byteLength - 1]! ^ 0xff); // Invalidate CRC

    // Stream composition: [garbage 15 bytes] + [validFrame1] + [badFrame] + [garbage 5 bytes] + [validFrame2]
    const garbage1 = new Uint8Array([0x00, 0xff, 0x42, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
    const garbage2 = new Uint8Array([0x99, 0x88, 0x77, 0x66, 0x55]);

    const mixedStream = new Uint8Array(
      garbage1.byteLength +
      validFrame1.byteLength +
      badFrame.byteLength +
      garbage2.byteLength +
      validFrame2.byteLength
    );

    let offset = 0;
    mixedStream.set(garbage1, offset); offset += garbage1.byteLength;
    mixedStream.set(validFrame1, offset); offset += validFrame1.byteLength;
    mixedStream.set(badFrame, offset); offset += badFrame.byteLength;
    mixedStream.set(garbage2, offset); offset += garbage2.byteLength;
    mixedStream.set(validFrame2, offset); offset += validFrame2.byteLength;

    // Push in irregular 13-byte fragments
    const emitted: ReturnType<typeof parser.push> = [];
    for (let i = 0; i < mixedStream.byteLength; i += 13) {
      const slice = mixedStream.subarray(i, Math.min(i + 13, mixedStream.byteLength));
      emitted.push(...parser.push(slice));
    }

    expect(emitted.length).toBe(2);
    expect(emitted[0]!.header.seqId).toBe(10);
    expect(emitted[0]!.payload).toEqual(validPayload1);
    expect(emitted[1]!.header.seqId).toBe(11);
    expect(emitted[1]!.payload).toEqual(validPayload2);

    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Hardware Touch 2FA Challenge & Response Packets", () => {
  it("roundtrips TOUCH_2FA_CHALLENGE and TOUCH_2FA_RESPONSE MessagePack packets", () => {
    const challenge = {
      challengeId: "challenge-sudo-4421",
      actionTitle: "Authorize Root Deployment to Production",
      riskTier: "TIER_3_2FA_REQUIRED" as const,
      expiresInMs: 15000,
      nonce: "d8dec8e7d0eb46908e1c458458bde60f",
    };

    const encodedChallengePayload = encodeControlPayload(Touch2FaChallengeSchema, challenge);
    const challengeFrame = encodeFrame(
      FrameType.TOUCH_2FA_CHALLENGE,
      encodedChallengePayload,
      101,
      FLAG_ACK_REQUIRED | FLAG_PRIORITY_REALTIME
    );

    const decodedChallengeFrame = decodeFrame(challengeFrame);
    expect(decodedChallengeFrame.header.frameType).toBe(FrameType.TOUCH_2FA_CHALLENGE);
    expect(decodedChallengeFrame.header.seqId).toBe(101);

    const decodedChallenge = decodeControlPayload(
      Touch2FaChallengeSchema,
      decodedChallengeFrame.payload
    );
    expect(decodedChallenge).toEqual(challenge);

    // Response packet
    const dummySignature = "ab".repeat(64); // 64-byte Ed25519 signature in hex
    const response = {
      challengeId: "challenge-sudo-4421",
      decision: "APPROVED_SINGLE_TAP" as const,
      touchTimestampMs: 1731668800000,
      signatureHex: dummySignature,
    };

    const encodedResponsePayload = encodeControlPayload(Touch2FaResponseSchema, response);
    const responseFrame = encodeFrame(
      FrameType.TOUCH_2FA_RESPONSE,
      encodedResponsePayload,
      102,
      FLAG_PRIORITY_REALTIME
    );

    const decodedResponseFrame = decodeFrame(responseFrame);
    expect(decodedResponseFrame.header.frameType).toBe(FrameType.TOUCH_2FA_RESPONSE);
    expect(decodedResponseFrame.header.seqId).toBe(102);

    const decodedResponse = decodeControlPayload(
      Touch2FaResponseSchema,
      decodedResponseFrame.payload
    );
    expect(decodedResponse).toEqual(response);
  });
});

describe("BLE Advertising Beacon Instantaneous IP & Port Extraction", () => {
  it("extracts IPv4 address and WebSocket port directly from 16-byte beacon payload in sub-microsecond time", () => {
    const payload = encodeBleAdvBeaconPayload({
      magic: 0x4250,
      deviceIdHash: 0xa1b2c3d4,
      mode: RobotMode.AGENTIC_CONNECTED,
      batteryPct: 87,
      ipv4: new Uint8Array([192, 168, 4, 1]),
      wsPort: 8443,
      flags: 0x0001,
    });

    // Warm-up
    for (let i = 0; i < 1000; i++) {
      const res = extractIpAndPortFromBeaconPayload(payload);
      if (res.port !== 8443) throw new Error("Sanity check failed");
    }

    // Benchmark extraction speed
    const iters = 10000;
    const start = performance.now();
    for (let i = 0; i < iters; i++) {
      const extracted = extractIpAndPortFromBeaconPayload(payload);
      if (extracted.port !== 8443) throw new Error("Sanity check failed");
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / iters;

    console.log(
      `[Benchmark] BLE Beacon IP+Port extraction: ${(avgMs * 1000).toFixed(2)} µs/op (${iters} iterations in ${elapsed.toFixed(2)} ms)`
    );

    const result = extractIpAndPortFromBeaconPayload(payload);
    expect(result.ip).toBe("192.168.4.1");
    expect(result.port).toBe(8443);
    expect(avgMs).toBeLessThan(0.005); // Less than 5 microseconds
  });
});

describe("Comprehensive Protocol Control Plane & BleAdvBeacon Backward Compatibility", () => {
  it("serializes and deserializes HELLO_HANDSHAKE payload", () => {
    const handshake = {
      deviceId: "petbot-esp32s3-7fa4",
      firmwareVersion: "1.2.0-prod",
      psramFreeBytes: 8192000,
      sdCardCapacityBytes: 32000000000,
      sdCardFreeBytes: 28500000000,
      ed25519PublicKeyHex: "e04135e679c67784f183063f6fb87e2de1247d6928e1b6ff0355ba4ca2b027d1",
      capabilities: ["AUDIO_I2S", "TFT_RGB565", "OCTAL_PSRAM", "BLE_GATT"],
    };

    const encoded = encodeControlPayload(HelloHandshakeSchema, handshake);
    const decoded = decodeControlPayload(HelloHandshakeSchema, encoded);
    expect(decoded).toEqual(handshake);
  });

  it("serializes and deserializes MODE_TRANSITION payload", () => {
    const transition = {
      targetMode: RobotMode.AGENTIC_CONNECTED,
      companionHost: "192.168.1.150",
      companionPort: 8443,
      transitionReason: "Companion App connected via Wi-Fi",
    };

    const encoded = encodeControlPayload(ModeTransitionSchema, transition);
    const decoded = decodeControlPayload(ModeTransitionSchema, encoded);
    expect(decoded).toEqual(transition);
  });

  it("encodes and decodes 24-byte BleAdvBeacon", () => {
    const beacon = {
      modeState: RobotMode.AGENTIC_CONNECTED,
      batteryPercent: 88,
      flags: {
        wifiConnected: true,
        isCharging: false,
        hasSdCard: true,
        requires2Fa: false,
      },
      deviceId: "PETBOT01",
      ipv4Address: "192.168.1.120",
      wsPort: 8443,
    };

    const raw = encodeBleAdvBeacon(beacon);
    expect(raw.byteLength).toBe(BLE_BEACON_SIZE_BYTES);

    const decoded = decodeBleAdvBeacon(raw);
    expect(decoded.modeState).toBe(RobotMode.AGENTIC_CONNECTED);
    expect(decoded.batteryPercent).toBe(88);
    expect(decoded.ipv4Address).toBe("192.168.1.120");
    expect(decoded.wsPort).toBe(8443);
  });

  describe("Signed Over-The-Air (OTA) Dual-Partition Protocol Codecs", () => {
    it("roundtrips OTA_UPDATE_START with SemVer version, 64-char sha256 and 128-char Ed25519 signature", () => {
      const otaStart = {
        version: "2.6.0-release",
        totalBytes: 1572864, // 1.5MB firmware binary
        totalChunks: 96,
        sha256Hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ed25519SignatureHex: "a".repeat(128),
      };

      const payload = encodeControlPayload(OtaUpdateStartSchema, otaStart);
      const frame = encodeFrame(FrameType.OTA_UPDATE_START, payload, 101);
      const decodedFrame = decodeFrame(frame);

      expect(decodedFrame.header.frameType).toBe(FrameType.OTA_UPDATE_START);
      expect(decodedFrame.header.seqId).toBe(101);

      const unpacked = decodeControlPayload(OtaUpdateStartSchema, decodedFrame.payload);
      expect(unpacked.version).toBe("2.6.0-release");
      expect(unpacked.totalBytes).toBe(1572864);
      expect(unpacked.totalChunks).toBe(96);
      expect(unpacked.sha256Hex).toBe(otaStart.sha256Hex);
      expect(unpacked.ed25519SignatureHex).toBe(otaStart.ed25519SignatureHex);
    });

    it("encodes and decodes 16KB OTA_UPDATE_CHUNK with 12-byte header and verified CRC32", () => {
      const firmwareChunkBytes = new Uint8Array(16384);
      for (let i = 0; i < firmwareChunkBytes.length; i++) {
        firmwareChunkBytes[i] = (i * 31 + 7) & 0xff;
      }
      const expectedCrc = crc32(firmwareChunkBytes);

      const chunkPayload = encodeOtaUpdateChunk({
        transferId: 778899,
        chunkIndex: 14,
        chunkCrc32: expectedCrc,
        rawBytes: firmwareChunkBytes,
      });

      expect(chunkPayload.byteLength).toBe(OTA_CHUNK_HEADER_SIZE + 16384);

      const decoded = decodeOtaUpdateChunk(chunkPayload);
      expect(decoded.transferId).toBe(778899);
      expect(decoded.chunkIndex).toBe(14);
      expect(decoded.chunkCrc32).toBe(expectedCrc);
      expect(decoded.rawBytes.byteLength).toBe(16384);
      expect(crc32(decoded.rawBytes)).toBe(expectedCrc);
    });

    it("encodes and decodes 10-byte packed binary OTA_UPDATE_ACK", () => {
      const ackPayload = encodeOtaUpdateAck({
        transferId: 778899,
        nextExpectedChunk: 15,
        progressPct: 15,
        status: OtaAckStatus.OK,
      });

      expect(ackPayload.byteLength).toBe(OTA_ACK_PAYLOAD_SIZE);

      const decoded = decodeOtaUpdateAck(ackPayload);
      expect(decoded.transferId).toBe(778899);
      expect(decoded.nextExpectedChunk).toBe(15);
      expect(decoded.progressPct).toBe(15);
      expect(decoded.status).toBe(OtaAckStatus.OK);

      // Verify REBOOTING_INTO_NEW_FIRMWARE status
      const rebootAck = encodeOtaUpdateAck({
        transferId: 778899,
        nextExpectedChunk: 96,
        progressPct: 100,
        status: OtaAckStatus.REBOOTING_INTO_NEW_FIRMWARE,
      });
      const decodedReboot = decodeOtaUpdateAck(rebootAck);
      expect(decodedReboot.progressPct).toBe(100);
      expect(decodedReboot.status).toBe(OtaAckStatus.REBOOTING_INTO_NEW_FIRMWARE);
    });
  });
});
