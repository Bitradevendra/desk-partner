import { describe, it, expect } from "vitest";
import { DesktopTestHarness } from "../src/index.js";
import {
  DISPLAY_BUFFER_BYTES,
  AUDIO_FRAME_BYTES,
  FRAME_OVERHEAD_SIZE,
  FrameType,
} from "@petbot/protocol";

describe("DesktopTestHarness", () => {
  it("generates synthetic display frames of exact buffer byte size", () => {
    const harness = new DesktopTestHarness();
    const frame = harness.generateSyntheticDisplayFrame(1);
    expect(frame.byteLength).toBe(FRAME_OVERHEAD_SIZE + DISPLAY_BUFFER_BYTES);

    const parsed = harness.processFrame(frame);
    expect(parsed.header.frameType).toBe(FrameType.AUDIO_DOWNLINK_FRAME);
    expect(parsed.header.payloadLen).toBe(DISPLAY_BUFFER_BYTES);
    expect(parsed.payload.byteLength).toBe(DISPLAY_BUFFER_BYTES);
  });

  it("generates synthetic audio frames of exact audio buffer size", () => {
    const harness = new DesktopTestHarness();
    const frame = harness.generateSyntheticAudioFrame(2);
    expect(frame.byteLength).toBe(FRAME_OVERHEAD_SIZE + AUDIO_FRAME_BYTES);

    const parsed = harness.processFrame(frame);
    expect(parsed.header.frameType).toBe(FrameType.AUDIO_UPLINK_FRAME);
    expect(parsed.header.payloadLen).toBe(AUDIO_FRAME_BYTES);
  });

  it("tracks metrics accurately across processed frames", () => {
    const harness = new DesktopTestHarness();
    const frame1 = harness.generateSyntheticDisplayFrame(10);
    const frame2 = harness.generateBatteryTelemetry(11, 80);

    harness.processFrame(frame1);
    harness.processFrame(frame2);

    const metrics = harness.getMetrics();
    expect(metrics.totalFramesProcessed).toBe(2);
    expect(metrics.lastSequenceNumber).toBe(11);
    expect(metrics.totalBytesProcessed).toBe(frame1.byteLength + frame2.byteLength);
  });
});
