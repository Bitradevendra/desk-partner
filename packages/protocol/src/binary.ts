import {
  PROTOCOL_MAGIC,
  PROTOCOL_VERSION,
  BINARY_HEADER_SIZE_BYTES,
  MessageType,
  MAX_WS_PAYLOAD_BYTES,
} from "./constants.js";

/**
 * Packed 16-byte binary header definition (Little-Endian layout):
 * 
 * Offset | Size | Type   | Field
 * -------|------|--------|-------------
 * 0      | 4    | uint32 | Magic (0x50455431 / 'PET1')
 * 4      | 1    | uint8  | Protocol Version (1)
 * 5      | 1    | uint8  | Message Type (MessageType enum)
 * 6      | 2    | uint16 | Flags / Stream ID
 * 8      | 4    | uint32 | Sequence Number
 * 12     | 4    | uint32 | Payload Length (bytes)
 */
export interface BinaryFrameHeader {
  readonly magic: number;
  readonly version: number;
  readonly messageType: MessageType;
  readonly flags: number;
  readonly sequence: number;
  readonly payloadLength: number;
}

export interface BinaryFrame {
  readonly header: BinaryFrameHeader;
  /** Zero-copy subview into the payload buffer */
  readonly payload: Uint8Array;
}

/**
 * Validates and decodes a 16-byte binary frame header without copying.
 */
export function decodeFrameHeader(view: DataView, byteOffset = 0): BinaryFrameHeader {
  if (view.byteLength < byteOffset + BINARY_HEADER_SIZE_BYTES) {
    throw new RangeError(
      `Buffer length (${view.byteLength}) is insufficient for ${BINARY_HEADER_SIZE_BYTES}-byte header at offset ${byteOffset}`
    );
  }

  const magic = view.getUint32(byteOffset, true);
  if (magic !== PROTOCOL_MAGIC) {
    throw new Error(`Invalid protocol magic: 0x${magic.toString(16)} (expected 0x${PROTOCOL_MAGIC.toString(16)})`);
  }

  const version = view.getUint8(byteOffset + 4);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${version} (expected ${PROTOCOL_VERSION})`);
  }

  const rawType = view.getUint8(byteOffset + 5);
  const messageType = rawType as MessageType;
  const flags = view.getUint16(byteOffset + 6, true);
  const sequence = view.getUint32(byteOffset + 8, true);
  const payloadLength = view.getUint32(byteOffset + 12, true);

  if (payloadLength > MAX_WS_PAYLOAD_BYTES) {
    throw new RangeError(
      `Payload length (${payloadLength} bytes) exceeds maximum ceiling (${MAX_WS_PAYLOAD_BYTES} bytes)`
    );
  }

  return {
    magic,
    version,
    messageType,
    flags,
    sequence,
    payloadLength,
  };
}

/**
 * Parses an entire binary message with zero-copy payload slicing.
 */
export function decodeFrame(buffer: ArrayBuffer | Uint8Array, byteOffset = 0): BinaryFrame {
  const arrayBuffer = buffer instanceof Uint8Array ? buffer.buffer : buffer;
  const initialOffset = buffer instanceof Uint8Array ? buffer.byteOffset + byteOffset : byteOffset;
  const totalLength = buffer instanceof Uint8Array ? buffer.byteLength - byteOffset : buffer.byteLength - byteOffset;

  if (totalLength < BINARY_HEADER_SIZE_BYTES) {
    throw new RangeError(`Buffer too small for binary frame: ${totalLength} bytes`);
  }

  const view = new DataView(arrayBuffer, initialOffset, totalLength);
  const header = decodeFrameHeader(view, 0);

  const expectedTotalBytes = BINARY_HEADER_SIZE_BYTES + header.payloadLength;
  if (totalLength < expectedTotalBytes) {
    throw new RangeError(
      `Truncated frame: expected ${expectedTotalBytes} bytes, received ${totalLength} bytes`
    );
  }

  // Zero-copy view into payload segment
  const payload = new Uint8Array(
    arrayBuffer,
    initialOffset + BINARY_HEADER_SIZE_BYTES,
    header.payloadLength
  );

  return {
    header,
    payload,
  };
}

/**
 * Encodes a binary frame header and payload into a single contiguous ArrayBuffer.
 */
export function encodeFrame(
  messageType: MessageType,
  sequence: number,
  payload: Uint8Array,
  flags = 0
): Uint8Array {
  const payloadLength = payload.byteLength;
  if (payloadLength > MAX_WS_PAYLOAD_BYTES) {
    throw new RangeError(`Payload exceeds MAX_WS_PAYLOAD_BYTES (${payloadLength} > ${MAX_WS_PAYLOAD_BYTES})`);
  }

  const totalBytes = BINARY_HEADER_SIZE_BYTES + payloadLength;
  const targetBuffer = new Uint8Array(totalBytes);
  const view = new DataView(targetBuffer.buffer, targetBuffer.byteOffset, totalBytes);

  view.setUint32(0, PROTOCOL_MAGIC, true);
  view.setUint8(4, PROTOCOL_VERSION);
  view.setUint8(5, messageType);
  view.setUint16(6, flags, true);
  view.setUint32(8, sequence, true);
  view.setUint32(12, payloadLength, true);

  if (payloadLength > 0) {
    targetBuffer.set(payload, BINARY_HEADER_SIZE_BYTES);
  }

  return targetBuffer;
}
