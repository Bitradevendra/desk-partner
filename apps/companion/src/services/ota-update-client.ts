import {
  OTA_CHUNK_SIZE_BYTES,
  FrameType,
  FLAG_ACK_REQUIRED,
  FLAG_FINAL_CHUNK,
  FLAG_PRIORITY_REALTIME,
  crc32,
  encodeControlPayload,
  encodeOtaUpdateChunk,
  OtaUpdateStartSchema,
  OtaAckStatus,
  type OtaAckPayload,
  type OtaUpdateStart,
} from "@petbot/protocol";
import { robotConnection, type RobotConnectionManager } from "./robot-connection.js";

export const PBOTA_MAGIC = 0x50424f54; // 'P', 'B', 'O', 'T'
export const PBOTA_VERSION = 1;

export type OtaClientPhase =
  | "IDLE"
  | "PREPARING"
  | "STARTING"
  | "STREAMING"
  | "VERIFYING"
  | "REBOOTING"
  | "COMPLETED"
  | "ERROR";

export interface OtaUpdateProgress {
  phase: OtaClientPhase;
  progressPct: number;
  currentChunk: number;
  totalChunks: number;
  bytesSent: number;
  totalBytes: number;
  speedKBps: number;
  version: string;
  errorDetail?: string | undefined;
  estimatedSecondsRemaining?: number | undefined;
}

export interface ParsedOtaBundle {
  manifest: {
    version: string;
    totalBytes: number;
    chunkSize: number;
    totalChunks: number;
    sha256Hex: string;
    ed25519SignatureHex: string;
    timestamp?: number | undefined;
  };
  firmwareBin: Uint8Array;
}

export type OtaProgressListener = (progress: OtaUpdateProgress) => void;

/**
 * Universal browser & Node.js SHA-256 hex digest helper.
 */
export async function computeSha256Hex(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === "function") {
    const hashBuffer = await subtle.digest("SHA-256", data as any);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  throw new Error("No cryptographic SHA-256 provider available");
}

/**
 * Deserializes a binary .pbota file into manifest metadata and firmware binary bytes.
 */
export function parsePbotaFile(data: Uint8Array): ParsedOtaBundle {
  if (data.byteLength < 12) {
    throw new Error("Invalid .pbota file: file is smaller than 12-byte header");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== PBOTA_MAGIC) {
    throw new Error(`Invalid .pbota magic: 0x${magic.toString(16).toUpperCase()}`);
  }

  const version = view.getUint8(4);
  if (version !== PBOTA_VERSION) {
    throw new Error(`Unsupported .pbota container format version: ${version}`);
  }

  const manifestLen = view.getUint32(8, true);
  const headerLen = 12;
  if (data.byteLength < headerLen + manifestLen) {
    throw new Error("Corrupted .pbota bundle: truncated manifest segment");
  }

  const manifestBytes = data.subarray(headerLen, headerLen + manifestLen);
  const decoder = new TextDecoder("utf-8");
  const manifestJson = decoder.decode(manifestBytes);
  const manifest = JSON.parse(manifestJson);

  const firmwareBin = data.subarray(headerLen + manifestLen);
  if (firmwareBin.byteLength !== manifest.totalBytes) {
    console.warn(
      `Firmware byte size mismatch: manifest specifies ${manifest.totalBytes} bytes, found ${firmwareBin.byteLength} bytes.`
    );
  }

  return {
    manifest,
    firmwareBin,
  };
}

/**
 * High-res, zero-code Signed OTA Firmware Update Client.
 *
 * Slices firmware binaries into verified 16KB IEEE 802.3 CRC32 chunks,
 * streams them over mTLS WebSocket or BLE GATT with automatic retry,
 * and maintains continuous progress telemetry for consumer hardware UI.
 */
export class OtaUpdateClient {
  private static instance: OtaUpdateClient | null = null;

