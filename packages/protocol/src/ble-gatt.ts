import {
  RobotMode,
  BleAdvBeaconPayload,
  BLE_BEACON_PAYLOAD_SIZE,
} from "./frame-types.js";

/**
 * ============================================================================
 * BLE GATT Specifications & 24-Byte Fast Discovery / Presence Beacon
 * Enables instant Companion App upgrade from BLE to Wi-Fi mTLS in < 50ms.
 * ============================================================================
 */

export const BLE_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e" as const;
export const BLE_CHAR_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e" as const;
export const BLE_CHAR_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e" as const;

export const BLE_BEACON_MAGIC = 0x4250 as const; // 'P','B' (Little-Endian: 0x50, 0x42)
export const BLE_BEACON_VERSION = 0x01 as const;
export const BLE_BEACON_SIZE_BYTES = 24 as const;
export const DEFAULT_COMPANY_ID = 0x02e5 as const; // Espressif Systems Company Identifier

// Beacon Flags Bitmask
export const BEACON_FLAG_WIFI_CONNECTED = 0x01 as const;
export const BEACON_FLAG_IS_CHARGING = 0x02 as const;
export const BEACON_FLAG_HAS_SD_CARD = 0x04 as const;
export const BEACON_FLAG_REQUIRES_2FA = 0x08 as const;

export interface BleBeaconFlags {
  wifiConnected: boolean;
  isCharging: boolean;
  hasSdCard: boolean;
  requires2Fa: boolean;
}

export interface BleAdvBeacon {
  companyId?: number | undefined; // uint16 (defaults to 0x02E5)
  modeState: RobotMode;
  batteryPercent: number; // 0..100
  flags: BleBeaconFlags;
  deviceId: string;       // max 8 ASCII characters
  ipv4Address: string;    // e.g. "192.168.1.100"
  wsPort: number;         // e.g. 8443
}

/**
 * Computes CRC16-CCITT (polynomial 0x1021, init 0xFFFF) for BLE beacon validation.
 */
export function computeBeaconCrc16(buffer: Uint8Array, length: number): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= buffer[i]! << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

/**
 * Encodes a 24-byte packed binary BLE manufacturer advertising presence beacon.
 */
export function encodeBleAdvBeacon(beacon: BleAdvBeacon): Uint8Array {
  const buffer = new Uint8Array(BLE_BEACON_SIZE_BYTES);
  const view = new DataView(buffer.buffer, buffer.byteOffset, BLE_BEACON_SIZE_BYTES);

  // Offset 0: Company ID (uint16 LE)
  const companyId = beacon.companyId ?? DEFAULT_COMPANY_ID;
  view.setUint16(0, companyId, true);

  // Offset 2: Beacon Magic (0x4250 -> 'P','B')
  view.setUint16(2, BLE_BEACON_MAGIC, true);

  // Offset 4: Protocol Version (uint8)
  view.setUint8(4, BLE_BEACON_VERSION);

  // Offset 5: Robot Mode State (uint8)
  view.setUint8(5, beacon.modeState);

  // Offset 6: Battery Percentage (uint8)
  view.setUint8(6, Math.min(100, Math.max(0, beacon.batteryPercent)));

  // Offset 7: Flags (uint8 bitmask)
  let flagBits = 0;
  if (beacon.flags.wifiConnected) flagBits |= BEACON_FLAG_WIFI_CONNECTED;
  if (beacon.flags.isCharging) flagBits |= BEACON_FLAG_IS_CHARGING;
  if (beacon.flags.hasSdCard) flagBits |= BEACON_FLAG_HAS_SD_CARD;
  if (beacon.flags.requires2Fa) flagBits |= BEACON_FLAG_REQUIRES_2FA;
  view.setUint8(7, flagBits);

  // Offset 8..15: Device ID (8 bytes fixed, padded with 0)
  const idEncoder = new TextEncoder();
  const idBytes = idEncoder.encode(beacon.deviceId);
  for (let i = 0; i < 8; i++) {
    buffer[8 + i] = i < idBytes.length ? idBytes[i]! : 0x00;
  }

  // Offset 16..19: IPv4 Address (4 bytes)
  const ipParts = beacon.ipv4Address.split(".").map((part) => parseInt(part, 10));
  if (ipParts.length === 4) {
    buffer[16] = ipParts[0] ?? 0;
    buffer[17] = ipParts[1] ?? 0;
    buffer[18] = ipParts[2] ?? 0;
    buffer[19] = ipParts[3] ?? 0;
  } else {
    buffer[16] = 0;
    buffer[17] = 0;
    buffer[18] = 0;
    buffer[19] = 0;
  }

  // Offset 20..21: WebSocket Port (uint16 LE)
  view.setUint16(20, beacon.wsPort & 0xffff, true);

  // Offset 22..23: CRC16 Checksum over bytes 0..21
  const crc = computeBeaconCrc16(buffer, 22);
  view.setUint16(22, crc, true);

  return buffer;
}

/**
 * Decodes and validates a 24-byte packed binary BLE advertising presence beacon.
 */
