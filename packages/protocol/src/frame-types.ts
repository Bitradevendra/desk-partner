import { z } from "zod";

/**
 * ============================================================================
 * Unified Communication Protocol: Binary Frame Envelope & Frame Types
 * Optimized for Xtensa LX7 (ESP32-S3) Little-Endian direct struct casting.
 * ============================================================================
 */

export const FRAME_MAGIC = 0x4250 as const; // Little-Endian: Byte 0 = 'P' (0x50), Byte 1 = 'B' (0x42)
export const FRAME_VERSION = 0x01 as const;
export const FRAME_HEADER_SIZE = 12 as const;
export const FRAME_TRAILER_SIZE = 4 as const; // 4-byte CRC32
export const FRAME_OVERHEAD_SIZE = (FRAME_HEADER_SIZE + FRAME_TRAILER_SIZE) as 16; // 16 bytes

// --- Frame Flags Bitmask & Enum ---
export const FLAG_NONE = 0x00 as const;
export const FLAG_ACK_REQUIRED = 0x01 as const;
export const FLAG_COMPRESSED = 0x02 as const;
export const FLAG_ENCRYPTED = 0x04 as const;
export const FLAG_FINAL_CHUNK = 0x08 as const;
export const FLAG_PRIORITY_REALTIME = 0x10 as const;

export enum FrameFlags {
  NONE = 0x00,
  ACK_REQUIRED = 0x01,
  COMPRESSED = 0x02,
  ENCRYPTED = 0x04,
  FINAL_CHUNK = 0x08,
  PRIORITY_REALTIME = 0x10,
}

/**
 * 12-byte packed Little-Endian Binary Frame Header:
 * 
 * Offset | Size | Type   | Field
 * -------|------|--------|-------------
 * 0      | 2    | uint16 | Magic (0x4250 -> 'P','B')
 * 2      | 1    | uint8  | Protocol Version (0x01)
 * 3      | 1    | uint8  | Frame Type (FrameType enum)
 * 4      | 1    | uint8  | Flags Bitmask (FrameFlags)
 * 5      | 1    | uint8  | Reserved (0x00 for 4-byte boundary alignment)
 * 6      | 2    | uint16 | Sequence ID (Rolling uint16)
 * 8      | 4    | uint32 | Payload Byte Length
 * 
 * Followed immediately by:
 * 12     | N    | bytes  | Payload (payloadLen bytes)
 * 12+N   | 4    | uint32 | IEEE 802.3 CRC32 (Header + Payload)
 */
export interface PetBotFrameHeader {
  readonly magic: number;
  readonly version: number;
  readonly frameType: FrameType;
  readonly flags: number;
  readonly reserved: number;
  readonly seqId: number;
  readonly payloadLen: number;
}

export interface DecodedFrame {
  readonly header: PetBotFrameHeader;
  /** Zero-copy subview of payload bytes */
  readonly payload: Uint8Array;
  readonly crc32: number;
}

/**
 * Single-byte opcode enumerating every real-time stream and control frame.
 */
export enum FrameType {
  // Handshake and Connection Management
  HELLO_HANDSHAKE = 0x01,
  MODE_TRANSITION = 0x02,
  HEARTBEAT_PING = 0x03,
  HEARTBEAT_PONG = 0x04,

  // Real-time Audio Streaming & Expression Sync
  AUDIO_UPLINK_FRAME = 0x10,
  AUDIO_DOWNLINK_FRAME = 0x11,

  // SD Vault File Transfers ("Send & Collect")
  SD_VAULT_START = 0x20,
  SD_VAULT_CHUNK = 0x21,
  SD_VAULT_ACK = 0x22,
  SD_VAULT_LIST_REQ = 0x23,
  SD_VAULT_LIST_RES = 0x24,

  // Widget Deployment
  WIDGET_DEPLOY = 0x30,

  // Desktop Harness Telemetry & RPC
  HARNESS_RPC_REQ = 0x40,
  HARNESS_RPC_RES = 0x41,

  // Hardware Touch 2FA Security
  TOUCH_2FA_CHALLENGE = 0x50,
  TOUCH_2FA_RESPONSE = 0x51,

  // Cloud AI Entitlements & Persona Licensing
  SUBSCRIPTION_ENTITLEMENT_SYNC = 0x60,

  // Signed Over-The-Air (OTA) Dual-Partition Firmware Updates
  OTA_UPDATE_START = 0x70,
  OTA_UPDATE_CHUNK = 0x71,
  OTA_UPDATE_ACK = 0x72,
}

// --- Standard Enums for ESP32-S3 Firmware & Protocol ---

