# @petbot/desktop-harness

Desktop test harness and Hardware-in-the-Loop (HIL) automation service for the Pet Robot ecosystem.

## Core Capabilities

- **Synthetic Real-time Feed Generator**: Emits standard 40,960-byte RGB565 display frames and 640-byte audio PCM chunks for benchmarking network backpressure.
- **Protocol Conformance Validation**: Verifies wire protocol invariants, frame sequence ordering, and header validation rules.
- **Latency & Throughput Benchmarking**: Monitors frame timing, zero-copy memory overhead, and message pipeline jitter.

## Building and Testing

```bash
pnpm --filter @petbot/desktop-harness build
pnpm --filter @petbot/desktop-harness test
```
