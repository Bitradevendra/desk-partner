import { describe, it, expect } from "vitest";
import {
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
  DISPLAY_BPP,
  DISPLAY_TOTAL_PIXELS,
  DISPLAY_BUFFER_BYTES,
  AUDIO_SAMPLE_RATE_HZ,
  AUDIO_FRAME_DURATION_MS,
  AUDIO_SAMPLES_PER_FRAME,
  AUDIO_BYTES_PER_SAMPLE,
  AUDIO_CHANNELS,
  AUDIO_FRAME_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  SD_CHUNK_SIZE_BYTES,
  BLE_MTU_SAFE_BYTES,
  MDNS_SERVICE_NAME,
  DEFAULT_WS_PORT,
  PROTOCOL_MAGIC,
  PROTOCOL_VERSION,
  BINARY_HEADER_SIZE_BYTES,
  MessageType,
} from "../src/index.js";
import {
  encodeFrame,
  decodeFrame,
  decodeFrameHeader,
} from "../src/binary.js";

describe("Protocol Constants", () => {
  it("enforces exact hardware display specifications", () => {
    expect(DISPLAY_WIDTH).toBe(160);
    expect(DISPLAY_HEIGHT).toBe(128);
    expect(DISPLAY_BPP).toBe(16);
    expect(DISPLAY_TOTAL_PIXELS).toBe(20480);
    expect(DISPLAY_BUFFER_BYTES).toBe(40960);
  });

  it("enforces exact audio streaming buffer specifications", () => {
    expect(AUDIO_SAMPLE_RATE_HZ).toBe(16000);
    expect(AUDIO_FRAME_DURATION_MS).toBe(20);
    expect(AUDIO_SAMPLES_PER_FRAME).toBe(320);
    expect(AUDIO_BYTES_PER_SAMPLE).toBe(2);
    expect(AUDIO_CHANNELS).toBe(1);
    expect(AUDIO_FRAME_BYTES).toBe(640);
  });

  it("enforces network payload and storage limits", () => {
    expect(MAX_WS_PAYLOAD_BYTES).toBe(65536);
    expect(SD_CHUNK_SIZE_BYTES).toBe(16384);
    expect(BLE_MTU_SAFE_BYTES).toBe(244);
    expect(MDNS_SERVICE_NAME).toBe("_petbot._tcp.local");
    expect(DEFAULT_WS_PORT).toBe(8443);
  });

  it("enforces binary framing header specifications", () => {
    expect(PROTOCOL_MAGIC).toBe(0x50455431);
    expect(PROTOCOL_VERSION).toBe(1);
    expect(BINARY_HEADER_SIZE_BYTES).toBe(16);
  });
});

describe("Zero-Copy Binary Protocol", () => {
  it("encodes and decodes binary frames with byte-accurate header and zero-copy payload view", () => {
    const rawPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42, 0x00, 0x7f]);
    const sequenceNumber = 1042;
    const flags = 0x01;

    const encoded = encodeFrame(MessageType.DISPLAY_FRAME, sequenceNumber, rawPayload, flags);

    expect(encoded.byteLength).toBe(BINARY_HEADER_SIZE_BYTES + rawPayload.byteLength);

    const decoded = decodeFrame(encoded);
    expect(decoded.header.magic).toBe(PROTOCOL_MAGIC);
    expect(decoded.header.version).toBe(PROTOCOL_VERSION);
    expect(decoded.header.messageType).toBe(MessageType.DISPLAY_FRAME);
    expect(decoded.header.sequence).toBe(sequenceNumber);
    expect(decoded.header.flags).toBe(flags);
    expect(decoded.header.payloadLength).toBe(rawPayload.byteLength);

    expect(decoded.payload).toEqual(rawPayload);
    // Verify zero-copy: underlying buffer matches
    expect(decoded.payload.buffer).toBe(encoded.buffer);
  });

  it("rejects invalid magic and corrupted lengths", () => {
    const dummyBuffer = new Uint8Array(BINARY_HEADER_SIZE_BYTES);
    const view = new DataView(dummyBuffer.buffer);
    view.setUint32(0, 0x12345678, true); // Wrong magic
    view.setUint8(4, 1);

    expect(() => decodeFrameHeader(view)).toThrowError(/Invalid protocol magic/);
  });
});
