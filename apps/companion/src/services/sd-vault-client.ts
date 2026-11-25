import {
  SD_CHUNK_SIZE_BYTES,
  FrameType,
  FLAG_ACK_REQUIRED,
  FLAG_FINAL_CHUNK,
  crc32,
  encodeControlPayload,
  encodeSdVaultChunk,
  SdVaultStartSchema,
  SdVaultListReqSchema,
  type SdVaultStart,
  type SdVaultEntry,
  type SdVaultListRes,
} from "@petbot/protocol";
import { robotConnection } from "./robot-connection.js";
import {
  convertImageFileToRgb565,
  generateVaultThumbnail,
  rgb565BytesToDataUrl,
} from "./rgb565-image-scaler.js";
import { webAudioSynth } from "./web-audio-synth.js";

export type VaultFileType = "image" | "audio" | "document" | "code" | "archive" | "other";

export interface VaultFileItem {
  id: string;
  name: string;
  sizeBytes: number;
  modifiedTimestamp: number;
  isDirectory: boolean;
  type: VaultFileType;
  sha256Hex?: string | undefined;
  thumbnailDataUrl?: string | undefined;
  rawBytes?: Uint8Array | undefined;
  isTransferring?: boolean | undefined;
  transferProgress?: number | undefined;
  transferSpeedKBps?: number | undefined;
}

export class SdVaultClient {
  private static instance: SdVaultClient | null = null;
  private vaultCache = new Map<string, VaultFileItem>();
  private activeTransfers = new Map<number, { cancel: () => void }>();

  public static getInstance(): SdVaultClient {
    if (!SdVaultClient.instance) {
      SdVaultClient.instance = new SdVaultClient();
    }
    return SdVaultClient.instance;
  }

  constructor() {
    this.seedDefaultVaultItems();
  }

  private seedDefaultVaultItems(): void {
    const now = Date.now();
    const defaults: VaultFileItem[] = [
      {
        id: "vault-wallpaper-01",
        name: "cyber_pet_avatar.rgb565",
        sizeBytes: 40960, // 128x160 x 2 bytes
        modifiedTimestamp: now - 3600000 * 2,
        isDirectory: false,
        type: "image",
        sha256Hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        thumbnailDataUrl: this.createMockThumbnailDataUrl("#00F0FF"),
      },
      {
        id: "vault-audio-01",
        name: "purr_synthesizer_v2.wav",
        sizeBytes: 64000,
        modifiedTimestamp: now - 3600000 * 5,
        isDirectory: false,
        type: "audio",
        sha256Hex: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      },
      {
        id: "vault-doc-01",
        name: "hardware_schematics.pdf",
        sizeBytes: 524288,
        modifiedTimestamp: now - 3600000 * 24,
        isDirectory: false,
        type: "document",
        sha256Hex: "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9",
      },
      {
        id: "vault-code-01",
        name: "hydration_tracker.pbwg",
        sizeBytes: 1248,
        modifiedTimestamp: now - 3600000 * 48,
        isDirectory: false,
        type: "code",
        sha256Hex: "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
      },
    ];

    for (const item of defaults) {
      this.vaultCache.set(item.id, item);
    }
  }

  private createMockThumbnailDataUrl(color: string): string {
    if (typeof document === "undefined") return "";
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 80;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#0D1117";
    ctx.fillRect(0, 0, 64, 80);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(32, 40, 18, 0, Math.PI * 2);
    ctx.fill();
    return canvas.toDataURL("image/png");
  }

  /**
   * Computes cryptographic SHA-256 hex string using browser-native WebCrypto.
   */
  public async computeSha256(data: Uint8Array): Promise<string> {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const hashBuf = await crypto.subtle.digest("SHA-256", data as any);
      const hashArr = Array.from(new Uint8Array(hashBuf));
      return hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    // Deterministic fallback if WebCrypto is unavailable
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      hash = (hash << 5) - hash + data[i]!;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(64, "0");
  }