export enum RobotMode {
  NORMAL_OFFLINE = 0,
  AGENTIC_CONNECTED = 1,
}

export enum EmotionId {
  IDLE = 0x00,
  HAPPY = 0x01,
  CURIOUS = 0x02,
  SLEEPY = 0x03,
  FOCUSED = 0x04,
  SPEAKING = 0x05,
  LISTENING = 0x06,
  ALERT = 0x07,
}

export enum RiskTier {
  TIER_1_SAFE = 0x01,
  TIER_2_WORKFLOW = 0x02,
  TIER_3_2FA_REQUIRED = 0x03,
}

export enum Touch2FADecision {
  APPROVED_SINGLE_TAP = 0x01,
  DENIED_LONG_PRESS = 0x02,
  TIMEOUT = 0x03,
}

export enum AudioCodec {
  PCM16 = 0x00,
  OPUS = 0x01,
}

// --- Specialized Hot-Path Binary Frame Layouts ---

/**
 * 0x11 AUDIO_DOWNLINK_FRAME (Cloud/Host -> ESP32 I2S Speaker + Display)
 * 8-byte packed binary subheader + raw audio PCM/Opus:
 * Offset 0: emotionId (uint8, EmotionId enum)
 * Offset 1: visemeMouthOpen (uint8, 0..255)
 * Offset 2: eyeGazeX (int8, -128..127)
 * Offset 3: eyeGazeY (int8, -128..127)
 * Offset 4: audioCodec (uint8, AudioCodec enum)
 * Offset 5: flags (uint8 bitmask)
 * Offset 6: audioByteLen (uint16 LE)
 * Offset 8..N: audioData
 */
export const AUDIO_DOWNLINK_HEADER_SIZE = 8 as const;

export interface AudioDownlinkHeader {
  readonly emotionId: number;
  readonly visemeMouthOpen: number;
  readonly eyeGazeX: number;
  readonly eyeGazeY: number;
  readonly audioCodec: number;
  readonly flags: number;
  readonly audioByteLen: number;
}

export interface AudioDownlinkFrame {
  readonly header: AudioDownlinkHeader;
  readonly emotionId: number;
  readonly visemeMouthOpenness: number;
  readonly visemeMouthOpen: number;
  readonly eyeGazeX: number;
  readonly eyeGazeY: number;
  readonly audioCodec: number;
  readonly flags: number;
  readonly audioByteLen: number;
  /** Zero-copy subview into audio bytes */
  readonly audioData: Uint8Array;
}

/**
 * 0x10 AUDIO_UPLINK_FRAME (ESP32 I2S Mic -> Host/Cloud)
 * 6-byte packed binary subheader + raw audio PCM/Opus:
 * Offset 0: rmsEnergy (uint16 LE, 0..65535)
 * Offset 2: vadActive (uint8, 0 or 1)
 * Offset 3: codec (uint8, AudioCodec enum)
 * Offset 4: sampleCount (uint16 LE, e.g. 320 for 20ms @ 16kHz)
 * Offset 6..N: audioData
 */
export const AUDIO_UPLINK_HEADER_SIZE = 6 as const;

export interface AudioUplinkHeader {
  readonly rmsEnergy: number;
  readonly vadActive: boolean;
  readonly codec: number;
  readonly sampleCount: number;
}

export interface AudioUplinkFrame {
  readonly header: AudioUplinkHeader;
  readonly vadActive: boolean;
  readonly rmsEnergy: number;
  readonly codec: number;
  readonly sampleCount: number;
  /** Zero-copy subview into audio bytes */
  readonly audioData: Uint8Array;
}

/**
 * 0x21 SD_VAULT_CHUNK (12-byte subheader + chunk payload up to 16KB)
 * Offset 0: transferId (uint32 LE)
 * Offset 4: chunkIndex (uint32 LE)
 * Offset 8: chunkCrc32 (uint32 LE)
 * Offset 12..N: rawBytes
 */
export const SD_CHUNK_HEADER_SIZE = 12 as const;

export interface SdVaultChunkHeader {
  readonly transferId: number;
  readonly chunkIndex: number;
  readonly chunkCrc32: number;
}

export interface SdVaultChunk {
  readonly header: SdVaultChunkHeader;
  readonly transferId: number;
  readonly chunkIndex: number;
  readonly chunkCrc32: number;
  /** Zero-copy subview into chunk bytes */
  readonly rawBytes: Uint8Array;
}

export enum SdVaultStatus {
  OK = 0,
  CRC_MISMATCH_RETRY = 1,
  DISK_FULL = 2,
  COMPLETED = 3,
}

export interface SdVaultAck {
  readonly transferId: number;
  readonly nextExpectedChunk: number;
  readonly status: SdVaultStatus;
}

