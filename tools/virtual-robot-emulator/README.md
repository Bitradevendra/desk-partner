# @petbot/virtual-robot-emulator

Virtual hardware emulator for the ESP32-S3 Desktop Robot, providing pure-software simulation of the LCD screen, I2S audio channels, and binary message protocol.

## Purpose

- **Hardware-Free Development**: Enables companion app, cloud gateway, and AI engine development without physical ESP32-S3 hardware attached.
- **Protocol Conformance Validation**: Validates binary frame headers, endianness, and MessagePack payloads against simulated framebuffers.
- **CI/CD Integration**: Supports headless unit and integration testing inside cloud CI pipelines.

## Building and Testing

```bash
pnpm --filter @petbot/virtual-robot-emulator build
pnpm --filter @petbot/virtual-robot-emulator test
```
