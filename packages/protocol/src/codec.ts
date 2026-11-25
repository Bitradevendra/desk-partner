import { encode, decode } from "@msgpack/msgpack";
export { encode, decode };
import { z } from "zod";
import {
  FRAME_MAGIC,
  FRAME_VERSION,
  FRAME_HEADER_SIZE,
  FRAME_TRAILER_SIZE,
  FRAME_OVERHEAD_SIZE,
  PetBotFrameHeader,
  DecodedFrame,
  FrameType,
  AUDIO_DOWNLINK_HEADER_SIZE,
  AudioDownlinkHeader,
  AudioDownlinkFrame,
  AUDIO_UPLINK_HEADER_SIZE,
  AudioUplinkHeader,
  AudioUplinkFrame,
  SD_CHUNK_HEADER_SIZE,
  SdVaultChunkHeader,
  SdVaultChunk,
  SdVaultAck,
  SdVaultStatus,
  OTA_CHUNK_HEADER_SIZE,
  OTA_ACK_PAYLOAD_SIZE,
  OtaChunkHeader,
  OtaChunk,
  OtaAckPayload,
  OtaAckStatus,
  AudioCodec,
} from "./frame-types.js";

// --- Fast IEEE 802.3 CRC32 Lookup Table Implementation ---
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c >>> 0;
}

/**
 * Computes the standard IEEE 802.3 32-bit Cyclic Redundancy Check (CRC32).
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.byteLength; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encodes a unified binary frame with a 12-byte Little-Endian header, payload,
 * and 4-byte IEEE 802.3 CRC32 trailer.
 */
export function encodeFrame(
  frameType: FrameType,
  payload: Uint8Array,
  seqId: number,
  flags = 0
): Uint8Array {
  const payloadLen = payload.byteLength;
  const totalLength = FRAME_HEADER_SIZE + payloadLen + FRAME_TRAILER_SIZE;
  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, totalLength);

  // 12-byte Little-Endian Header
  view.setUint16(0, FRAME_MAGIC, true); // 0x4250 ('P','B')
  view.setUint8(2, FRAME_VERSION);      // 0x01
  view.setUint8(3, frameType);
  view.setUint8(4, flags);
  view.setUint8(5, 0x00);               // Reserved for 4-byte alignment
  view.setUint16(6, seqId & 0xffff, true);
  view.setUint32(8, payloadLen, true);

  // Payload copy
  if (payloadLen > 0) {
    buffer.set(payload, FRAME_HEADER_SIZE);
  }

  // 4-byte CRC32 over header + payload
  const computedCrc = crc32(buffer.subarray(0, FRAME_HEADER_SIZE + payloadLen));
  view.setUint32(FRAME_HEADER_SIZE + payloadLen, computedCrc, true);

  return buffer;
}

/**
 * Decodes a raw frame buffer, verifying magic, version, exact length, and CRC32.
 * Extracts payload as a zero-copy subview.
 */
export function decodeFrame(raw: Uint8Array): DecodedFrame {
  if (raw.byteLength < FRAME_OVERHEAD_SIZE) {
    throw new RangeError(
      `Frame length (${raw.byteLength}) is less than minimum envelope overhead (${FRAME_OVERHEAD_SIZE})`
    );
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  const magic = view.getUint16(0, true);
  if (magic !== FRAME_MAGIC) {
    throw new Error(
      `Invalid frame magic: 0x${magic.toString(16).toUpperCase()} (expected 0x${FRAME_MAGIC.toString(16).toUpperCase()})`
    );
  }

  const version = view.getUint8(2);
  if (version !== FRAME_VERSION) {
    throw new Error(`Unsupported frame version: ${version} (expected ${FRAME_VERSION})`);
  }

  const frameType = view.getUint8(3) as FrameType;
  const flags = view.getUint8(4);
  const reserved = view.getUint8(5);
  const seqId = view.getUint16(6, true);
  const payloadLen = view.getUint32(8, true);

  const expectedTotalBytes = FRAME_HEADER_SIZE + payloadLen + FRAME_TRAILER_SIZE;
  if (raw.byteLength !== expectedTotalBytes) {
    throw new RangeError(
      `Frame length mismatch: header specifies ${payloadLen} payload bytes (total ${expectedTotalBytes}), but buffer has ${raw.byteLength} bytes`
    );
  }

  // CRC32 verification
  const expectedCrc = view.getUint32(FRAME_HEADER_SIZE + payloadLen, true);
  const computedCrc = crc32(raw.subarray(0, FRAME_HEADER_SIZE + payloadLen));

  if (computedCrc !== expectedCrc) {
    throw new Error(
      `Frame CRC32 checksum mismatch: expected 0x${expectedCrc.toString(16)}, computed 0x${computedCrc.toString(16)}`
    );
  }

  const header: PetBotFrameHeader = {
    magic,
    version,
    frameType,
    flags,
    reserved,
    seqId,
    payloadLen,
  };

  // Zero-copy subview of payload segment
  const payload = raw.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + payloadLen);

  return {
    header,
    payload,
    crc32: expectedCrc,
  };
}

