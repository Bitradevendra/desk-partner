# ESP32-S3 AI Desktop Pet Robot Monorepo

Production monorepo for the high-performance ESP32-S3 AI Desktop Pet Robot ecosystem. Every architectural choice prioritizes sub-millisecond serialization, zero-copy memory operations, and deterministic builds across C++20 firmware and TypeScript/Node services.

## Workspace Layout

```
.
├── apps/
│   └── companion/                  # Companion management app & device UI (@petbot/companion)
├── firmware/                       # C++20 ESP32-S3 firmware with PlatformIO (esp32-s3-n16r8)
├── packages/
│   ├── protocol/                   # Shared wire protocol & hardware constants (@petbot/protocol)
│   └── widget-schema/              # UI widget schemas & MsgPack codecs (@petbot/widget-schema)
├── services/
│   ├── cloud-gateway/              # Edge IoT gateway & cloud LLM relay (@petbot/cloud-gateway)
│   └── desktop-harness/            # Local developer test harness & HIL (@petbot/desktop-harness)
├── tools/
│   └── virtual-robot-emulator/     # Pure software robot emulator (@petbot/virtual-robot-emulator)
├── package.json                    # Monorepo root manifest with Turborepo scripts
├── pnpm-workspace.yaml             # pnpm workspace definition
├── turbo.json                      # Turborepo task pipeline and caching rules
└── tsconfig.base.json              # Shared TypeScript strict configuration (ES2022 / Bundler)
```

## Hardware & Real-time Constants

- **Display**: 128x160 RGB565 (20,480 pixels, 40,960 bytes DMA framebuffer).
- **Audio**: 16,000 Hz, 16-bit linear PCM, 20 ms frames (320 samples, 640 bytes).
- **Networking**: 64 KiB WS maximum payload ceiling, 16 KiB SD block reads, 244-byte safe BLE MTU.
- **Service Discovery**: mDNS `_petbot._tcp.local`, default WebSocket port `8443`.

## Architecture Principles

1. **Sub-Millisecond Zero-Copy Memory Operations**:
   - 16-byte packed Little-Endian binary header (`PET1`) for zero-copy slicing into `Uint8Array` / `DataView` in TypeScript and `std::span` / `#pragma pack(push, 1)` structs in C++20.
   - ESP32-S3 DMA buffers allocated directly in internal SRAM (`MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL`) to avoid Octal-SPI cache line eviction stalls.
2. **Deterministic Build Pipeline**:
   - `codegen:headers` guarantees C++20 headers are generated and validated before any TypeScript or firmware builds execute.
   - Enforced strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`) across all workspaces.

## Commands

```bash
# Install dependencies and link workspaces
pnpm install

# Run deterministic C++ header codegen
pnpm codegen:headers

# Build all TypeScript packages and applications
pnpm build

# Run Vitest test suites across all packages
pnpm test

# Typecheck and lint workspace
pnpm lint
```
