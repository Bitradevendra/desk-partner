# ESP32-S3 Firmware Subsystem

High-performance C++20 embedded firmware for the ESP32-S3 Desktop Robot with 16MB Flash and 8MB Octal PSRAM.

## Architectural Highlights

- **Hardware Target**: ESP32-S3-DevKitC-1 (`esp32-s3-n16r8`).
- **Memory Architecture**: Quad-SPI Flash (16MB) + Octal-SPI PSRAM (8MB) via `qio_opi`.
- **Zero-Copy SPI DMA**: Dedicated 40,960-byte RGB565 display buffer allocated directly in DMA-accessible internal SRAM (`MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL`).
- **Deterministic Audio Pipeline**: I2S double-buffered DMA streams configured for 16 kHz 16-bit linear PCM with 20 ms frame granularity (640 bytes).
- **C++20 Compilation**: `-std=gnu++2a -O3` with header parity from `@petbot/protocol` and `@petbot/widget-schema`.

## Building and Flashing

Ensure PlatformIO is installed:

```bash
cd firmware
pio run -e esp32-s3-n16r8
pio run -e esp32-s3-n16r8 -t upload
```
