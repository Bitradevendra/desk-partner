import { describe, it, expect } from "vitest";
import { CloudGatewayRouter, createCloudGatewayServer } from "../src/index.js";
import { encodeFrame, FrameType, AUDIO_FRAME_BYTES } from "@petbot/protocol";
import { serializeWidgetPacket, BatteryGaugeWidget } from "@petbot/widget-schema";

describe("CloudGatewayRouter", () => {
  it("registers and tracks active device sessions", () => {
    const router = new CloudGatewayRouter(8443);
    const session = router.registerDevice("robot-esp32-01");

    expect(session.deviceId).toBe("robot-esp32-01");
    expect(router.getSession("robot-esp32-01")).toBeDefined();
    expect(router.getPort()).toBe(8443);

    expect(router.unregisterDevice("robot-esp32-01")).toBe(true);
    expect(router.getSession("robot-esp32-01")).toBeUndefined();
  });

  it("handles audio streaming and widget packets properly", () => {
    const router = new CloudGatewayRouter();
    router.registerDevice("robot-esp32-02");

    const audioPayload = new Uint8Array(AUDIO_FRAME_BYTES);
    const audioMsg = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, audioPayload, 1);

    const result1 = router.handleInboundFrame("robot-esp32-02", audioMsg);
    expect(result1.frame.header.frameType).toBe(FrameType.AUDIO_UPLINK_FRAME);
    expect(router.getSession("robot-esp32-02")?.totalAudioFrames).toBe(1);

    const battery: BatteryGaugeWidget = {
      type: "BATTERY_GAUGE",
      percentage: 55,
      isCharging: true,
      voltageMv: 3850,
      x: 0,
      y: 0,
    };
    const widgetMsg = encodeFrame(
      FrameType.WIDGET_DEPLOY,
      serializeWidgetPacket(battery),
      2
    );

    const result2 = router.handleInboundFrame("robot-esp32-02", widgetMsg);
    expect(result2.widgetPayload).toEqual(battery);
  });

  it("handles POST /api/v1/voice/command end-to-end with cross-widget habit add and complete", async () => {
    const server = await createCloudGatewayServer({ port: 0, logger: false });
    try {
      const addRes = await server.app.inject({
        method: "POST",
        url: "/api/v1/voice/command",
        payload: { text: "Add Stretch 10m to my daily habit tracker", persona: "Nova" },
      });
      expect(addRes.statusCode).toBe(200);
      const addJson = addRes.json();
      expect(addJson.success).toBe(true);
      expect(addJson.toolCalls[0]?.toolName).toBe("manage_robot_habit");
      expect(addJson.framesGenerated).toBe(1);

      const doneRes = await server.app.inject({
        method: "POST",
        url: "/api/v1/voice/command",
        payload: { text: "Mark Stretch complete", persona: "Nova" },
      });
      expect(doneRes.statusCode).toBe(200);
      const doneJson = doneRes.json();
      const stretch = doneJson.ecosystemState.habits.find((h: any) => h.title.includes("Stretch"));
      expect(stretch?.completedToday).toBe(true);
      expect(stretch?.streakDays).toBe(1);
    } finally {
      await server.stop();
    }
  });
});
