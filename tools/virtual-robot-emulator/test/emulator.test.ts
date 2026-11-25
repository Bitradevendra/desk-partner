import { describe, it, expect } from "vitest";
import { VirtualRobotEmulator } from "../src/index.js";
import {
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
  DISPLAY_BUFFER_BYTES,
  FrameType,
  encodeFrame,
  decodeFrame,
} from "@petbot/protocol";
import { serializeWidgetPacket, EyeFaceWidget } from "@petbot/widget-schema";

describe("VirtualRobotEmulator", () => {
  it("initializes with exact display dimensions", () => {
    const emulator = new VirtualRobotEmulator();
    const dims = emulator.getDisplayDimensions();

    expect(dims.width).toBe(DISPLAY_WIDTH);
    expect(dims.height).toBe(DISPLAY_HEIGHT);
    expect(dims.bufferBytes).toBe(DISPLAY_BUFFER_BYTES);
  });

  it("handles incoming heartbeat and replies with acknowledgement", () => {
    const emulator = new VirtualRobotEmulator();
    const heartbeatFrame = encodeFrame(FrameType.HEARTBEAT_PING, new Uint8Array(0), 77);

    const result = emulator.handleInboundFrame(heartbeatFrame);
    expect(result.response).toBeDefined();

    if (result.response) {
      const decodedResponse = decodeFrame(result.response);
      expect(decodedResponse.header.frameType).toBe(FrameType.HEARTBEAT_PONG);
      expect(decodedResponse.header.seqId).toBe(77);
    }
  });

  it("updates emotion state from widget packet", () => {
    const emulator = new VirtualRobotEmulator();
    const eyeWidget: EyeFaceWidget = {
      type: "EYE_FACE",
      leftEye: {
        emotion: "SURPRISED",
        eyelidOpenness: 1.0,
        pupilSize: 1.8,
        lookOffsetX: 0.0,
        lookOffsetY: 0.0,
        irisColorRgb565: 0xffff,
        saccadeJitter: true,
      },
      rightEye: {
        emotion: "SURPRISED",
        eyelidOpenness: 1.0,
        pupilSize: 1.8,
        lookOffsetX: 0.0,
        lookOffsetY: 0.0,
        irisColorRgb565: 0xffff,
        saccadeJitter: true,
      },
      renderTick: 999,
    };

    const packed = serializeWidgetPacket(eyeWidget);
    const frame = encodeFrame(FrameType.WIDGET_DEPLOY, packed, 101);

    const result = emulator.handleInboundFrame(frame);
    expect(result.parsedWidget).toEqual(eyeWidget);
    expect(emulator.getState().currentEmotion).toBe("SURPRISED");
  });
});
