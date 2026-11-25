import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OtaUpdateClient,
  parsePbotaFile,
  computeSha256Hex,
  PBOTA_MAGIC,
  PBOTA_VERSION,
  type ParsedOtaBundle,
} from "../src/services/ota-update-client.js";
import { RobotConnectionManager } from "../src/services/robot-connection.js";
import {
  FrameType,
  OtaAckStatus,
  OTA_CHUNK_SIZE_BYTES,
  encodeOtaUpdateAck,
  type OtaAckPayload,
} from "@petbot/protocol";

describe("OTA Update Protocol & Serialization", () => {
  it("computes deterministic SHA-256 hex digest", async () => {
    const data = new TextEncoder().encode("PetBot Firmware Payload 2026");
    const hashHex = await computeSha256Hex(data);
    expect(hashHex).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hashHex)).toBe(true);

    // Empty buffer SHA-256
    const emptyHash = await computeSha256Hex(new Uint8Array(0));
    expect(emptyHash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("parses valid .pbota binary bundles", () => {
    const rawFirmware = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
    const manifest = {
      version: "v2.1.0",
      totalBytes: rawFirmware.byteLength,
      chunkSize: OTA_CHUNK_SIZE_BYTES,
      totalChunks: 1,
      sha256Hex: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
      ed25519SignatureHex: "ff".repeat(64),
      timestamp: Date.now(),
    };

    const manifestJson = JSON.stringify(manifest);
    const manifestBytes = new TextEncoder().encode(manifestJson);
    const headerLen = 12;
    const totalLength = headerLen + manifestBytes.byteLength + rawFirmware.byteLength;

    const bundleBytes = new Uint8Array(totalLength);
    const view = new DataView(bundleBytes.buffer);
    view.setUint32(0, PBOTA_MAGIC, false);
    view.setUint8(4, PBOTA_VERSION);
    view.setUint8(5, 0);
    view.setUint16(6, 0, true);
    view.setUint32(8, manifestBytes.byteLength, true);

    bundleBytes.set(manifestBytes, headerLen);
    bundleBytes.set(rawFirmware, headerLen + manifestBytes.byteLength);

    const parsed = parsePbotaFile(bundleBytes);
    expect(parsed.manifest.version).toBe("v2.1.0");
    expect(parsed.manifest.totalBytes).toBe(rawFirmware.byteLength);
    expect(parsed.manifest.sha256Hex).toBe(manifest.sha256Hex);
    expect(parsed.firmwareBin).toEqual(rawFirmware);
  });

  it("throws descriptive errors on corrupted .pbota files", () => {
    // Too small
    expect(() => parsePbotaFile(new Uint8Array(8))).toThrow("smaller than 12-byte header");

    // Invalid magic
    const invalidMagic = new Uint8Array(20);
    expect(() => parsePbotaFile(invalidMagic)).toThrow("Invalid .pbota magic");

    // Version mismatch
    const badVersion = new Uint8Array(20);
    const view = new DataView(badVersion.buffer);
    view.setUint32(0, PBOTA_MAGIC, false);
    view.setUint8(4, 99); // bad version
    expect(() => parsePbotaFile(badVersion)).toThrow("Unsupported .pbota container format version");

    // Truncated manifest
    const truncated = new Uint8Array(16);
    const viewTrunc = new DataView(truncated.buffer);
    viewTrunc.setUint32(0, PBOTA_MAGIC, false);
    viewTrunc.setUint8(4, PBOTA_VERSION);
    viewTrunc.setUint32(8, 1000, true); // claims 1000 bytes manifest, only 4 bytes exist
    expect(() => parsePbotaFile(truncated)).toThrow("truncated manifest segment");
  });
});

describe("OtaUpdateClient - Simulator Loopback", () => {
  let connection: RobotConnectionManager;
  let client: OtaUpdateClient;

  beforeEach(() => {
    connection = new RobotConnectionManager();
    connection.bootSimulator();
    client = new OtaUpdateClient(connection);
  });

  it("completes full firmware update cycle in simulator mode", async () => {
    const dummyFirmware = new Uint8Array(35000); // 3 chunks (16KB, 16KB, 2.2KB)
    dummyFirmware.fill(0xaa);

    const phases: string[] = [];
    const percentages: number[] = [];

    const unbind = client.onProgress((p) => {
      if (!phases.includes(p.phase)) phases.push(p.phase);
      percentages.push(p.progressPct);
    });

    await client.flashFirmware(dummyFirmware, "v2.1.0-test");
    unbind();

    expect(phases).toContain("PREPARING");
    expect(phases).toContain("STARTING");
    expect(phases).toContain("STREAMING");
    expect(phases).toContain("VERIFYING");
    expect(phases).toContain("REBOOTING");
    expect(phases).toContain("COMPLETED");

    const finalProgress = client.getProgress();
    expect(finalProgress.phase).toBe("COMPLETED");
    expect(finalProgress.progressPct).toBe(100);
    expect(finalProgress.bytesSent).toBe(35000);
    expect(finalProgress.totalBytes).toBe(35000);
    expect(finalProgress.currentChunk).toBe(3);
    expect(finalProgress.totalChunks).toBe(3);
  });

  it("handles user cancellation cleanly", async () => {
    const largeFirmware = new Uint8Array(500000); // 500 KB
    largeFirmware.fill(0x55);

    const promise = client.flashFirmware(largeFirmware, "v2.2.0-cancel");

    // Cancel after starting
    setTimeout(() => {
      client.cancelUpdate();
    }, 40);

    await expect(promise).rejects.toThrow();

    const progress = client.getProgress();
    expect(progress.phase).toBe("ERROR");
    expect(progress.errorDetail).toContain("cancelled");
  });
});

describe("OtaUpdateClient - Hardware Transport Mocking", () => {
  let connection: RobotConnectionManager;
  let client: OtaUpdateClient;

  beforeEach(() => {
    connection = new RobotConnectionManager();
    // Non-simulator mode
    client = new OtaUpdateClient(connection);
  });

  it("executes multi-chunk stream with hardware ACKs", async () => {
    const firmware = new Uint8Array(32768); // Exactly 2 chunks
    firmware.fill(0x12);

    const sentFrames: { type: FrameType; payload: Uint8Array }[] = [];
    const assignedSessionId = 777777;

    vi.spyOn(connection, "sendRawFrame").mockImplementation(async (type, payload) => {
      sentFrames.push({ type, payload });

      if (type === FrameType.OTA_UPDATE_START) {
        setTimeout(() => {
          // @ts-expect-error accessing private method for unit mock
          connection.handleInboundFrame({
            header: {
              magic: 0x4250,
              frameType: FrameType.OTA_UPDATE_ACK,
              flags: 0,
              sequenceId: 1,
              payloadLen: 10,
              crc32: 0,
            },
            payload: encodeOtaUpdateAck({
              transferId: assignedSessionId,
              nextExpectedChunk: 0,
              progressPct: 0,
              status: OtaAckStatus.OK,
            }),
          });
        }, 5);
      } else if (type === FrameType.OTA_UPDATE_CHUNK) {
        const view = new DataView(payload.buffer, payload.byteOffset, 12);
        const chunkTransferId = view.getUint32(0, true);
        const chunkIndex = view.getUint32(4, true);

        setTimeout(() => {
          const isLast = chunkIndex === 1;
          // @ts-expect-error accessing private method for unit mock
          connection.handleInboundFrame({
            header: {
              magic: 0x4250,
              frameType: FrameType.OTA_UPDATE_ACK,
              flags: 0,
              sequenceId: 2 + chunkIndex,
              payloadLen: 10,
              crc32: 0,
            },
            payload: encodeOtaUpdateAck({
              transferId: chunkTransferId,
              nextExpectedChunk: chunkIndex + 1,
              progressPct: isLast ? 100 : 50,
              status: isLast
                ? OtaAckStatus.REBOOTING_INTO_NEW_FIRMWARE
                : OtaAckStatus.OK,
            }),
          });
        }, 5);
      }

      return true;
    });

    await client.flashFirmware(firmware, "v2.0.1-mock");

    expect(sentFrames.some((f) => f.type === FrameType.OTA_UPDATE_START)).toBe(true);
    expect(sentFrames.filter((f) => f.type === FrameType.OTA_UPDATE_CHUNK)).toHaveLength(2);
    expect(client.getProgress().phase).toBe("COMPLETED");
  });

  it("handles CRC error retry and recovers", async () => {
    const firmware = new Uint8Array(16384); // Exactly 1 chunk
    firmware.fill(0x34);

    let crcRetried = false;
    const assignedSessionId = 888888;

    vi.spyOn(connection, "sendRawFrame").mockImplementation(async (type, payload) => {
      if (type === FrameType.OTA_UPDATE_START) {
        setTimeout(() => {
          // @ts-expect-error accessing private method for unit mock
          connection.handleInboundFrame({
            header: {
              magic: 0x4250,
              frameType: FrameType.OTA_UPDATE_ACK,
              flags: 0,
              sequenceId: 1,
              payloadLen: 10,
              crc32: 0,
            },
            payload: encodeOtaUpdateAck({
              transferId: assignedSessionId,
              nextExpectedChunk: 0,
              progressPct: 0,
              status: OtaAckStatus.OK,
            }),
          });
        }, 5);
      } else if (type === FrameType.OTA_UPDATE_CHUNK) {
        const view = new DataView(payload.buffer, payload.byteOffset, 12);
        const chunkTransferId = view.getUint32(0, true);

        setTimeout(() => {
          if (!crcRetried) {
            crcRetried = true;
            // Send CRC_RETRY status first
            // @ts-expect-error accessing private method for unit mock
            connection.handleInboundFrame({
              header: {
                magic: 0x4250,
                frameType: FrameType.OTA_UPDATE_ACK,
                flags: 0,
                sequenceId: 2,
                payloadLen: 10,
                crc32: 0,
              },
              payload: encodeOtaUpdateAck({
                transferId: chunkTransferId,
                nextExpectedChunk: 0,
                progressPct: 0,
                status: OtaAckStatus.CRC_RETRY,
              }),
            });
          } else {
            // Success on second attempt
            // @ts-expect-error accessing private method for unit mock
            connection.handleInboundFrame({
              header: {
                magic: 0x4250,
                frameType: FrameType.OTA_UPDATE_ACK,
                flags: 0,
                sequenceId: 3,
                payloadLen: 10,
                crc32: 0,
              },
              payload: encodeOtaUpdateAck({
                transferId: chunkTransferId,
                nextExpectedChunk: 1,
                progressPct: 100,
                status: OtaAckStatus.REBOOTING_INTO_NEW_FIRMWARE,
              }),
            });
          }
        }, 5);
      }
      return true;
    });

    await client.flashFirmware(firmware, "v2.0.2-crc-test");
    expect(crcRetried).toBe(true);
    expect(client.getProgress().phase).toBe("COMPLETED");
  });

  it("aborts when device rejects signature with SIGNATURE_INVALID", async () => {
    const firmware = new Uint8Array(16384);

    vi.spyOn(connection, "sendRawFrame").mockImplementation(async (type) => {
      if (type === FrameType.OTA_UPDATE_START) {
        setTimeout(() => {
          // @ts-expect-error accessing private method for unit mock
          connection.handleInboundFrame({
            header: {
              magic: 0x4250,
              frameType: FrameType.OTA_UPDATE_ACK,
              flags: 0,
              sequenceId: 1,
              payloadLen: 10,
              crc32: 0,
            },
            payload: encodeOtaUpdateAck({
              transferId: 0,
              nextExpectedChunk: 0,
              progressPct: 0,
              status: OtaAckStatus.SIGNATURE_INVALID,
            }),
          });
        }, 5);
      }
      return true;
    });

    await expect(client.flashFirmware(firmware, "v2.0.3-bad-sig")).rejects.toThrow(
      "Digital signature verification failed"
    );
    expect(client.getProgress().phase).toBe("ERROR");
  });
});
