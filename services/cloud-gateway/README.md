# @petbot/cloud-gateway

Cloud-edge ingestion gateway and bidirectional proxy connecting ESP32-S3 robots to cloud AI models and fleet telemetry.

## Responsibilities

- **Device Multiplexing**: Manages authenticated persistent WebSocket tunnels across deployed robot fleets.
- **Voice Stream Routing**: Routes 16 kHz 16-bit PCM streams to real-time Speech-to-Text (STT) and Text-to-Speech (TTS) pipelines with sub-200ms latency.
- **OTA Updates & Telemetry**: Handles encrypted binary firmware distribution and aggregated telemetry collection.

## Building and Testing

```bash
pnpm --filter @petbot/cloud-gateway build
pnpm --filter @petbot/cloud-gateway test
```
