# @petbot/protocol

Unified Binary Communication Protocol, Zero-Copy Codecs, and BLE GATT Beacon for the ESP32-S3 Desktop Robot Ecosystem.

## Architectural Overview

To guarantee sub-millisecond serialization and zero-copy memory operations across both Local mTLS WebSockets and BLE GATT:
- **Unified 12-Byte Binary Frame Envelope**: Fixed Little-Endian header matching Xtensa LX7 (ESP32-S3) CPU memory layouts directly, avoiding byte-swapping overhead.
- **IEEE 802.3 CRC32 Integrity**: 4-byte CRC32 trailer calculated over header + payload for hardware-level bitflip rejection.
- **Hot-Path Streaming**: Raw packed binary structs for Audio Uplink/Downlink (with real-time synchronized emotion/visemes) and 16 KB chunked SD card vault transfers.
- **Control Plane RPCs**: Typed MessagePack payloads with Zod validation for handshake, state transition, security challenges, and device telemetry.
- **BLE GATT Fast-Discovery Beacon**: 24-byte packed manufacturer advertising data allowing the Companion App to locate the robot, verify mode and battery, and upgrade to high-speed LAN WebSockets in under 50ms without slow mDNS sweeps.

## Binary Frame Wire Layout

```
Offset | Size | Type   | Field
-------|------|--------|----------------------------------------------------
0      | 2    | uint16 | Magic (0x4250 -> 'P','B' in Little-Endian)
2      | 1    | uint8  | Protocol Version (0x01)
3      | 1    | uint8  | Frame Type (FrameType enum)
4      | 1    | uint8  | Flags Bitmask (ACK, COMPRESSED, ENCRYPTED, PRIORITY)
5      | 1    | uint8  | Reserved (0x00 for 4-byte alignment)
6      | 2    | uint16 | Sequence ID (Rolling uint16)
8      | 4    | uint32 | Payload Byte Length (N)
12     | N    | bytes  | Payload (Raw binary struct or MessagePack payload)
12+N   | 4    | uint32 | IEEE 802.3 CRC32 (Header + Payload)
```

## Frame Types (`FrameType`)

- `0x01 HELLO_HANDSHAKE`: Hardware capabilities, Ed25519 public key, PSRAM and SD capacity.
- `0x02 MODE_TRANSITION`: Transition between `NORMAL_OFFLINE` (0) and `AGENTIC_CONNECTED` (1).
- `0x03 HEARTBEAT_PING` / `0x04 HEARTBEAT_PONG`: Microsecond-precision roundtrip latency tracking.
- `0x10 AUDIO_UPLINK_FRAME`: 2-byte VAD + RMS header + 20ms 16kHz 16-bit mono PCM.
- `0x11 AUDIO_DOWNLINK_FRAME`: 4-byte emotion/viseme/gaze synchronization header + audio PCM/Opus.
- `0x20 SD_VAULT_START`: File transfer session initiation (fileId, chunks, sha256, direction).
- `0x21 SD_VAULT_CHUNK`: 12-byte transferId/chunkIndex/chunkCrc32 header + 16KB data block.
- `0x22 SD_VAULT_ACK`: Transfer progress acknowledgement and flow control.
- `0x23 SD_VAULT_LIST_REQ` / `0x24 SD_VAULT_LIST_RES`: SD directory browser.
- `0x30 WIDGET_DEPLOY`: Direct deployment of compiled `PBWG` widget bytecode to robot PSRAM/SD.
- `0x40 HARNESS_RPC_REQ` / `0x41 HARNESS_RPC_RES`: PC telemetry and bidirectional automation commands.
- `0x50 TOUCH_2FA_CHALLENGE`: Security authorization prompt displayed on robot 1.8" LCD.
- `0x51 TOUCH_2FA_RESPONSE`: Hardware touch confirmation (single tap = approve, long press = deny) with Ed25519 signature.
- `0x60 SUBSCRIPTION_ENTITLEMENT_SYNC`: Cloud AI licensing and voice persona tier sync.

## BLE GATT Presence Beacon (24 Bytes)

```
Offset | Size | Field           | Description
-------|------|-----------------|---------------------------------------------
0      | 2    | company_id      | 0x02E5 (Espressif Systems)
2      | 2    | magic           | 0x4250 ('P','B' in Little-Endian)
4      | 1    | version         | 0x01
5      | 1    | mode_state      | RobotMode (0 = Offline, 1 = Agentic)
6      | 1    | battery_percent | 0..100
7      | 1    | flags           | Wi-Fi, Charging, SD card, 2FA status
8      | 8    | device_id       | Truncated 8-byte ASCII device ID
16     | 4    | ipv4_address    | 4-byte direct LAN IP (e.g. 192.168.1.100)
20     | 2    | ws_port         | mTLS WebSocket port (8443)
22     | 2    | crc16           | CRC16-CCITT integrity checksum
```

## Build and Test Commands

```bash
# Codegen C++20 headers
pnpm --filter @petbot/protocol codegen:headers

# Compile TypeScript package
pnpm --filter @petbot/protocol build

# Run unit tests
pnpm --filter @petbot/protocol test
```
