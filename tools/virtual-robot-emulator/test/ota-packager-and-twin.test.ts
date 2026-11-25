import { describe, it, expect, beforeEach } from "vitest";
import * as crypto from "node:crypto";
import {
  FrameType,
  OtaAckStatus,
  FLAG_FINAL_CHUNK,
  crc32,
  encodeFrame,
  decodeFrame,
  encodeControlPayload,
  encodeOtaUpdateChunk,
  decodeOtaUpdateAck,
  OtaUpdateStartSchema,
  OTA_CHUNK_SIZE_BYTES,
} from "@petbot/protocol";
import {
  generateOtaSigningKeyPair,
  createSignedOtaBundle,
  verifySignedOtaBundle,
  serializeOtaBundle,
  deserializeOtaBundle,
  VirtualEsp32S3Robot,
} from "../src/index.js";

describe("Signed Over-The-Air (OTA) Packager & Verification", () => {
  it("generates cryptographic Ed25519 signing keypair", () => {
    const keys = generateOtaSigningKeyPair();
    expect(keys.publicKeyPem).toContain("-----BEGIN PUBLIC KEY-----");
    expect(keys.privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(keys.publicKeyHex).toHaveLength(64);
    expect(keys.privateKeyHex).toHaveLength(64);
  });

  it("creates a signed OTA bundle with SHA-256 and Ed25519 digital signature", () => {
    const keys = generateOtaSigningKeyPair();
    const testFirmware = new Uint8Array(49152); // Exactly 3 chunks (3 x 16384)
    for (let i = 0; i < testFirmware.length; i++) {
      testFirmware[i] = (i * 17 + 3) & 0xff;
    }

    const bundle = createSignedOtaBundle(testFirmware, "2.6.0-gold", keys.privateKeyPem);

    expect(bundle.manifest.version).toBe("2.6.0-gold");
    expect(bundle.manifest.totalBytes).toBe(49152);
    expect(bundle.manifest.chunkSize).toBe(OTA_CHUNK_SIZE_BYTES);
    expect(bundle.manifest.totalChunks).toBe(3);
    expect(bundle.manifest.sha256Hex).toHaveLength(64);
    expect(bundle.manifest.ed25519SignatureHex).toHaveLength(128);

    const verification = verifySignedOtaBundle(bundle, keys.publicKeyPem);
    expect(verification.valid).toBe(true);
    expect(verification.error).toBeUndefined();
  });

  it("rejects tampered firmware binaries during bundle verification", () => {
    const keys = generateOtaSigningKeyPair();
    const testFirmware = new Uint8Array(16384);
    testFirmware.fill(0x5a);

    const bundle = createSignedOtaBundle(testFirmware, "2.6.0", keys.privateKeyPem);

    // Tamper with a single byte in the binary
    bundle.firmwareBin[100] = 0x5b;

    const verification = verifySignedOtaBundle(bundle, keys.publicKeyPem);
    expect(verification.valid).toBe(false);
    expect(verification.error).toContain("SHA-256 mismatch");
  });

  it("rejects invalid Ed25519 signatures or mismatched public keys", () => {
    const keyPair1 = generateOtaSigningKeyPair();
    const keyPair2 = generateOtaSigningKeyPair();
    const testFirmware = new Uint8Array(8192);

    const bundle = createSignedOtaBundle(testFirmware, "2.6.0", keyPair1.privateKeyPem);

    // Verify with keyPair2 public key (different authority)
    const verification = verifySignedOtaBundle(bundle, keyPair2.publicKeyPem);
    expect(verification.valid).toBe(false);
    expect(verification.error).toContain("signature verification failed");
  });

  it("serializes and deserializes .pbota binary container format losslessly", () => {
    const keys = generateOtaSigningKeyPair();
    const testFirmware = new Uint8Array(32768);
    crypto.getRandomValues(testFirmware);

    const bundle = createSignedOtaBundle(testFirmware, "2.7.1-patch", keys.privateKeyPem);
    const serialized = serializeOtaBundle(bundle);

    expect(serialized.byteLength).toBeGreaterThan(32768 + 12);

    const restored = deserializeOtaBundle(serialized);
    expect(restored.manifest.version).toBe("2.7.1-patch");
    expect(restored.manifest.sha256Hex).toBe(bundle.manifest.sha256Hex);
    expect(restored.manifest.ed25519SignatureHex).toBe(bundle.manifest.ed25519SignatureHex);
    expect(restored.firmwareBin.byteLength).toBe(testFirmware.byteLength);
    expect(Buffer.from(restored.firmwareBin).equals(Buffer.from(testFirmware))).toBe(true);
  });
});

describe("VirtualEsp32S3Robot Dual-Partition OTA Execution", () => {
  let robot: VirtualEsp32S3Robot;
  let otaAuthorityKeys: ReturnType<typeof generateOtaSigningKeyPair>;
  let outboundFrames: Uint8Array[] = [];
  let triggeredSounds: string[] = [];
  let logMessages: string[] = [];

  beforeEach(() => {
    otaAuthorityKeys = generateOtaSigningKeyPair();
    outboundFrames = [];
    triggeredSounds = [];
    logMessages = [];

    robot = new VirtualEsp32S3Robot({
      deviceId: "PETBOT-OTA-SIM-01",
      firmwareVersion: "2.5.0-base",
      otaTrustedPublicKey: otaAuthorityKeys.publicKeyHex,
      onFrameOutbound: (frame) => outboundFrames.push(frame),
      onSoundTriggered: (sound) => triggeredSounds.push(sound),
      onLogMessage: (msg) => logMessages.push(msg),
    });
  });

  it("starts on partition app0 with base firmware version", () => {
    const snapshot = robot.getTelemetrySnapshot();
    expect(snapshot.firmwareVersion).toBe("2.5.0-base");
    expect(snapshot.otaRunningPartition).toBe("app0");
    expect(snapshot.isOtaUpdating).toBe(false);
    expect(snapshot.otaProgressPct).toBe(0);
  });

  it("rejects OTA_UPDATE_START with invalid digital signature", () => {
    const forgedKeys = generateOtaSigningKeyPair();
    const forgedBin = new Uint8Array(16384);
    forgedBin.fill(0xcc);

    // Sign with untrusted/forged key
    const forgedBundle = createSignedOtaBundle(forgedBin, "9.9.9-malicious", forgedKeys.privateKeyPem);

    const startFrame = encodeFrame(
      FrameType.OTA_UPDATE_START,
      encodeControlPayload(OtaUpdateStartSchema, {
        version: forgedBundle.manifest.version,
        totalBytes: forgedBundle.manifest.totalBytes,
        totalChunks: forgedBundle.manifest.totalChunks,
        sha256Hex: forgedBundle.manifest.sha256Hex,
        ed25519SignatureHex: forgedBundle.manifest.ed25519SignatureHex,
      }),
      10
    );

    const result = robot.handleInboundFrame(startFrame);
    expect(result.response).toBeDefined();

    const decodedAckFrame = decodeFrame(result.response!);
    expect(decodedAckFrame.header.frameType).toBe(FrameType.OTA_UPDATE_ACK);

    const ack = decodeOtaUpdateAck(decodedAckFrame.payload);
    expect(ack.status).toBe(OtaAckStatus.SIGNATURE_INVALID);

    // Robot state remains unchanged
    expect(robot.getTelemetrySnapshot().isOtaUpdating).toBe(false);
    expect(robot.getTelemetrySnapshot().firmwareVersion).toBe("2.5.0-base");
  });

  it("executes full dual-partition update, checks chunk CRC32, renders progress and flips to app1 on reboot", () => {
    // 1. Create a 2-chunk (32KB) firmware binary
    const newFirmwareBin = new Uint8Array(32768);
    for (let i = 0; i < newFirmwareBin.length; i++) {
      newFirmwareBin[i] = (i * 13 + 5) & 0xff;
    }

    const bundle = createSignedOtaBundle(newFirmwareBin, "2.6.0-release", otaAuthorityKeys.privateKeyPem);

    // 2. Send OTA_UPDATE_START
    const startPayload = encodeControlPayload(OtaUpdateStartSchema, {
      version: bundle.manifest.version,
      totalBytes: bundle.manifest.totalBytes,
      totalChunks: bundle.manifest.totalChunks,
      sha256Hex: bundle.manifest.sha256Hex,
      ed25519SignatureHex: bundle.manifest.ed25519SignatureHex,
    });
    const startFrame = encodeFrame(FrameType.OTA_UPDATE_START, startPayload, 20);

    outboundFrames = [];
    const startResult = robot.handleInboundFrame(startFrame);
    expect(startResult.response).toBeDefined();

    const ack1 = decodeOtaUpdateAck(decodeFrame(startResult.response!).payload);
    expect(ack1.status).toBe(OtaAckStatus.OK);
    expect(ack1.nextExpectedChunk).toBe(0);
    const transferId = ack1.transferId;

    // Check robot state during OTA
    expect(robot.getTelemetrySnapshot().isOtaUpdating).toBe(true);
    expect(robot.getTelemetrySnapshot().otaProgressPct).toBe(0);

    // 3. Send Chunk 0 with corrupt CRC32 to test retry behavior
    const chunk0Bytes = newFirmwareBin.subarray(0, 16384);
    const corruptChunkFrame = encodeFrame(
      FrameType.OTA_UPDATE_CHUNK,
      encodeOtaUpdateChunk({
        transferId,
        chunkIndex: 0,
        chunkCrc32: 0xdeadbeef, // Corrupt CRC
        rawBytes: chunk0Bytes,
      }),
      21
    );

    const retryResult = robot.handleInboundFrame(corruptChunkFrame);
    expect(retryResult.response).toBeDefined();
    const retryAck = decodeOtaUpdateAck(decodeFrame(retryResult.response!).payload);
    expect(retryAck.status).toBe(OtaAckStatus.CRC_RETRY);
    expect(retryAck.nextExpectedChunk).toBe(0);

    // 4. Retransmit Chunk 0 with valid CRC32
    const validChunk0Frame = encodeFrame(
      FrameType.OTA_UPDATE_CHUNK,
      encodeOtaUpdateChunk({
        transferId,
        chunkIndex: 0,
        chunkCrc32: crc32(chunk0Bytes),
        rawBytes: chunk0Bytes,
      }),
      22
    );

    const chunk0Result = robot.handleInboundFrame(validChunk0Frame);
    const chunk0Ack = decodeOtaUpdateAck(decodeFrame(chunk0Result.response!).payload);
    expect(chunk0Ack.status).toBe(OtaAckStatus.OK);
    expect(chunk0Ack.nextExpectedChunk).toBe(1);
    expect(chunk0Ack.progressPct).toBe(50); // 1 of 2 chunks = 50%
    expect(robot.getTelemetrySnapshot().otaProgressPct).toBe(50);

    // 5. Send Chunk 1 (Final chunk)
    const chunk1Bytes = newFirmwareBin.subarray(16384, 32768);
    const finalChunkFrame = encodeFrame(
      FrameType.OTA_UPDATE_CHUNK,
      encodeOtaUpdateChunk({
        transferId,
        chunkIndex: 1,
        chunkCrc32: crc32(chunk1Bytes),
        rawBytes: chunk1Bytes,
      }),
      23,
      FLAG_FINAL_CHUNK
    );

    const finalResult = robot.handleInboundFrame(finalChunkFrame);
    const finalAck = decodeOtaUpdateAck(decodeFrame(finalResult.response!).payload);

    expect(finalAck.status).toBe(OtaAckStatus.REBOOTING_INTO_NEW_FIRMWARE);
    expect(finalAck.progressPct).toBe(100);

    // 6. Verify reboot state & dual partition flip
    const postSnapshot = robot.getTelemetrySnapshot();
    expect(postSnapshot.firmwareVersion).toBe("2.6.0-release");
    expect(postSnapshot.otaRunningPartition).toBe("app1"); // Successfully flipped to app1!
    expect(postSnapshot.isOtaUpdating).toBe(false);
    expect(triggeredSounds).toContain("SUCCESS");
  });
});
