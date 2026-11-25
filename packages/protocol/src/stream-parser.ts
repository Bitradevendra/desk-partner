import {
  FRAME_MAGIC,
  FRAME_VERSION,
  FRAME_HEADER_SIZE,
  FRAME_TRAILER_SIZE,
  FRAME_OVERHEAD_SIZE,
  PetBotFrameHeader,
  DecodedFrame,
  FrameType,
} from "./frame-types.js";
import { crc32 } from "./codec.js";
import { MAX_WS_PAYLOAD_BYTES } from "./constants.js";

export interface FrameStreamParserOptions {
  /** Initial internal buffer capacity in bytes (default: 65,536) */
  initialCapacity?: number | undefined;
  /** Maximum allowable payload length before discarding as corrupted (default: 65,536) */
  maxPayloadBytes?: number | undefined;
  /** Whether to return zero-copy subarray views (true) or detached copies (false, default: false) */
  zeroCopy?: boolean | undefined;
}

export type FrameListener = (frame: DecodedFrame) => void;
export type ErrorListener = (error: Error) => void;

/**
 * High-speed stateful stream parser for TCP, WebSocket, and BLE byte streams.
 * Ingests arbitrary fragments, hunts for 0x4250 magic bytes, validates IEEE 802.3 CRC32,
 * and recovers automatically from corrupted or interleaved noise.
 */
export class FrameStreamParser {
  private buffer: Uint8Array;
  private readHead = 0;
  private writeHead = 0;
  private readonly maxPayloadBytes: number;
  private readonly zeroCopy: boolean;

  private readonly frameListeners = new Set<FrameListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(options?: FrameStreamParserOptions) {
    const capacity = options?.initialCapacity ?? 65536;
    this.buffer = new Uint8Array(Math.max(capacity, FRAME_OVERHEAD_SIZE * 2));
    this.maxPayloadBytes = options?.maxPayloadBytes ?? MAX_WS_PAYLOAD_BYTES;
    this.zeroCopy = options?.zeroCopy ?? false;
  }

  /**
   * Number of buffered, unparsed bytes currently waiting in the internal accumulator.
   */
  public get bufferedBytes(): number {
    return this.writeHead - this.readHead;
  }

  /**
   * Total allocated capacity of the internal buffer.
   */
  public get capacity(): number {
    return this.buffer.byteLength;
  }

  /**
   * Registers a callback invoked whenever a valid frame is decoded.
   * Returns an unregister function.
   */
  public onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /**
   * Registers a callback invoked whenever corrupted bytes or CRC errors are detected.
   * Returns an unregister function.
   */
  public onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /**
   * Clears all internal buffer state and resets read/write heads.
   */
  public reset(): void {
    this.readHead = 0;
    this.writeHead = 0;
  }