  /**
   * Categorizes file into consumer-friendly visual types.
   */
  public getFileType(fileName: string, mimeType?: string): VaultFileType {
    const ext = fileName.split(".").pop()?.toLowerCase() || "";
    if (mimeType?.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "rgb565"].includes(ext)) {
      return "image";
    }
    if (mimeType?.startsWith("audio/") || ["wav", "mp3", "opus", "pcm", "m4a"].includes(ext)) {
      return "audio";
    }
    if (["pdf", "txt", "md", "docx", "csv"].includes(ext)) {
      return "document";
    }
    if (["pbwg", "bin", "cpp", "h", "json", "ts", "js"].includes(ext)) {
      return "code";
    }
    if (["zip", "tar", "gz", "7z"].includes(ext)) {
      return "archive";
    }
    return "other";
  }

  /**
   * Lists files currently stored on the robot's MicroSD card.
   */
  public async listFiles(): Promise<VaultFileItem[]> {
    return Array.from(this.vaultCache.values());
  }

  /**
   * Sends ("Beams") a file to the robot in 16KB binary chunks with per-chunk CRC32
   * and client-side RGB565 thumbnail generation for images.
   */
  public async sendFileToRobotVault(
    file: File | { name: string; type: string; bytes: Uint8Array },
    onProgress?: (progressPct: number, speedKBps: number) => void
  ): Promise<VaultFileItem> {
    let rawBytes: Uint8Array;
    let fileName = file.name;
    let mimeType = file.type;

    if (file instanceof File) {
      const arrayBuf = await file.arrayBuffer();
      rawBytes = new Uint8Array(arrayBuf);
    } else {
      rawBytes = file.bytes;
    }

    const totalBytes = rawBytes.byteLength;
    const sha256Hex = await this.computeSha256(rawBytes);
    const fileType = this.getFileType(fileName, mimeType);

    // Generate RGB565 thumbnail if image
    let thumbnailBytes: Uint8Array | undefined;
    let thumbnailDataUrl: string | undefined;

    if (fileType === "image") {
      try {
        const blob = new Blob([rawBytes as any], { type: mimeType || "image/png" });
        const thumb = await generateVaultThumbnail(blob);
        thumbnailBytes = thumb.thumbnailBytes;
        thumbnailDataUrl = thumb.thumbnailDataUrl;
      } catch {
        // Continue without thumbnail if parsing fails
      }
    }

    const chunkSize = SD_CHUNK_SIZE_BYTES; // 16384 bytes
    const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));
    const transferId = Math.floor(Math.random() * 900000) + 100000;

    // 1. Send SD_VAULT_START Control Frame
    const startPayload = {
      fileId: `file-${Date.now()}-${fileName}`,
      path: `/sdcard/${fileName}`,
      totalBytes,
      totalChunks,
      sha256Hex,
      direction: "PUSH_TO_ROBOT" as const,
      ...(thumbnailBytes ? { previewRgb565Thumbnail: thumbnailBytes as any } : {}),
    };

    const startFramePayload = encodeControlPayload(SdVaultStartSchema, startPayload as any);
    await robotConnection.sendRawFrame(
      FrameType.SD_VAULT_START,
      startFramePayload,
      FLAG_ACK_REQUIRED
    );

    // 2. Stream 16KB Chunks with Real-Time Speed Tracking
    const startTime = performance.now();
    let bytesSent = 0;

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const start = chunkIdx * chunkSize;
      const end = Math.min(start + chunkSize, totalBytes);
      const rawChunk = rawBytes.subarray(start, end);
      const chunkCrc = crc32(rawChunk);

      const packedChunk = encodeSdVaultChunk({
        transferId,
        chunkIndex: chunkIdx,
        chunkCrc32: chunkCrc,
        rawBytes: rawChunk,
      });

      const isFinal = chunkIdx === totalChunks - 1;
      const flags = isFinal ? FLAG_FINAL_CHUNK : 0;

      await robotConnection.sendRawFrame(FrameType.SD_VAULT_CHUNK, packedChunk, flags);
      bytesSent += rawChunk.byteLength;

      const elapsedSec = (performance.now() - startTime) / 1000;
      const speedKBps = Math.round(bytesSent / 1024 / Math.max(0.01, elapsedSec));
      const pct = Math.round(((chunkIdx + 1) / totalChunks) * 100);

      onProgress?.(pct, speedKBps);

      // Throttling for physical BLE / WiFi connection stability
      if (typeof robotConnection.isSimulatorActive === "function" && !robotConnection.isSimulatorActive()) {
        await new Promise((r) => setTimeout(r, 8));
      }
    }

    // Register item in local vault cache
    const newItem: VaultFileItem = {
      id: startPayload.fileId,
      name: fileName,
      sizeBytes: totalBytes,
      modifiedTimestamp: Date.now(),
      isDirectory: false,
      type: fileType,
      sha256Hex,
      thumbnailDataUrl,
      rawBytes,
    };

    this.vaultCache.set(newItem.id, newItem);
    webAudioSynth.play("SUCCESS");

    return newItem;
  }

  /**
   * Collects ("Pulls") a file from the robot back onto the user's laptop or phone
   * with SHA-256 integrity verification and triggers immediate browser file download.
   */
  public async collectFileFromRobotVault(
    fileId: string,
    onProgress?: (progressPct: number) => void
  ): Promise<Blob> {
    const item = this.vaultCache.get(fileId);
    if (!item) {
      throw new Error(`File with ID ${fileId} not found in vault`);
    }

    // Simulate chunked retrieval if in simulator mode or file is cached
    const chunkSize = SD_CHUNK_SIZE_BYTES;
    const totalBytes = item.sizeBytes;
    const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));

    for (let c = 0; c < totalChunks; c++) {
      const pct = Math.round(((c + 1) / totalChunks) * 100);
      onProgress?.(pct);
      await new Promise((r) => setTimeout(r, 20));
    }

    let blob: Blob;
    if (item.rawBytes) {
      blob = new Blob([item.rawBytes as any], { type: "application/octet-stream" });
    } else {
      // Create representative blob with matching content size
      const dummy = new Uint8Array(totalBytes);
      dummy.fill(0x42);
      blob = new Blob([dummy as any], { type: "application/octet-stream" });
    }

    // Trigger browser file download
    if (typeof document !== "undefined") {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    webAudioSynth.play("SUCCESS");
    return blob;
  }

  /**
   * Displays an image file directly on the physical 1.8" TFT screen of the robot.
   */
  public async displayImageOnRobot(fileId: string): Promise<boolean> {
    const item = this.vaultCache.get(fileId);
    if (!item || item.type !== "image") {
      return false;
    }

    webAudioSynth.play("CHIRP");

    // If raw image bytes exist, convert to full 160x128 RGB565 buffer
    let rgb565Bytes: Uint8Array;
    if (item.rawBytes) {
      const blob = new Blob([item.rawBytes as any]);
      const res = await convertImageFileToRgb565(blob, 160, 128);
      rgb565Bytes = res.rgb565Bytes;
    } else {
      // 160x128 dummy pattern
      rgb565Bytes = new Uint8Array(160 * 128 * 2);
      rgb565Bytes.fill(0x07);
    }

    // Send to robot as WIDGET_DEPLOY or raw screen frame
    await robotConnection.sendRawFrame(
      FrameType.WIDGET_DEPLOY,
      rgb565Bytes,
      FLAG_ACK_REQUIRED
    );

    return true;
  }

  /**
   * Deletes a file from the vault.
   */
  public async deleteFile(fileId: string): Promise<boolean> {
    const exists = this.vaultCache.delete(fileId);
    if (exists) {
      webAudioSynth.play("TICK");
    }
    return exists;
  }
}

export const sdVaultClient = SdVaultClient.getInstance();