/**
 * 0x71 OTA_UPDATE_CHUNK (Companion / Host -> ESP32-S3 Flash Writer)
 * 12-byte packed binary subheader + raw chunk bytes:
 * Offset 0: transferId (uint32 LE)
 * Offset 4: chunkIndex (uint32 LE)
 * Offset 8: chunkCrc32 (uint32 LE, IEEE 802.3 CRC32 of raw chunk)
 * Offset 12..N: rawBytes
 */
export const OTA_CHUNK_HEADER_SIZE = 12 as const;

export interface OtaChunkHeader {
  readonly transferId: number;
  readonly chunkIndex: number;
  readonly chunkCrc32: number;
}

export interface OtaChunk {
  readonly header: OtaChunkHeader;
  readonly transferId: number;
  readonly chunkIndex: number;
  readonly chunkCrc32: number;
  /** Zero-copy subview into chunk bytes */
  readonly rawBytes: Uint8Array;
}

/**
 * 0x72 OTA_UPDATE_ACK (ESP32-S3 Flash Writer -> Companion / Host)
 * 10-byte packed binary acknowledgement payload:
 * Offset 0: transferId (uint32 LE)
 * Offset 4: nextExpectedChunk (uint32 LE)
 * Offset 8: progressPct (uint8, 0..100)
 * Offset 9: status (uint8, OtaAckStatus)
 */
export const OTA_ACK_PAYLOAD_SIZE = 10 as const;

export enum OtaAckStatus {
  OK = 0,
  CRC_RETRY = 1,
  SIGNATURE_INVALID = 2,
  FLASH_ERROR = 3,
  REBOOTING_INTO_NEW_FIRMWARE = 4,
}

export interface OtaAckPayload {
  readonly transferId: number;
  readonly nextExpectedChunk: number;
  readonly progressPct: number;
  readonly status: OtaAckStatus;
}

/**
 * 16-byte packed BLE Presence & Discovery Beacon Payload
 * Offset 0: magic (uint16 LE, 0x4250)
 * Offset 2: deviceIdHash (uint32 LE)
 * Offset 6: mode (uint8, RobotMode)
 * Offset 7: batteryPct (uint8, 0..100)
 * Offset 8: ipv4 (4 bytes)
 * Offset 12: wsPort (uint16 LE)
 * Offset 14: flags (uint16 LE)
 */
export const BLE_BEACON_PAYLOAD_SIZE = 16 as const;

export interface BleAdvBeaconPayload {
  readonly magic: number;
  readonly deviceIdHash: number;
  readonly mode: RobotMode;
  readonly batteryPct: number;
  readonly ipv4: Uint8Array; // 4 octets
  readonly wsPort: number;
  readonly flags: number;
}

// --- Control Plane MessagePack Payloads (Zod Schemas) ---

export const HelloHandshakeSchema = z.object({
  deviceId: z.string().min(1).max(64),
  firmwareVersion: z.string().min(1).max(32),
  psramFreeBytes: z.number().int().nonnegative(),
  sdCardCapacityBytes: z.number().nonnegative(),
  sdCardFreeBytes: z.number().nonnegative(),
  ed25519PublicKeyHex: z.string().length(64),
  capabilities: z.array(z.string()),
});
export type HelloHandshake = z.infer<typeof HelloHandshakeSchema>;

export const ModeTransitionSchema = z.object({
  targetMode: z.nativeEnum(RobotMode),
  companionHost: z.string().min(1).max(128),
  companionPort: z.number().int().min(1).max(65535),
  transitionReason: z.string().max(64),
});
export type ModeTransition = z.infer<typeof ModeTransitionSchema>;

export const HeartbeatPayloadSchema = z.object({
  timestampUs: z.number().nonnegative(),
  batteryPercent: z.number().int().min(0).max(100),
  wifiRssi: z.number().int().min(-128).max(0),
});
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

export const SdVaultDirectionSchema = z.enum(["PUSH_TO_ROBOT", "FETCH_FROM_ROBOT"]);
export type SdVaultDirection = z.infer<typeof SdVaultDirectionSchema>;

export const SdVaultStartSchema = z.object({
  fileId: z.string().min(1).max(64),
  path: z.string().min(1).max(256),
  totalBytes: z.number().int().positive(),
  totalChunks: z.number().int().positive(),
  sha256Hex: z.string().length(64),
  direction: SdVaultDirectionSchema,
  previewRgb565Thumbnail: z.instanceof(Uint8Array).optional(),
});
export type SdVaultStart = z.infer<typeof SdVaultStartSchema>;