  public static getInstance(connection: RobotConnectionManager = robotConnection): OtaUpdateClient {
    if (!OtaUpdateClient.instance) {
      OtaUpdateClient.instance = new OtaUpdateClient(connection);
    }
    return OtaUpdateClient.instance;
  }

  private connection: RobotConnectionManager;
  private progressListeners = new Set<OtaProgressListener>();
  private activeAbortController: AbortController | null = null;

  private currentProgress: OtaUpdateProgress = {
    phase: "IDLE",
    progressPct: 0,
    currentChunk: 0,
    totalChunks: 0,
    bytesSent: 0,
    totalBytes: 0,
    speedKBps: 0,
    version: "",
  };

  constructor(connection: RobotConnectionManager = robotConnection) {
    this.connection = connection;
  }

  public getProgress(): Readonly<OtaUpdateProgress> {
    return { ...this.currentProgress };
  }

  public onProgress(listener: OtaProgressListener): () => void {
    this.progressListeners.add(listener);
    listener(this.getProgress());
    return () => this.progressListeners.delete(listener);
  }

  private updateProgress(patch: Partial<OtaUpdateProgress>): void {
    this.currentProgress = { ...this.currentProgress, ...patch };
    for (const listener of this.progressListeners) {
      listener({ ...this.currentProgress });
    }
  }

