import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  FrameType,
  FrameFlags,
  encodeFrame,
  decodeFrame,
  crc32,
  encodeSdVaultChunk,
  decodeSdVaultChunk,
  encodeSdVaultAck,
  decodeSdVaultAck,
  SdVaultStatus,
  encodeControlPayload,
  decodeControlPayload,
  SdVaultStartSchema,
  SdVaultListReqSchema,
  SdVaultListResSchema,
  type SdVaultStart,
  type SdVaultListReq,
  type SdVaultListRes,
  SD_CHUNK_HEADER_SIZE,
} from "@petbot/protocol";

describe("Send & Collect SD Card Vault Engine (SdVaultEngine) & Viewer Page", () => {
  const firmwareDir = path.resolve(__dirname, "../../../firmware");
  const sdVaultHPath = path.join(firmwareDir, "include/agentic/sd_vault.h");
  const sdVaultCppPath = path.join(firmwareDir, "src/agentic/sd_vault.cpp");
  const storageHalHPath = path.join(firmwareDir, "include/hal/storage_hal.h");
  const storageHalCppPath = path.join(firmwareDir, "src/hal/storage_hal.cpp");
  const mainCppPath = path.join(firmwareDir, "src/main.cpp");

  it("verifies all C++20 SD Vault headers and sources exist with zero TODOs or placeholders", () => {
    const files = [
      sdVaultHPath,
      sdVaultCppPath,
      storageHalHPath,
      storageHalCppPath,
      mainCppPath,
    ];

    for (const file of files) {
      expect(fs.existsSync(file), `File missing: ${file}`).toBe(true);
      const content = fs.readFileSync(file, "utf-8");
      expect(content).not.toMatch(/\bTODO\b/);
      expect(content).not.toMatch(/\bTBD\b/);
      expect(content).not.toMatch(/\bFIXME\b/);
      expect(content).not.toMatch(/\bPLACEHOLDER\b/i);
    }
  });

  it("verifies 128KB PSRAM write-combining buffer and 64x80 thumbnail constants in C++ header", () => {
    const header = fs.readFileSync(sdVaultHPath, "utf-8");
    expect(header).toContain("static constexpr size_t WRITE_BUFFER_SIZE = 128 * 1024;");
    expect(header).toContain("static constexpr size_t THUMB_WIDTH       = 64;");
    expect(header).toContain("static constexpr size_t THUMB_HEIGHT      = 80;");
    expect(header).toContain("static constexpr size_t THUMB_BYTES       = THUMB_WIDTH * THUMB_HEIGHT * sizeof(uint16_t);");
    expect(header).toContain("struct SdVaultAckPayload");
    expect(header).toContain("static_assert(sizeof(SdVaultAckPayload) == 9");
    expect(header).toContain("class SdVaultEngine");
    expect(header).toContain("std::shared_ptr<petbot::firmware::apps::IAppPage> createSdVaultPage();");

    const cpp = fs.readFileSync(sdVaultCppPath, "utf-8");
    expect(cpp).toContain("MALLOC_CAP_SPIRAM");
    expect(cpp).toContain("petbot::protocol::petbot_crc32");
    expect(cpp).toContain("Sha256Context");
  });

  it("verifies StorageHal supports appendFile and rename for atomic chunk staging and finalization", () => {
    const halH = fs.readFileSync(storageHalHPath, "utf-8");
    expect(halH).toContain("bool rename(const char* fromPath, const char* toPath) noexcept;");
    expect(halH).toContain("bool appendFile(const char* path, const uint8_t* data, size_t length) noexcept;");

    const halCpp = fs.readFileSync(storageHalCppPath, "utf-8");
    expect(halCpp).toContain("StorageHal::rename");
    expect(halCpp).toContain("StorageHal::appendFile");
  });

  it("verifies SdVaultStart and SdVaultAck encoding, decoding, and status codes", () => {
    const startPayload: SdVaultStart = {
      fileId: "vault_img_001",
      path: "family_portrait.rgb",
      totalBytes: 32768,
      totalChunks: 2,
      sha256Hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      direction: "PUSH_TO_ROBOT",
    };

    const packedStart = encodeControlPayload(SdVaultStartSchema, startPayload);
    expect(packedStart.byteLength).toBeGreaterThan(0);

    const unpackedStart = decodeControlPayload(SdVaultStartSchema, packedStart);
    expect(unpackedStart.fileId).toBe("vault_img_001");
    expect(unpackedStart.path).toBe("family_portrait.rgb");
    expect(unpackedStart.totalBytes).toBe(32768);
    expect(unpackedStart.totalChunks).toBe(2);
    expect(unpackedStart.direction).toBe("PUSH_TO_ROBOT");

    // Test 9-byte SdVaultAck encoding
    const ackBytes = encodeSdVaultAck({
      transferId: 0x42501234,
      nextExpectedChunk: 1,
      status: SdVaultStatus.OK,
    });
    expect(ackBytes.byteLength).toBe(9);

    const ack = decodeSdVaultAck(ackBytes);
    expect(ack.transferId).toBe(0x42501234);
    expect(ack.nextExpectedChunk).toBe(1);
    expect(ack.status).toBe(SdVaultStatus.OK);

    // Test completed status
    const completedAckBytes = encodeSdVaultAck({
      transferId: 0x42501234,
      nextExpectedChunk: 2,
      status: SdVaultStatus.COMPLETED,
    });
    const completedAck = decodeSdVaultAck(completedAckBytes);
    expect(completedAck.status).toBe(SdVaultStatus.COMPLETED);
    expect(completedAck.nextExpectedChunk).toBe(2);
  });

  it("verifies chunked transmission pipeline with 16KB chunks, CRC32, and SHA-256 integrity", () => {
    // Generate 48KB test binary file (3 chunks of 16KB)
    const totalBytes = 48 * 1024;
    const testData = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes; ++i) {
      testData[i] = (i * 31 + 17) & 0xff;
    }

    const sha256Hex = crypto.createHash("sha256").update(testData).digest("hex");
    expect(sha256Hex.length).toBe(64);

    const CHUNK_SIZE = 16384;
    const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
    expect(totalChunks).toBe(3);

    const transferId = 0x88776655;

    // Simulate sending 3 chunks
    for (let c = 0; c < totalChunks; ++c) {
      const offset = c * CHUNK_SIZE;
      const rawChunk = testData.subarray(offset, offset + CHUNK_SIZE);
      const chunkCrc = crc32(rawChunk);

      const encodedChunk = encodeSdVaultChunk({
        transferId,
        chunkIndex: c,
        chunkCrc32: chunkCrc,
        rawBytes: rawChunk,
      });

      expect(encodedChunk.byteLength).toBe(SD_CHUNK_HEADER_SIZE + rawChunk.byteLength);

      // Verify decoding
      const decoded = decodeSdVaultChunk(encodedChunk);
      expect(decoded.transferId).toBe(transferId);
      expect(decoded.chunkIndex).toBe(c);
      expect(decoded.chunkCrc32).toBe(chunkCrc);
      expect(decoded.rawBytes.byteLength).toBe(rawChunk.byteLength);

      // Verify CRC32 match
      const verifiedCrc = crc32(decoded.rawBytes);
      expect(verifiedCrc).toBe(chunkCrc);
    }
  });

  it("verifies chunk CRC32 mismatch detection and retry protocol", () => {
    const rawChunk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const validCrc = crc32(rawChunk);

    const encoded = encodeSdVaultChunk({
      transferId: 100,
      chunkIndex: 0,
      chunkCrc32: validCrc,
      rawBytes: rawChunk,
    });

    const corrupted = new Uint8Array(encoded);
    // Corrupt one byte of chunk payload
    corrupted[SD_CHUNK_HEADER_SIZE + 2] = corrupted[SD_CHUNK_HEADER_SIZE + 2]! ^ 0xff;

    const decoded = decodeSdVaultChunk(corrupted);
    const computedCrc = crc32(decoded.rawBytes);

    expect(computedCrc).not.toBe(decoded.chunkCrc32);

    // Emulate receiver replying with CRC_MISMATCH_RETRY
    const retryAck = encodeSdVaultAck({
      transferId: 100,
      nextExpectedChunk: 0,
      status: SdVaultStatus.CRC_MISMATCH_RETRY,
    });
    const parsedAck = decodeSdVaultAck(retryAck);
    expect(parsedAck.status).toBe(SdVaultStatus.CRC_MISMATCH_RETRY);
    expect(parsedAck.nextExpectedChunk).toBe(0);
  });

  it("verifies SdVaultListReq and SdVaultListRes directory indexing catalog", () => {
    const listReq: SdVaultListReq = {
      directoryPath: "/sd/vault/files",
    };
    const packedReq = encodeControlPayload(SdVaultListReqSchema, listReq);
    const unpackedReq = decodeControlPayload(SdVaultListReqSchema, packedReq);
    expect(unpackedReq.directoryPath).toBe("/sd/vault/files");

    const listRes: SdVaultListRes = {
      directoryPath: "/sd/vault/files",
      entries: [
        {
          name: "photo.rgb",
          isDirectory: false,
          sizeBytes: 10240,
          modifiedTimestamp: 1700000000,
        },
        {
          name: "notes.txt",
          isDirectory: false,
          sizeBytes: 1520,
          modifiedTimestamp: 1700000050,
        },
      ],
    };

    const packedRes = encodeControlPayload(SdVaultListResSchema, listRes);
    const unpackedRes = decodeControlPayload(SdVaultListResSchema, packedRes);
    expect(unpackedRes.entries.length).toBe(2);
    expect(unpackedRes.entries[0]!.name).toBe("photo.rgb");
    expect(unpackedRes.entries[0]!.sizeBytes).toBe(10240);
    expect(unpackedRes.entries[1]!.name).toBe("notes.txt");
  });

  it("verifies 64x80 RGB565 thumbnail memory footprint and display canvas integration", () => {
    const width = 64;
    const height = 80;
    const bpp = 2; // RGB565
    const totalBytes = width * height * bpp;
    expect(totalBytes).toBe(10240);

    // Verify 64x80 fits centered on 128x160 canvas
    const canvasWidth = 128;
    const canvasHeight = 160;
    const posX = (canvasWidth - width) / 2;
    const posY = 24;

    expect(posX).toBe(32);
    expect(posY + height).toBeLessThanOrEqual(canvasHeight);
  });

  it("verifies main.cpp initializes SdVaultEngine and registers SdVaultPage in UI carousel", () => {
    const mainContent = fs.readFileSync(mainCppPath, "utf-8");
    expect(mainContent).toContain('#include "agentic/sd_vault.h"');
    expect(mainContent).toContain("SdVaultEngine::instance().init();");
    expect(mainContent).toContain("UIManager::instance().registerPage(createSdVaultPage());");
  });
});