export const SdVaultListReqSchema = z.object({
  directoryPath: z.string().min(1).max(256),
});
export type SdVaultListReq = z.infer<typeof SdVaultListReqSchema>;

export const SdVaultEntrySchema = z.object({
  name: z.string().min(1).max(64),
  isDirectory: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  modifiedTimestamp: z.number().int().nonnegative(),
});
export type SdVaultEntry = z.infer<typeof SdVaultEntrySchema>;

export const SdVaultListResSchema = z.object({
  directoryPath: z.string().min(1).max(256),
  entries: z.array(SdVaultEntrySchema),
});
export type SdVaultListRes = z.infer<typeof SdVaultListResSchema>;

export const Touch2FaRiskTierSchema = z.enum(["TIER_1_SAFE", "TIER_2_WORKFLOW", "TIER_3_2FA_REQUIRED"]);
export type Touch2FaRiskTier = z.infer<typeof Touch2FaRiskTierSchema>;

export const Touch2FaChallengeSchema = z.object({
  challengeId: z.string().min(1).max(64),
  actionTitle: z.string().min(1).max(64),
  riskTier: Touch2FaRiskTierSchema,
  expiresInMs: z.number().int().positive(),
  nonce: z.string().min(16).max(128),
});
export type Touch2FaChallenge = z.infer<typeof Touch2FaChallengeSchema>;

export const Touch2FaDecisionSchema = z.enum(["APPROVED_SINGLE_TAP", "DENIED_LONG_PRESS", "TIMEOUT"]);
export type Touch2FaDecision = z.infer<typeof Touch2FaDecisionSchema>;

export const Touch2FaResponseSchema = z.object({
  challengeId: z.string().min(1).max(64),
  decision: Touch2FaDecisionSchema,
  touchTimestampMs: z.number().int().positive(),
  signatureHex: z.string().length(128), // 64-byte Ed25519 signature as hex
});
export type Touch2FaResponse = z.infer<typeof Touch2FaResponseSchema>;

export const HarnessRpcReqSchema = z.object({
  callId: z.string().min(1).max(64),
  method: z.string().min(1).max(64),
  params: z.record(z.string(), z.any()),
});
export type HarnessRpcReq = z.infer<typeof HarnessRpcReqSchema>;

export const SystemTelemetrySchema = z.object({
  cpuPercent: z.number().min(0).max(100),
  ramPercent: z.number().min(0).max(100),
  gpuPercent: z.number().min(0).max(100).optional(),
  activeWindow: z.string().max(128).optional(),
  mediaState: z.string().max(64).optional(),
});
export type SystemTelemetry = z.infer<typeof SystemTelemetrySchema>;

export const HarnessRpcResSchema = z.object({
  callId: z.string().min(1).max(64),
  success: z.boolean(),
  result: z.record(z.string(), z.any()).optional(),
  error: z.string().max(256).optional(),
  systemTelemetry: SystemTelemetrySchema.optional(),
});
export type HarnessRpcRes = z.infer<typeof HarnessRpcResSchema>;

export const SubscriptionTierSchema = z.enum(["FREE", "PRO", "ULTRA_AI"]);
export type SubscriptionTier = z.infer<typeof SubscriptionTierSchema>;

export const SubscriptionEntitlementSyncSchema = z.object({
  jwtToken: z.string().min(10),
  tier: SubscriptionTierSchema,
  expiresAt: z.number().int().positive(),
  enabledPersonas: z.array(z.string()),
});
export type SubscriptionEntitlementSync = z.infer<typeof SubscriptionEntitlementSyncSchema>;

export const OtaUpdateStartSchema = z.object({
  version: z.string().min(1).max(32),
  totalBytes: z.number().int().positive(),
  totalChunks: z.number().int().positive(),
  sha256Hex: z.string().length(64),
  ed25519SignatureHex: z.string().length(128),
});
export type OtaUpdateStart = z.infer<typeof OtaUpdateStartSchema>;

export const OtaAckStatusStringSchema = z.enum([
  "OK",
  "CRC_RETRY",
  "SIGNATURE_INVALID",
  "FLASH_ERROR",
  "REBOOTING_INTO_NEW_FIRMWARE",
]);
export type OtaAckStatusString = z.infer<typeof OtaAckStatusStringSchema>;

export const OtaUpdateAckSchema = z.object({
  transferId: z.number().int().nonnegative(),
  nextExpectedChunk: z.number().int().nonnegative(),
  progressPct: z.number().int().min(0).max(100),
  status: z.union([
    z.nativeEnum(OtaAckStatus),
    OtaAckStatusStringSchema,
  ]),
});
export type OtaUpdateAck = z.infer<typeof OtaUpdateAckSchema>;
