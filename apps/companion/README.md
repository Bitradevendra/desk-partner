# @petbot/companion

Companion control client and user-facing management application for the ESP32-S3 Desktop Robot ecosystem.

## Responsibilities

- **Device Discovery**: Automated local robot location via mDNS query (`_petbot._tcp.local`).
- **Telemetry Display**: Battery health, Wi-Fi RSSI, system uptime, and live sensory readouts.
- **Visual Expression Control**: Real-time eye rendering configuration and emotion dispatches using `@petbot/widget-schema`.
- **Low-Latency Communication**: Binary WebSocket connections for streaming sensor data and control RPCs.

## Building and Testing

```bash
pnpm --filter @petbot/companion build
pnpm --filter @petbot/companion test
```