export function decodeBleAdvBeacon(data: Uint8Array): BleAdvBeacon {
  if (data.byteLength !== BLE_BEACON_SIZE_BYTES) {
    throw new RangeError(
      `Invalid BLE beacon size: received ${data.byteLength} bytes, expected ${BLE_BEACON_SIZE_BYTES}`
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Verify Magic
  const magic = view.getUint16(2, true);
  if (magic !== BLE_BEACON_MAGIC) {
    throw new Error(
      `Invalid BLE beacon magic: 0x${magic.toString(16).toUpperCase()} (expected 0x${BLE_BEACON_MAGIC.toString(16).toUpperCase()})`
    );
  }

  // Verify Version
  const version = view.getUint8(4);
  if (version !== BLE_BEACON_VERSION) {
    throw new Error(`Unsupported BLE beacon version: ${version} (expected ${BLE_BEACON_VERSION})`);
  }

  // Verify CRC16 Checksum
  const expectedCrc = view.getUint16(22, true);
  const actualCrc = computeBeaconCrc16(data, 22);
  if (actualCrc !== expectedCrc) {
    throw new Error(
      `BLE beacon CRC16 mismatch: expected 0x${expectedCrc.toString(16)}, computed 0x${actualCrc.toString(16)}`
    );
  }

  const companyId = view.getUint16(0, true);
  const modeState = view.getUint8(5) as RobotMode;
  const batteryPercent = view.getUint8(6);
  const flagBits = view.getUint8(7);

  const flags: BleBeaconFlags = {
    wifiConnected: (flagBits & BEACON_FLAG_WIFI_CONNECTED) !== 0,
    isCharging: (flagBits & BEACON_FLAG_IS_CHARGING) !== 0,
    hasSdCard: (flagBits & BEACON_FLAG_HAS_SD_CARD) !== 0,
    requires2Fa: (flagBits & BEACON_FLAG_REQUIRES_2FA) !== 0,
  };

  // Decode Device ID (extract string up to first null byte or max 8 chars)
  const idBytes = data.subarray(8, 16);
  let nullIndex = idBytes.indexOf(0x00);
  if (nullIndex === -1) nullIndex = 8;
  const deviceId = new TextDecoder().decode(idBytes.subarray(0, nullIndex));

  // Decode IPv4 Address
  const ip0 = data[16] ?? 0;
  const ip1 = data[17] ?? 0;
  const ip2 = data[18] ?? 0;
  const ip3 = data[19] ?? 0;
  const ipv4Address = `${ip0}.${ip1}.${ip2}.${ip3}`;

  // Decode WebSocket Port
  const wsPort = view.getUint16(20, true);

  return {
    companyId,
    modeState,
    batteryPercent,
    flags,
    deviceId,
    ipv4Address,
    wsPort,
  };
}

/**
 * ============================================================================
 * 16-Byte Packed Binary BLE Advertisement Payload
 * Direct C++ struct BleAdvBeaconPayload matching firmware layout:
 * uint16_t magic;
 * uint32_t deviceIdHash;
 * uint8_t  mode;
 * uint8_t  batteryPct;
 * uint8_t  ipv4[4];
 * uint16_t wsPort;
 * uint16_t flags;
 * ============================================================================
 */

export function encodeBleAdvBeaconPayload(payload: BleAdvBeaconPayload): Uint8Array {
  const buffer = new Uint8Array(BLE_BEACON_PAYLOAD_SIZE);
  const view = new DataView(buffer.buffer, buffer.byteOffset, BLE_BEACON_PAYLOAD_SIZE);

  view.setUint16(0, payload.magic, true);
  view.setUint32(2, payload.deviceIdHash, true);
  view.setUint8(6, payload.mode);
  view.setUint8(7, payload.batteryPct & 0xff);
  buffer.set(payload.ipv4.subarray(0, 4), 8);
  view.setUint16(12, payload.wsPort & 0xffff, true);
  view.setUint16(14, payload.flags & 0xffff, true);

  return buffer;
}

export function decodeBleAdvBeaconPayload(raw: Uint8Array): BleAdvBeaconPayload {
  if (raw.byteLength < BLE_BEACON_PAYLOAD_SIZE) {
    throw new RangeError(
      `BLE beacon payload too short: received ${raw.byteLength} bytes, expected at least ${BLE_BEACON_PAYLOAD_SIZE}`
    );
  }
  const view = new DataView(raw.buffer, raw.byteOffset, BLE_BEACON_PAYLOAD_SIZE);

  const magic = view.getUint16(0, true);
  if (magic !== BLE_BEACON_MAGIC) {
    throw new Error(
      `Invalid BLE beacon payload magic: 0x${magic.toString(16).toUpperCase()} (expected 0x${BLE_BEACON_MAGIC.toString(16).toUpperCase()})`
    );
  }

  const deviceIdHash = view.getUint32(2, true);
  const mode = view.getUint8(6) as RobotMode;
  const batteryPct = view.getUint8(7);
  const ipv4 = raw.slice(8, 12);
  const wsPort = view.getUint16(12, true);
  const flags = view.getUint16(14, true);

  return {
    magic,
    deviceIdHash,
    mode,
    batteryPct,
    ipv4,
    wsPort,
    flags,
  };
}

/**
 * High-speed extractor: Extracts IPv4 address string and WebSocket port
 * directly from raw 16-byte beacon payload in sub-microsecond time.
 */
export function extractIpAndPortFromBeaconPayload(raw: Uint8Array): {
  ip: string;
  port: number;
} {
  if (raw.byteLength < BLE_BEACON_PAYLOAD_SIZE) {
    throw new RangeError(`Beacon payload buffer too short (${raw.byteLength})`);
  }
  const ip = `${raw[8]!}.${raw[9]!}.${raw[10]!}.${raw[11]!}`;
  const port = raw[12]! | (raw[13]! << 8); // Little-Endian uint16
  return { ip, port };
}