  /**
   * Pushes an incoming chunk of arbitrary bytes into the stream parser.
   * Decodes and emits all complete, valid frames immediately.
   * Returns the list of newly decoded frames.
   */
  public push(chunk: Uint8Array): DecodedFrame[] {
    if (chunk.byteLength === 0) {
      return [];
    }

    this.ensureCapacity(chunk.byteLength);

    // Append incoming chunk
    this.buffer.set(chunk, this.writeHead);
    this.writeHead += chunk.byteLength;

    const decodedFrames: DecodedFrame[] = [];

    // Parse loop
    while (this.writeHead - this.readHead >= FRAME_HEADER_SIZE) {
      const available = this.writeHead - this.readHead;

      // 1. Magic byte hunting (0x4250 -> 'P' at index 0, 'B' at index 1 in LE)
      const b0 = this.buffer[this.readHead]!;
      const b1 = this.buffer[this.readHead + 1]!;
      const magic = b0 | (b1 << 8);

      if (magic !== FRAME_MAGIC) {
        // Advance by 1 byte and resume hunting
        this.readHead += 1;
        continue;
      }

      // 2. Protocol Version verification
      const version = this.buffer[this.readHead + 2]!;
      if (version !== FRAME_VERSION) {
        // Not a supported version, advance past this magic byte and resume hunting
        this.readHead += 1;
        continue;
      }

      // 3. Payload length verification
      const b8 = this.buffer[this.readHead + 8]!;
      const b9 = this.buffer[this.readHead + 9]!;
      const b10 = this.buffer[this.readHead + 10]!;
      const b11 = this.buffer[this.readHead + 11]!;
      const payloadLen = (b8 | (b9 << 8) | (b10 << 16) | (b11 << 24)) >>> 0;

      if (payloadLen > this.maxPayloadBytes) {
        // Impossible payload length: corrupt frame. Advance past magic bytes and resume hunting.
        this.notifyError(
          new Error(
            `Frame payload length (${payloadLen}) exceeds maximum allowable (${this.maxPayloadBytes})`
          )
        );
        this.readHead += 2;
        continue;
      }

      const frameTotalBytes = FRAME_HEADER_SIZE + payloadLen + FRAME_TRAILER_SIZE;

      // 4. Check if the full frame (header + payload + CRC32 trailer) has arrived
      if (available < frameTotalBytes) {
        // Need more data from subsequent chunks
        break;
      }

      // 5. CRC32 Integrity Verification
      const frameStart = this.readHead;
      const headerPlusPayloadEnd = frameStart + FRAME_HEADER_SIZE + payloadLen;
      const computedCrc = crc32(this.buffer.subarray(frameStart, headerPlusPayloadEnd));

      const crcOffset = headerPlusPayloadEnd;
      const c0 = this.buffer[crcOffset]!;
      const c1 = this.buffer[crcOffset + 1]!;
      const c2 = this.buffer[crcOffset + 2]!;
      const c3 = this.buffer[crcOffset + 3]!;
      const expectedCrc = (c0 | (c1 << 8) | (c2 << 16) | (c3 << 24)) >>> 0;

      if (computedCrc !== expectedCrc) {
        // CRC mismatch! The frame is corrupt.
        // Advance past magic bytes and hunt for the next frame
        this.notifyError(
          new Error(
            `FrameStreamParser CRC32 mismatch: computed 0x${computedCrc.toString(16)}, expected 0x${expectedCrc.toString(16)}`
          )
        );
        this.readHead += 2;
        continue;
      }

      // 6. Construct valid DecodedFrame
      const view = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + frameStart,
        frameTotalBytes
      );

      const header: PetBotFrameHeader = {
        magic,
        version,
        frameType: view.getUint8(3) as FrameType,
        flags: view.getUint8(4),
        reserved: view.getUint8(5),
        seqId: view.getUint16(6, true),
        payloadLen,
      };

      const payload = this.zeroCopy
        ? this.buffer.subarray(frameStart + FRAME_HEADER_SIZE, headerPlusPayloadEnd)
        : this.buffer.slice(frameStart + FRAME_HEADER_SIZE, headerPlusPayloadEnd);

      const decoded: DecodedFrame = {
        header,
        payload,
        crc32: expectedCrc,
      };

      this.readHead += frameTotalBytes;
      decodedFrames.push(decoded);
      this.notifyFrame(decoded);
    }

    // Compaction optimization
    this.compactBuffer();

    return decodedFrames;
  }

  private ensureCapacity(incomingBytes: number): void {
    const required = this.writeHead + incomingBytes;
    if (required <= this.buffer.byteLength) {
      return;
    }

    const unparsedBytes = this.writeHead - this.readHead;
    const requiredAfterCompaction = unparsedBytes + incomingBytes;

    if (requiredAfterCompaction <= this.buffer.byteLength) {
      // Shift unparsed bytes to front
      if (this.readHead > 0) {
        this.buffer.copyWithin(0, this.readHead, this.writeHead);
        this.writeHead = unparsedBytes;
        this.readHead = 0;
      }
      return;
    }

    // Allocate larger buffer (grow by at least 2x or required size)
    let newCapacity = this.buffer.byteLength * 2;
    while (newCapacity < requiredAfterCompaction) {
      newCapacity *= 2;
    }

    const newBuffer = new Uint8Array(newCapacity);
    if (unparsedBytes > 0) {
      newBuffer.set(this.buffer.subarray(this.readHead, this.writeHead), 0);
    }
    this.buffer = newBuffer;
    this.writeHead = unparsedBytes;
    this.readHead = 0;
  }

  private compactBuffer(): void {
    if (this.readHead === this.writeHead) {
      this.readHead = 0;
      this.writeHead = 0;
    } else if (this.readHead > 32768 && this.readHead > (this.buffer.byteLength >> 1)) {
      const activeBytes = this.writeHead - this.readHead;
      this.buffer.copyWithin(0, this.readHead, this.writeHead);
      this.writeHead = activeBytes;
      this.readHead = 0;
    }
  }

  private notifyFrame(frame: DecodedFrame): void {
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch {
        // Protect stream loop from callback exceptions
      }
    }
  }

  private notifyError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        // Protect stream loop from callback exceptions
      }
    }
  }
}
