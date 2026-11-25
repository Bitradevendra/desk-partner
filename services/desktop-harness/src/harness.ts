import {
  DISPLAY_BUFFER_BYTES,
  AUDIO_FRAME_BYTES,
  FrameType,
  encodeFrame,
  decodeFrame,
  type DecodedFrame,
} from "@petbot/protocol";
import {
  serializeWidgetPacket,
  type BatteryGaugeWidget,
} from "@petbot/widget-schema";

export interface HarnessMetrics {
  totalFramesProcessed: number;
  totalBytesProcessed: number;
  lastSequenceNumber: number;
}

/**
 * Synthetic hardware-in-the-loop generator and frame processor for local testing.
 */
export class DesktopTestHarness {
  private metrics: HarnessMetrics = {
    totalFramesProcessed: 0,
    totalBytesProcessed: 0,
    lastSequenceNumber: 0,
  };

  public getMetrics(): Readonly<HarnessMetrics> {
    return { ...this.metrics };
  }

  public generateSyntheticDisplayFrame(sequence: number): Uint8Array {
    const rawFrame = new Uint8Array(DISPLAY_BUFFER_BYTES);
    // Fill test pattern: Alternating high/low bytes for RGB565 checkerboard
    for (let i = 0; i < rawFrame.length; i += 2) {
      rawFrame[i] = 0xf8; // Red component
      if (i + 1 < rawFrame.length) {
        rawFrame[i + 1] = 0x00;
      }
    }
    return encodeFrame(FrameType.AUDIO_DOWNLINK_FRAME, rawFrame, sequence);
  }

  public generateSyntheticAudioFrame(sequence: number): Uint8Array {
    const rawAudio = new Uint8Array(AUDIO_FRAME_BYTES);
    for (let i = 0; i < rawAudio.length; i++) {
      rawAudio[i] = 0x00;
    }
    return encodeFrame(FrameType.AUDIO_UPLINK_FRAME, rawAudio, sequence);
  }

  public generateBatteryTelemetry(sequence: number, percentage = 95): Uint8Array {
    const battery: BatteryGaugeWidget = {
      type: "BATTERY_GAUGE",
      percentage,
      isCharging: false,
      voltageMv: 4180,
      x: 0,
      y: 0,
    };
    const payload = serializeWidgetPacket(battery);
    return encodeFrame(FrameType.WIDGET_DEPLOY, payload, sequence);
  }

  public processFrame(data: Uint8Array): DecodedFrame {
    const frame = decodeFrame(data);
    this.metrics.totalFramesProcessed += 1;
    this.metrics.totalBytesProcessed += data.byteLength;
    this.metrics.lastSequenceNumber = frame.header.seqId;
    return frame;
  }
}