// Backward compatibility aliases
export type BinaryFrame = DecodedFrame;
export type BinaryFrameHeader = PetBotFrameHeader;

// --- Specialized Hot-Path Binary Codecs ---

export interface AudioDownlinkParams {
  readonly emotionId: number;
  readonly visemeMouthOpen?: number | undefined;
  readonly visemeMouthOpenness?: number | undefined;
  readonly eyeGazeX: number;
  readonly eyeGazeY: number;
  readonly audioCodec?: number | undefined;
  readonly flags?: number | undefined;
  readonly audioByteLen?: number | undefined;
  readonly audioData: Uint8Array;
}

/**
 * Encodes audio downlink frame with 8-byte packed visual expression & audio header.
 */
export function encodeAudioDownlinkFrame(params: AudioDownlinkParams): Uint8Array {
  const audioLen = params.audioByteLen ?? params.audioData.byteLength;
  const totalBytes = AUDIO_DOWNLINK_HEADER_SIZE + audioLen;
  const buffer = new Uint8Array(totalBytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, totalBytes);

  const mouthOpen = params.visemeMouthOpen ?? params.visemeMouthOpenness ?? 0;
  const codec = params.audioCodec ?? AudioCodec.PCM16;
  const flags = params.flags ?? 0;

  view.setUint8(0, params.emotionId & 0xff);
  view.setUint8(1, mouthOpen & 0xff);
  view.setInt8(2, params.eyeGazeX);
  view.setInt8(3, params.eyeGazeY);
  view.setUint8(4, codec & 0xff);
  view.setUint8(5, flags & 0xff);
  view.setUint16(6, audioLen & 0xffff, true);

  if (params.audioData.byteLength > 0) {
    buffer.set(params.audioData.subarray(0, audioLen), AUDIO_DOWNLINK_HEADER_SIZE);
  }
  return buffer;
}

/**
 * Decodes audio downlink frame into emotion/viseme parameters and zero-copy audio buffer.
 */
