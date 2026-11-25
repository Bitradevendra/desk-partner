import { describe, it, expect } from "vitest";
import {
  WidgetPacket,
  serializeWidgetPacket,
  deserializeWidgetPacket,
  EyeFaceWidget,
  BatteryGaugeWidget,
} from "../src/index.js";

describe("Widget Schema Serialization", () => {
  it("serializes and deserializes EyeFaceWidget with full precision", () => {
    const faceWidget: EyeFaceWidget = {
      type: "EYE_FACE",
      leftEye: {
        emotion: "HAPPY",
        eyelidOpenness: 0.85,
        pupilSize: 1.2,
        lookOffsetX: 0.1,
        lookOffsetY: -0.2,
        irisColorRgb565: 0x07e0, // Pure green in RGB565
        saccadeJitter: false,
      },
      rightEye: {
        emotion: "HAPPY",
        eyelidOpenness: 0.85,
        pupilSize: 1.2,
        lookOffsetX: 0.1,
        lookOffsetY: -0.2,
        irisColorRgb565: 0x07e0,
        saccadeJitter: false,
      },
      renderTick: 4200,
    };

    const packed = serializeWidgetPacket(faceWidget);
    expect(packed.byteLength).toBeGreaterThan(0);

    const unpacked = deserializeWidgetPacket(packed);
    expect(unpacked).toEqual(faceWidget);
  });

  it("serializes and deserializes BatteryGaugeWidget", () => {
    const battery: BatteryGaugeWidget = {
      type: "BATTERY_GAUGE",
      percentage: 87,
      isCharging: true,
      voltageMv: 4120,
      x: 10,
      y: 110,
    };

    const packed = serializeWidgetPacket(battery);
    const unpacked = deserializeWidgetPacket(packed);
    expect(unpacked).toEqual(battery);
  });

  it("rejects invalid out-of-range parameters", () => {
    const invalidBattery = {
      type: "BATTERY_GAUGE",
      percentage: 150, // Out of range (>100)
      isCharging: false,
      voltageMv: 4000,
      x: 0,
      y: 0,
    };

    expect(() => serializeWidgetPacket(invalidBattery as unknown as WidgetPacket)).toThrow();
  });
});
