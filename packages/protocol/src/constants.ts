/**
 * High-Performance ESP32-S3 AI Desktop Pet Robot System Constants
 * 
 * Shared hardware, real-time audio/video buffers, and networking boundaries
 * across C++20 firmware, Node.js gateway, and companion applications.
 */

// --- Display Subsystem (160x128 Landscape RGB565 ST7735S / ST7789 SPI LCD) ---
export const DISPLAY_WIDTH = 160 as const;
export const DISPLAY_HEIGHT = 128 as const;
export const DISPLAY_BPP = 16 as const;
export const DISPLAY_TOTAL_PIXELS: number = DISPLAY_WIDTH * DISPLAY_HEIGHT; // 20,480 pixels
export const DISPLAY_BUFFER_BYTES: number = DISPLAY_TOTAL_PIXELS * (DISPLAY_BPP / 8); // 40,960 bytes

// --- Audio Subsystem (I2S Microphone INMP441 / Speaker MAX98357A) ---
export const AUDIO_SAMPLE_RATE_HZ = 16000 as const;
export const AUDIO_FRAME_DURATION_MS = 20 as const;
export const AUDIO_SAMPLES_PER_FRAME = 320 as const;
export const AUDIO_BYTES_PER_SAMPLE = 2 as const; // 16-bit linear PCM
export const AUDIO_CHANNELS = 1 as const; // Mono
export const AUDIO_FRAME_BYTES: number = AUDIO_SAMPLES_PER_FRAME * AUDIO_BYTES_PER_SAMPLE * AUDIO_CHANNELS; // 640 bytes

// --- Real-time Networking & Storage Boundaries ---
export const MAX_WS_PAYLOAD_BYTES = 65536 as const; // 64 KiB ceiling for fast zero-copy ringbuffers
export const SD_CHUNK_SIZE_BYTES = 16384 as const; // 16 KiB optimal block read/write for SD-MMC 4-bit bus
export const OTA_CHUNK_SIZE_BYTES = 16384 as const; // 16 KiB chunk streaming for dual-partition OTA flash
export const BLE_MTU_SAFE_BYTES = 244 as const; // 247 MTU - 3 byte ATT header
export const MDNS_SERVICE_NAME = "_petbot._tcp.local" as const;
export const DEFAULT_WS_PORT = 8443 as const;

// --- Binary Framing Protocol ---
export const PROTOCOL_MAGIC = 0x50455431 as const; // ASCII: 'P', 'E', 'T', '1'
export const PROTOCOL_VERSION = 1 as const;
export const BINARY_HEADER_SIZE_BYTES = 16 as const;

/**
 * Enumeration of zero-copy binary message types for sub-millisecond dispatch.
 */
export enum MessageType {
  HEARTBEAT = 0x00,
  DISPLAY_FRAME = 0x01,
  AUDIO_IN = 0x02,
  AUDIO_OUT = 0x03,
  SENSOR_TELEMETRY = 0x04,
  WIDGET_MSGPACK = 0x05,
  RPC_COMMAND = 0x06,
  OTA_CHUNK = 0x07,
  LOG_EVENT = 0x08,
}

/**
 * Immutable aggregated constants object.
 */
export const SYSTEM_CONSTANTS = {
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
  OTA_CHUNK_SIZE_BYTES,
  BLE_MTU_SAFE_BYTES,
  MDNS_SERVICE_NAME,
  DEFAULT_WS_PORT,
  PROTOCOL_MAGIC,
  PROTOCOL_VERSION,
  BINARY_HEADER_SIZE_BYTES,
} as const;

export type SystemConstants = typeof SYSTEM_CONSTANTS;