export function decodeAudioDownlinkFrame(payload: Uint8Array): AudioDownlinkFrame {
  if (payload.byteLength < AUDIO_DOWNLINK_HEADER_SIZE) {
    throw new RangeError(
      `Audio downlink payload too short (${payload.byteLength} < ${AUDIO_DOWNLINK_HEADER_SIZE})`
    );
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  const emotionId = view.getUint8(0);
  const visemeMouthOpen = view.getUint8(1);
  const eyeGazeX = view.getInt8(2);
  const eyeGazeY = view.getInt8(3);
  const audioCodec = view.getUint8(4);
  const flags = view.getUint8(5);
  const audioByteLen = view.getUint16(6, true);

  const header: AudioDownlinkHeader = {
    emotionId,
    visemeMouthOpen,
    eyeGazeX,
    eyeGazeY,
    audioCodec,
    flags,
    audioByteLen,
  };

  const audioData = payload.subarray(
    AUDIO_DOWNLINK_HEADER_SIZE,
    AUDIO_DOWNLINK_HEADER_SIZE + audioByteLen
  );

  return {
    header,
    emotionId,
    visemeMouthOpenness: visemeMouthOpen,
    visemeMouthOpen,
    eyeGazeX,
    eyeGazeY,
    audioCodec,
    flags,
    audioByteLen,
    audioData,
  };
}

export interface AudioUplinkParams {
  readonly rmsEnergy: number;
  readonly vadActive: boolean;
  readonly codec?: number | undefined;
  readonly sampleCount?: number | undefined;
  readonly audioData: Uint8Array;
}

/**
 * Encodes audio uplink frame with 6-byte VAD, RMS energy, and codec header.
 */
export function encodeAudioUplinkFrame(params: AudioUplinkParams): Uint8Array {
  const totalBytes = AUDIO_UPLINK_HEADER_SIZE + params.audioData.byteLength;
  const buffer = new Uint8Array(totalBytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, totalBytes);

  const codec = params.codec ?? AudioCodec.PCM16;
  const sampleCount = params.sampleCount ?? Math.floor(params.audioData.byteLength / 2);

  view.setUint16(0, params.rmsEnergy & 0xffff, true);
  view.setUint8(2, params.vadActive ? 1 : 0);
  view.setUint8(3, codec & 0xff);
  view.setUint16(4, sampleCount & 0xffff, true);

  if (params.audioData.byteLength > 0) {
    buffer.set(params.audioData, AUDIO_UPLINK_HEADER_SIZE);
  }
  return buffer;
}

/**
 * Decodes audio uplink frame into VAD state, RMS energy, codec, sample count, and zero-copy audio buffer.
 */
export function decodeAudioUplinkFrame(payload: Uint8Array): AudioUplinkFrame {
  if (payload.byteLength < AUDIO_UPLINK_HEADER_SIZE) {
    throw new RangeError(
      `Audio uplink payload too short (${payload.byteLength} < ${AUDIO_UPLINK_HEADER_SIZE})`
    );
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  const rmsEnergy = view.getUint16(0, true);
  const vadActive = view.getUint8(2) !== 0;
  const codec = view.getUint8(3);
  const sampleCount = view.getUint16(4, true);

  const header: AudioUplinkHeader = {
    rmsEnergy,
    vadActive,
    codec,
    sampleCount,
  };

  return {
    header,
    vadActive,
    rmsEnergy,
    codec,
    sampleCount,
    audioData: payload.subarray(AUDIO_UPLINK_HEADER_SIZE),
  };
}

export interface SdVaultChunkParams {
  readonly transferId: number;
  readonly chunkIndex: number;
  readonly chunkCrc32: number;
  readonly rawBytes: Uint8Array;
}

/**
 * Encodes SD card file chunk with 12-byte binary header.
 */
export function encodeSdVaultChunk(params: SdVaultChunkParams): Uint8Array {
  const totalBytes = SD_CHUNK_HEADER_SIZE + params.rawBytes.byteLength;
  const buffer = new Uint8Array(totalBytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, totalBytes);

  view.setUint32(0, params.transferId, true);
  view.setUint32(4, params.chunkIndex, true);
  view.setUint32(8, params.chunkCrc32, true);

  if (params.rawBytes.byteLength > 0) {
    buffer.set(params.rawBytes, SD_CHUNK_HEADER_SIZE);
  }
  return buffer;
}

/**
 * Decodes SD card file chunk, extracting header fields and zero-copy chunk buffer.
 */
export function decodeSdVaultChunk(payload: Uint8Array): SdVaultChunk {
  if (payload.byteLength < SD_CHUNK_HEADER_SIZE) {
    throw new RangeError(`SD chunk payload too short (${payload.byteLength} < ${SD_CHUNK_HEADER_SIZE})`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  const transferId = view.getUint32(0, true);
  const chunkIndex = view.getUint32(4, true);
  const chunkCrc32 = view.getUint32(8, true);

  const header: SdVaultChunkHeader = {
    transferId,
    chunkIndex,
    chunkCrc32,
  };

  return {
    header,
    transferId,
    chunkIndex,
    chunkCrc32,
    rawBytes: payload.subarray(SD_CHUNK_HEADER_SIZE),
  };
}

export interface SdVaultAckParams {
  readonly transferId: number;
  readonly nextExpectedChunk: number;
  readonly status: SdVaultStatus;
}

/**
 * Encodes SD vault transfer acknowledgement (9 bytes packed binary).
 */
export function encodeSdVaultAck(params: SdVaultAckParams): Uint8Array {
  const buffer = new Uint8Array(9);
  const view = new DataView(buffer.buffer, buffer.byteOffset, 9);
  view.setUint32(0, params.transferId, true);
  view.setUint32(4, params.nextExpectedChunk, true);
  view.setUint8(8, params.status);
  return buffer;
}

/**
 * Decodes SD vault transfer acknowledgement.
 */
export function decodeSdVaultAck(payload: Uint8Array): SdVaultAck {
  if (payload.byteLength < 9) {
    throw new RangeError(`SD ack payload too short (${payload.byteLength} < 9)`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    transferId: view.getUint32(0, true),
    nextExpectedChunk: view.getUint32(4, true),
    status: view.getUint8(8) as SdVaultStatus,
  };
}

export interface OtaChunkParams {
  readonly transferId: number;
  readonly chunkIndex: number;
  readonly chunkCrc32: number;
  readonly rawBytes: Uint8Array;
}

/**
 * Encodes OTA firmware update chunk with 12-byte Little-Endian binary header.
 */
export function encodeOtaUpdateChunk(params: OtaChunkParams): Uint8Array {
  const totalBytes = OTA_CHUNK_HEADER_SIZE + params.rawBytes.byteLength;
  const buffer = new Uint8Array(totalBytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, totalBytes);

  view.setUint32(0, params.transferId, true);
  view.setUint32(4, params.chunkIndex, true);
  view.setUint32(8, params.chunkCrc32, true);

  if (params.rawBytes.byteLength > 0) {
    buffer.set(params.rawBytes, OTA_CHUNK_HEADER_SIZE);
  }
  return buffer;
}

/**
 * Decodes OTA firmware update chunk, extracting header fields and zero-copy chunk subview.
 */
export function decodeOtaUpdateChunk(payload: Uint8Array): OtaChunk {
  if (payload.byteLength < OTA_CHUNK_HEADER_SIZE) {
    throw new RangeError(
      `OTA chunk payload too short (${payload.byteLength} < ${OTA_CHUNK_HEADER_SIZE})`
    );
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  const transferId = view.getUint32(0, true);
  const chunkIndex = view.getUint32(4, true);
  const chunkCrc32 = view.getUint32(8, true);

  const header: OtaChunkHeader = {
    transferId,
    chunkIndex,
    chunkCrc32,
  };

  return {
    header,
    transferId,
    chunkIndex,
    chunkCrc32,
    rawBytes: payload.subarray(OTA_CHUNK_HEADER_SIZE),
  };
}

export interface OtaAckParams {
  readonly transferId: number;
  readonly nextExpectedChunk: number;
  readonly progressPct: number;
  readonly status: OtaAckStatus;
}

/**
 * Encodes OTA update acknowledgement (10 bytes packed binary).
 */
export function encodeOtaUpdateAck(params: OtaAckParams): Uint8Array {
  const buffer = new Uint8Array(OTA_ACK_PAYLOAD_SIZE);
  const view = new DataView(buffer.buffer, buffer.byteOffset, OTA_ACK_PAYLOAD_SIZE);

  view.setUint32(0, params.transferId, true);
  view.setUint32(4, params.nextExpectedChunk, true);
  view.setUint8(8, Math.min(100, Math.max(0, params.progressPct)));
  view.setUint8(9, params.status);

  return buffer;
}

/**
 * Decodes OTA update acknowledgement.
 */
export function decodeOtaUpdateAck(payload: Uint8Array): OtaAckPayload {
  if (payload.byteLength < OTA_ACK_PAYLOAD_SIZE) {
    throw new RangeError(
      `OTA ack payload too short (${payload.byteLength} < ${OTA_ACK_PAYLOAD_SIZE})`
    );
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  return {
    transferId: view.getUint32(0, true),
    nextExpectedChunk: view.getUint32(4, true),
    progressPct: view.getUint8(8),
    status: view.getUint8(9) as OtaAckStatus,
  };
}

// --- Control Plane Codecs (Zod + MessagePack) ---

/**
 * Validates a JavaScript payload against a Zod schema and serializes it to compact MessagePack.
 */
export function encodeControlPayload<T>(schema: z.ZodType<T>, data: T): Uint8Array {
  const validated = schema.parse(data);
  return encode(validated);
}

/**
 * Deserializes a MessagePack buffer and validates it against a Zod schema.
 */
export function decodeControlPayload<T>(schema: z.ZodType<T>, buffer: Uint8Array): T {
  const unpacked = decode(buffer);
  return schema.parse(unpacked);
}