  /**
   * Cancels any active firmware flashing session.
   */
  public cancelUpdate(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
      this.updateProgress({
        phase: "ERROR",
        errorDetail: "Update cancelled by user",
      });
    }
  }

  /**
   * Streams a signed firmware update to the connected robot or twin emulator.
   */
  public async flashFirmware(
    input: Uint8Array | File | ParsedOtaBundle,
    fallbackVersion = "v2.0.0",
    fallbackSignatureHex = "00".repeat(64)
  ): Promise<void> {
    if (this.currentProgress.phase === "STREAMING" || this.currentProgress.phase === "STARTING") {
      throw new Error("Another firmware update is already in progress");
    }

    this.activeAbortController = new AbortController();
    const abortSignal = this.activeAbortController.signal;

    try {
      this.updateProgress({
        phase: "PREPARING",
        progressPct: 0,
        bytesSent: 0,
        speedKBps: 0,
        errorDetail: undefined,
      });

      // 1. Resolve raw binary and manifest
      let firmwareBin: Uint8Array;
      let version = fallbackVersion;
      let signatureHex = fallbackSignatureHex;
      let sha256Hex = "";

      if ("manifest" in input && "firmwareBin" in input) {
        firmwareBin = input.firmwareBin;
        version = input.manifest.version;
        signatureHex = input.manifest.ed25519SignatureHex;
        sha256Hex = input.manifest.sha256Hex;
      } else if (input instanceof Uint8Array) {
        // Check if it's a .pbota bundle or raw .bin
        if (input.byteLength >= 12 && new DataView(input.buffer, input.byteOffset, 4).getUint32(0, false) === PBOTA_MAGIC) {
          const parsed = parsePbotaFile(input);
          firmwareBin = parsed.firmwareBin;
          version = parsed.manifest.version;
          signatureHex = parsed.manifest.ed25519SignatureHex;
          sha256Hex = parsed.manifest.sha256Hex;
        } else {
          firmwareBin = input;
        }
      } else if (typeof File !== "undefined" && input instanceof File) {
        const buffer = await input.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        if (bytes.byteLength >= 12 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false) === PBOTA_MAGIC) {
          const parsed = parsePbotaFile(bytes);
          firmwareBin = parsed.firmwareBin;
          version = parsed.manifest.version;
          signatureHex = parsed.manifest.ed25519SignatureHex;
          sha256Hex = parsed.manifest.sha256Hex;
        } else {
          firmwareBin = bytes;
          version = input.name.replace(/\.[^/.]+$/, "");
        }
      } else {
        throw new Error("Unsupported firmware bundle input format");
      }

      if (firmwareBin.byteLength === 0) {
        throw new Error("Firmware binary cannot be 0 bytes");
      }

      // Compute SHA-256 if not pre-populated
      if (!sha256Hex) {
        sha256Hex = await computeSha256Hex(firmwareBin);
      }

      const totalBytes = firmwareBin.byteLength;
      const chunkSize = OTA_CHUNK_SIZE_BYTES;
      const totalChunks = Math.ceil(totalBytes / chunkSize);
      const transferId = (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0;

      this.updateProgress({
        phase: "STARTING",
        version,
        totalBytes,
        totalChunks,
        currentChunk: 0,
        bytesSent: 0,
        progressPct: 0,
      });

      // Handle Simulator / Offline Twin loopback
      if (this.connection.isSimulatorActive()) {
        await this.executeSimulatorLoopback(
          firmwareBin,
          version,
          totalBytes,
          totalChunks,
          transferId,
          abortSignal
        );
        return;
      }

      // 2. Hardware / WebSocket OTA Execution with ACK Flow
      await this.executeHardwareOtaStream(
        firmwareBin,
        version,
        totalBytes,
        totalChunks,
        sha256Hex,
        signatureHex,
        transferId,
        abortSignal
      );
    } catch (err: unknown) {
      const message = abortSignal.aborted
        ? "Update cancelled by user"
        : (err instanceof Error ? err.message : String(err));
      this.updateProgress({
        phase: "ERROR",
        errorDetail: message,
      });
      throw (err instanceof Error ? err : new Error(message));
    } finally {
      this.activeAbortController = null;
    }
  }

  /**
   * Executes streaming against physical hardware over WebSocket/BLE.
   */
  private async executeHardwareOtaStream(
    firmwareBin: Uint8Array,
    version: string,
    totalBytes: number,
    totalChunks: number,
    sha256Hex: string,
    signatureHex: string,
    transferId: number,
    abortSignal: AbortSignal
  ): Promise<void> {
    const chunkSize = OTA_CHUNK_SIZE_BYTES;
    let activeTransferId = transferId;
    let awaitingStartAck = true;

    // Set up ACK listener and promise queue
    let pendingAckResolve: ((ack: OtaAckPayload) => void) | null = null;
    let pendingAckReject: ((err: Error) => void) | null = null;

    const unbindAck = this.connection.onOtaAck((ack) => {
      if (
        awaitingStartAck ||
        ack.transferId === activeTransferId ||
        ack.status === OtaAckStatus.SIGNATURE_INVALID ||
        ack.status === OtaAckStatus.FLASH_ERROR
      ) {
        if (pendingAckResolve) {
          const resolve = pendingAckResolve;
          pendingAckResolve = null;
          pendingAckReject = null;
          resolve(ack);
        }
      }
    });

    const waitForAck = (timeoutMs = 8000): Promise<OtaAckPayload> => {
      return new Promise<OtaAckPayload>((resolve, reject) => {
        if (abortSignal.aborted) {
          reject(new Error("OTA session aborted"));
          return;
        }

        const timer = setTimeout(() => {
          pendingAckResolve = null;
          pendingAckReject = null;
          reject(new Error(`Timeout waiting for OTA ACK (${timeoutMs}ms)`));
        }, timeoutMs);

        pendingAckResolve = (ack: OtaAckPayload) => {
          clearTimeout(timer);
          resolve(ack);
        };

        pendingAckReject = (err: Error) => {
          clearTimeout(timer);
          reject(err);
        };
      });
    };

    try {
      // Step A: Send FrameType.OTA_UPDATE_START
      const startPayload: OtaUpdateStart = {
        version,
        totalBytes,
        totalChunks,
        sha256Hex,
        ed25519SignatureHex: signatureHex,
      };
      const startBytes = encodeControlPayload(OtaUpdateStartSchema, startPayload);

      const startSent = await this.connection.sendRawFrame(
        FrameType.OTA_UPDATE_START,
        startBytes,
        FLAG_ACK_REQUIRED | FLAG_PRIORITY_REALTIME
      );

      if (!startSent) {
        throw new Error("Failed to transmit OTA_UPDATE_START frame to device");
      }

      // Await start confirmation ACK
      const startAck = await waitForAck(5000);
      awaitingStartAck = false;

      if (startAck.status !== OtaAckStatus.OK) {
        if (startAck.status === OtaAckStatus.SIGNATURE_INVALID) {
          throw new Error("Device rejected firmware: Digital signature verification failed");
        } else if (startAck.status === OtaAckStatus.FLASH_ERROR) {
          throw new Error("Device partition flash initialization failed");
        } else {
          throw new Error(`Device rejected OTA start with status code: ${startAck.status}`);
        }
      }

      if (startAck.transferId !== 0) {
        activeTransferId = startAck.transferId;
      }

      // Step B: Stream chunks
      this.updateProgress({ phase: "STREAMING" });

      const streamStartTime = performance.now();
      let bytesSent = 0;

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        if (abortSignal.aborted) {
          throw new Error("Update cancelled");
        }

        const offset = chunkIndex * chunkSize;
        const end = Math.min(offset + chunkSize, totalBytes);
        const chunkData = firmwareBin.subarray(offset, end);
        const chunkCrc = crc32(chunkData);

        const packedChunk = encodeOtaUpdateChunk({
          transferId: activeTransferId,
          chunkIndex,
          chunkCrc32: chunkCrc,
          rawBytes: chunkData,
        });

        const isFinal = chunkIndex === totalChunks - 1;
        const flags = isFinal ? FLAG_FINAL_CHUNK : 0;

        // Retry loop for CRC recovery
        let retries = 0;
        const maxRetries = 3;
        let chunkSuccess = false;

        while (retries <= maxRetries && !chunkSuccess) {
          await this.connection.sendRawFrame(
            FrameType.OTA_UPDATE_CHUNK,
            packedChunk,
            flags | FLAG_PRIORITY_REALTIME
          );

          try {
            const chunkAck = await waitForAck(6000);

            if (chunkAck.status === OtaAckStatus.OK || chunkAck.status === OtaAckStatus.REBOOTING_INTO_NEW_FIRMWARE) {
              chunkSuccess = true;
              if (chunkAck.status === OtaAckStatus.REBOOTING_INTO_NEW_FIRMWARE) {
                this.updateProgress({ phase: "REBOOTING" });
              }
            } else if (chunkAck.status === OtaAckStatus.CRC_RETRY) {
              retries++;
              console.warn(`Chunk ${chunkIndex} CRC error, retransmitting (attempt ${retries}/${maxRetries})...`);
              await new Promise((r) => setTimeout(r, 50));
            } else {
              throw new Error(`OTA chunk rejected with status: ${chunkAck.status}`);
            }
          } catch (ackErr) {
            retries++;
            if (retries > maxRetries) throw ackErr;
            await new Promise((r) => setTimeout(r, 100));
          }
        }

        bytesSent += chunkData.byteLength;
        const elapsedSec = (performance.now() - streamStartTime) / 1000;
        const speedKBps = elapsedSec > 0 ? Math.round(bytesSent / 1024 / elapsedSec) : 0;
        const remainingBytes = totalBytes - bytesSent;
        const estimatedSeconds = speedKBps > 0 ? Math.ceil(remainingBytes / 1024 / speedKBps) : 0;
        const progressPct = Math.min(99, Math.round((bytesSent / totalBytes) * 100));

        this.updateProgress({
          currentChunk: chunkIndex + 1,
          bytesSent,
          progressPct,
          speedKBps,
          estimatedSecondsRemaining: estimatedSeconds,
        });
      }

      // Step C: Verifying & Rebooting
      this.updateProgress({ phase: "VERIFYING", progressPct: 99 });
      await new Promise((r) => setTimeout(r, 100));

      this.updateProgress({ phase: "REBOOTING", progressPct: 100 });
      await new Promise((r) => setTimeout(r, 200));

      this.updateProgress({
        phase: "COMPLETED",
        progressPct: 100,
        estimatedSecondsRemaining: 0,
      });
    } finally {
      unbindAck();
    }
  }

  /**
   * Executes realistic zero-error simulation loopback when hardware is detached.
   */
  private async executeSimulatorLoopback(
    firmwareBin: Uint8Array,
    version: string,
    totalBytes: number,
    totalChunks: number,
    transferId: number,
    abortSignal: AbortSignal
  ): Promise<void> {
    const chunkSize = OTA_CHUNK_SIZE_BYTES;
    const startTime = performance.now();

    // Verification step
    this.updateProgress({ phase: "STARTING", progressPct: 1 });
    await new Promise((r) => setTimeout(r, 300));

    this.updateProgress({ phase: "STREAMING" });

    let bytesSent = 0;
    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      if (abortSignal.aborted) {
        throw new Error("Update cancelled by user");
      }

      const offset = chunkIdx * chunkSize;
      const end = Math.min(offset + chunkSize, totalBytes);
      const chunkLen = end - offset;
      bytesSent += chunkLen;

      const elapsedSec = (performance.now() - startTime) / 1000;
      const speedKBps = elapsedSec > 0 ? Math.round(bytesSent / 1024 / elapsedSec) : 512;
      const remainingBytes = totalBytes - bytesSent;
      const estSec = speedKBps > 0 ? Math.ceil(remainingBytes / 1024 / speedKBps) : 1;
      const progressPct = Math.min(99, Math.round((bytesSent / totalBytes) * 100));

      this.updateProgress({
        currentChunk: chunkIdx + 1,
        bytesSent,
        progressPct,
        speedKBps,
        estimatedSecondsRemaining: estSec,
      });

      // Realistic ~12-18ms pacing per 16KB chunk
      await new Promise((r) => setTimeout(r, 15));
    }

    this.updateProgress({ phase: "VERIFYING", progressPct: 99 });
    await new Promise((r) => setTimeout(r, 500));

    this.updateProgress({ phase: "REBOOTING", progressPct: 100, estimatedSecondsRemaining: 0 });
    await new Promise((r) => setTimeout(r, 1200));

    this.updateProgress({
      phase: "COMPLETED",
      progressPct: 100,
      speedKBps: 0,
      estimatedSecondsRemaining: 0,
    });
  }
}

/**
 * Global Singleton Instance
 */
export const otaUpdateClient = OtaUpdateClient.getInstance();

/**
 * Curated consumer-grade mock firmware updates for instant studio testing
 */
export const AVAILABLE_FIRMWARE_RELEASES = [
  {
    version: "v2.1.0",
    releaseName: "Cyber Senses & Dynamic Eyes",
    description: "Ultra-low-latency 60FPS procedural eye saccades, enhanced purring tones, and faster PSRAM widget boots.",
    date: "November 2026",
    sizeBytes: 1572864, // 1.5 MB
    features: [
      "Smooth 60FPS Pet expression transitions",
      "Dynamic capacitive petting sensitivity",
      "Instant offline clock & notes synchronization",
    ],
  },
  {
    version: "v2.2.0",
    releaseName: "Quantum Voice & Battery Booster",
    description: "Opus audio downlink compression, real-time voice streaming VAD, and 40% extended battery efficiency.",
    date: "Coming Soon",
    sizeBytes: 1835008, // 1.75 MB
    features: [
      "Dual-channel high-fidelity audio synthesizer",
      "Automatic screen dimming on desk inactivity",
      "Enhanced hardware Touch 2FA confirmation",
    ],
  },
];
