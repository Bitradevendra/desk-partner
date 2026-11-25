import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  MobilePartnerBridge,
  mobilePartnerBridge,
  MobileHarnessOrchestrator,
  mobileHarnessOrchestrator,
  type MobileNotification,
  type SemanticNode,
} from "../src/mobile-harness/index.js";
import {
  robotConnection,
  RobotConnectionManager,
} from "../src/services/robot-connection.js";
import { SdVaultClient } from "../src/services/sd-vault-client.js";
import { FrameType, RobotMode, EmotionId } from "@petbot/protocol";

describe("Native Mobile Partner Harness", () => {
  let bridge: MobilePartnerBridge;
  let orchestrator: MobileHarnessOrchestrator;

  beforeEach(() => {
    robotConnection.bootSimulator();
    bridge = new MobilePartnerBridge();
    orchestrator = new MobileHarnessOrchestrator(bridge, SdVaultClient.getInstance());
  });

  afterEach(() => {
    orchestrator.destroy();
    robotConnection.disconnect();
  });

  // ==========================================================================
  // Pillar 1: Notification & Message Interception + Silent Reply
  // ==========================================================================
  describe("Pillar 1: Notification & Message Interception + RemoteInput Silent Reply", () => {
    it("retrieves recent intercepted notifications and flags reply capability", async () => {
      const notifs = await bridge.getRecentNotifications();
      expect(notifs.length).toBeGreaterThanOrEqual(3);

      const whatsApp = notifs.find((n) => n.packageName === "com.whatsapp");
      expect(whatsApp).toBeDefined();
      expect(whatsApp?.canReply).toBe(true);
      expect(whatsApp?.sender).toBe("Maya Lin");

      const telegram = notifs.find((n) => n.packageName === "org.telegram.messenger");
      expect(telegram).toBeDefined();
      expect(telegram?.canReply).toBe(true);

      const sms = notifs.find((n) => n.packageName === "com.google.android.apps.messaging");
      expect(sms).toBeDefined();
      expect(sms?.canReply).toBe(false);
    });

    it("simulates incoming real-time notification push events to subscribers", async () => {
      let receivedNotif: MobileNotification | null = null;
      const unsubscribe = bridge.onNotificationReceived((n) => {
        receivedNotif = n;
      });

      const simulated = bridge.simulateIncomingNotification({
        packageName: "com.Slack",
        appName: "Slack",
        sender: "Dev Lead",
        message: "Firmware v2.1 OTA bundle verified by QA.",
        canReply: true,
      });

      expect(receivedNotif).not.toBeNull();
      expect(receivedNotif?.appName).toBe("Slack");
      expect(receivedNotif?.message).toBe("Firmware v2.1 OTA bundle verified by QA.");
      expect(receivedNotif?.key).toBe(simulated.key);

      unsubscribe();
    });

    it("sends silent inline background reply using RemoteInput without unlocking screen", async () => {
      const notifs = await bridge.getRecentNotifications();
      const replyable = notifs.find((n) => n.canReply);
      expect(replyable).toBeDefined();

      const success = await bridge.sendNotificationReply(
        replyable!.key,
        "Circuit is assembled and boots in 45ms!"
      );
      expect(success).toBe(true);

      const sentReplies = bridge.getRepliesSent();
      expect(sentReplies.length).toBe(1);
      expect(sentReplies[0]?.key).toBe(replyable!.key);
      expect(sentReplies[0]?.text).toBe("Circuit is assembled and boots in 45ms!");

      // Handled notification is cleared from active list
      const remainingNotifs = await bridge.getRecentNotifications();
      expect(remainingNotifs.find((n) => n.key === replyable!.key)).toBeUndefined();
    });

    it("rejects replies to notifications that lack RemoteInput or have invalid keys", async () => {
      const notifs = await bridge.getRecentNotifications();
      const nonReplyable = notifs.find((n) => !n.canReply);
      expect(nonReplyable).toBeDefined();

      const failNonReplyable = await bridge.sendNotificationReply(
        nonReplyable!.key,
        "Cannot reply to this"
      );
      expect(failNonReplyable).toBe(false);

      const failMissing = await bridge.sendNotificationReply(
        "non_existent_key_999",
        "Hello?"
      );
      expect(failMissing).toBe(false);
    });
  });

  // ==========================================================================
  // Pillar 2: Direct OS Intent Action Dispatcher (Zero GUI)
  // ==========================================================================
  describe("Pillar 2: Direct OS Intent Action Dispatcher (Zero GUI Execution)", () => {
    it("dispatches phone calls without UI interaction", async () => {
      const success = await bridge.makePhoneCall("+1-555-019-2831", true);
      expect(success).toBe(true);

      const history = bridge.getIntentHistory();
      const last = history[history.length - 1];
      expect(last).toEqual({
        type: "CALL",
        phoneNumber: "+1-555-019-2831",
        directCall: true,
      });
    });

    it("dispatches alarms and timers with skipUi enabled", async () => {
      const alarmOk = await bridge.setAlarm(6, 45, "Robot Standup", true);
      expect(alarmOk).toBe(true);

      const timerOk = await bridge.setTimer(180, "Tea Steeping", true);
      expect(timerOk).toBe(true);

      const history = bridge.getIntentHistory();
      expect(history.some((a) => a.type === "ALARM" && a.hour === 6 && a.minutes === 45)).toBe(true);
      expect(history.some((a) => a.type === "TIMER" && a.seconds === 180)).toBe(true);
    });

    it("dispatches calendar events and Google Maps navigation", async () => {
      const now = Date.now();
      const calOk = await bridge.createCalendarEvent(
        "Hardware Sync",
        now,
        now + 3600000,
        "Review ESP32 pinouts"
      );
      expect(calOk).toBe(true);

      const navOk = await bridge.startNavigation("1 Hacker Way, Menlo Park", "driving");
      expect(navOk).toBe(true);

      const history = bridge.getIntentHistory();
      expect(history.some((a) => a.type === "CALENDAR" && a.title === "Hardware Sync")).toBe(true);
      expect(history.some((a) => a.type === "NAVIGATION" && a.destination.includes("Menlo Park"))).toBe(true);
    });

    it("toggles hardware torch and ringer modes", async () => {
      const torchOn = await bridge.toggleTorch(true);
      expect(torchOn).toBe(true);

      let telemetry = await bridge.getMobileTelemetry();
      expect(telemetry.torchEnabled).toBe(true);

      const torchOff = await bridge.toggleTorch(false);
      expect(torchOff).toBe(true);

      telemetry = await bridge.getMobileTelemetry();
      expect(telemetry.torchEnabled).toBe(false);

      const ringerVibrate = await bridge.setRingerMode("VIBRATE");
      expect(ringerVibrate).toBe(true);

      telemetry = await bridge.getMobileTelemetry();
      expect(telemetry.ringerMode).toBe("VIBRATE");
    });

    it("dispatches media playback commands and deep links", async () => {
      const mediaPlay = await bridge.controlMedia("PLAY");
      expect(mediaPlay).toBe(true);

      const mediaNext = await bridge.controlMedia("NEXT");
      expect(mediaNext).toBe(true);

      const deepLink = await bridge.openDeepLink("upi://pay?pa=robot@upi&pn=PetBot&am=15.00");
      expect(deepLink).toBe(true);

      const history = bridge.getIntentHistory();
      expect(history.some((a) => a.type === "MEDIA" && a.command === "NEXT")).toBe(true);
      expect(history.some((a) => a.type === "DEEP_LINK" && a.url.startsWith("upi://"))).toBe(true);
    });
  });

  // ==========================================================================
  // Pillar 3: Headless Semantic Accessibility UI Tree & Executor
  // ==========================================================================
  describe("Pillar 3: Headless Semantic Accessibility UI Tree & Executor", () => {
    it("dumps compact semantic accessibility hierarchy of the active window", async () => {
      const tree = await bridge.dumpAccessibilityTree();
      expect(tree.packageName).toBe("com.whatsapp");
      expect(tree.root.nodeId).toBe("window_root");
      expect(tree.root.bounds.width).toBe(1080);
      expect(tree.root.bounds.height).toBe(2400);
      expect(tree.root.children?.length).toBeGreaterThanOrEqual(3);
    });

    it("finds semantic UI elements by text content or resource ID", async () => {
      const header = await bridge.findNodeByText("Maya Lin");
      expect(header).toBeDefined();
      expect(header?.text).toBe("Maya Lin");
      expect(header?.isClickable).toBe(true);

      const sendBtn = await bridge.findNodeByResourceId("com.whatsapp:id/send");
      expect(sendBtn).toBeDefined();
      expect(sendBtn?.contentDescription).toBe("Send");
      expect(sendBtn?.isClickable).toBe(true);

      const inputBox = await bridge.findNodeByResourceId("com.whatsapp:id/entry");
      expect(inputBox).toBeDefined();
      expect(inputBox?.isEditable).toBe(true);
    });

    it("executes programmatic clicks and text entry via accessibility actions", async () => {
      const clickSuccess = await bridge.performAccessibilityAction({
        resourceId: "com.whatsapp:id/send",
        actionType: "CLICK",
      });
      expect(clickSuccess).toBe(true);

      const textSuccess = await bridge.performAccessibilityAction({
        resourceId: "com.whatsapp:id/entry",
        actionType: "SET_TEXT",
        actionArg: "Autonomous response from Pet Robot!",
      });
      expect(textSuccess).toBe(true);
    });

    it("executes global OS navigation gestures (BACK, HOME, RECENTS)", async () => {
      expect(await bridge.performGlobalAction("BACK")).toBe(true);
      expect(await bridge.performGlobalAction("HOME")).toBe(true);
      expect(await bridge.performGlobalAction("RECENTS")).toBe(true);
      expect(await bridge.performGlobalAction("NOTIFICATIONS")).toBe(true);
    });
  });

  // ==========================================================================
  // Pillar 4: Mobile "Send & Collect" Auto-Pocket Sync
  // ==========================================================================
  describe("Pillar 4: Mobile 'Send & Collect' Auto-Pocket Sync", () => {
    it("stages incoming shared files and retrieves them for MicroSD upload", async () => {
      const dummyImg = new Uint8Array(2048);
      dummyImg.fill(0xaa);

      const dummyDoc = new Uint8Array(4096);
      dummyDoc.fill(0xbb);

      bridge.stageMockFile({
        fileName: "pocket_snapshot.rgb565",
        mimeType: "image/rgb565",
        bytes: dummyImg,
      });

      bridge.stageMockFile({
        fileName: "circuit_specs.pdf",
        mimeType: "application/pdf",
        bytes: dummyDoc,
      });

      const pending = await bridge.getPendingVaultFiles();
      expect(pending.length).toBe(2);
      expect(pending[0]?.fileName).toBe("pocket_snapshot.rgb565");
      expect(pending[1]?.fileName).toBe("circuit_specs.pdf");
      expect(pending[0]?.sizeBytes).toBe(2048);
      expect(pending[1]?.sizeBytes).toBe(4096);
    });

    it("syncs staged files to robot MicroSD vault in 16KB CRC32 chunks and cleans staging", async () => {
      const testBytes = new Uint8Array(34000); // ~34KB -> 3 chunks
      testBytes.fill(0x42);

      bridge.stageMockFile({
        fileName: "robot_firmware_note.txt",
        mimeType: "text/plain",
        bytes: testBytes,
      });

      expect((await bridge.getPendingVaultFiles()).length).toBe(1);

      const syncedCount = await orchestrator.syncPocketVault();
      expect(syncedCount).toBe(1);

      // Verify staged files are cleared
      const remaining = await bridge.getPendingVaultFiles();
      expect(remaining.length).toBe(0);
    });
  });

  // ==========================================================================
  // MobileHarnessOrchestrator: Auto-Switching & Robot Tool Bus
  // ==========================================================================
  describe("MobileHarnessOrchestrator: Auto-Switching, TFT HUD & Tool Bus", () => {
    it("triggers automatic partner takeover when mobile connection is detected", async () => {
      // First yield so we start from inactive state
      await orchestrator.yieldToDesktop();
      expect(orchestrator.isActive()).toBe(false);

      let stateActive = false;
      const unsubscribe = orchestrator.onStateChange((active) => {
        stateActive = active;
      });

      // Simulate robot connecting via BLE / Wi-Fi to phone
      await orchestrator.handleConnectionStateChange("BLE_FOUND");
      expect(orchestrator.isActive()).toBe(true);
      expect(stateActive).toBe(true);

      // Yielding to desktop
      await orchestrator.yieldToDesktop();
      expect(orchestrator.isActive()).toBe(false);

      unsubscribe();
    });

    it("streams task progress HUD frames to the robot's 1.8\" TFT display", async () => {
      const sendSpy = vi.spyOn(robotConnection, "sendHarnessRpcRequest");

      const ok = await orchestrator.streamTaskProgressHud({
        title: "Updating Pet Brain...",
        progressPct: 65,
        emotion: EmotionId.FOCUSED,
        details: "Chunk 4 of 6 verified",
      });

      expect(ok).toBe(true);
      expect(sendSpy).toHaveBeenCalled();
      const calledReq = sendSpy.mock.calls[0]![0];
      expect(calledReq.method).toBe("TASK_PROGRESS_HUD");
      expect(calledReq.params.title).toBe("Updating Pet Brain...");
      expect(calledReq.params.progressPct).toBe(65);
      expect(calledReq.params.emotion).toBe(EmotionId.FOCUSED);

      sendSpy.mockRestore();
    });

    it("executes voice-dictated replies from robot microphone silently in background", async () => {
      const notifs = await bridge.getRecentNotifications();
      const targetNotif = notifs.find((n) => n.canReply)!;

      const success = await orchestrator.replyViaVoiceDictation(
        targetNotif.key,
        "Dictated from ESP32-S3 I2S mic: On my way home!"
      );

      expect(success).toBe(true);
      const replies = bridge.getRepliesSent();
      expect(replies.length).toBe(1);
      expect(replies[0]?.text).toBe("Dictated from ESP32-S3 I2S mic: On my way home!");
    });

    it("handles robot RPC requests across all 13+ mobile tools", async () => {
      // 1. mobile_get_unread_notifications
      const resNotifs = await orchestrator.handleRobotRpcRequest({
        callId: "call_1",
        method: "mobile_get_unread_notifications",
        params: {},
      });
      expect(resNotifs.success).toBe(true);
      expect((resNotifs.result as any).count).toBeGreaterThan(0);

      // 2. mobile_make_call
      const resCall = await orchestrator.handleRobotRpcRequest({
        callId: "call_2",
        method: "mobile_make_call",
        params: { phoneNumber: "+1-800-555-0199" },
      });
      expect(resCall.success).toBe(true);

      // 3. mobile_set_alarm
      const resAlarm = await orchestrator.handleRobotRpcRequest({
        callId: "call_3",
        method: "mobile_set_alarm",
        params: { hour: 8, minutes: 30, message: "Standup" },
      });
      expect(resAlarm.success).toBe(true);

      // 4. mobile_set_timer
      const resTimer = await orchestrator.handleRobotRpcRequest({
        callId: "call_4",
        method: "mobile_set_timer",
        params: { seconds: 300, message: "Focus timer" },
      });
      expect(resTimer.success).toBe(true);

      // 5. mobile_start_nav
      const resNav = await orchestrator.handleRobotRpcRequest({
        callId: "call_5",
        method: "mobile_start_nav",
        params: { destination: "Union Square, SF", mode: "walking" },
      });
      expect(resNav.success).toBe(true);

      // 6. mobile_toggle_flashlight
      const resTorch = await orchestrator.handleRobotRpcRequest({
        callId: "call_6",
        method: "mobile_toggle_flashlight",
        params: { enabled: true },
      });
      expect(resTorch.success).toBe(true);

      // 7. mobile_set_ringer
      const resRinger = await orchestrator.handleRobotRpcRequest({
        callId: "call_7",
        method: "mobile_set_ringer",
        params: { mode: "SILENT" },
      });
      expect(resRinger.success).toBe(true);

      // 8. mobile_media_playback
      const resMedia = await orchestrator.handleRobotRpcRequest({
        callId: "call_8",
        method: "mobile_media_playback",
        params: { command: "PLAY" },
      });
      expect(resMedia.success).toBe(true);

      // 9. mobile_inspect_screen
      const resInspect = await orchestrator.handleRobotRpcRequest({
        callId: "call_9",
        method: "mobile_inspect_screen",
        params: {},
      });
      expect(resInspect.success).toBe(true);
      expect((resInspect.result as any).packageName).toBe("com.whatsapp");

      // 10. mobile_click_element
      const resClick = await orchestrator.handleRobotRpcRequest({
        callId: "call_10",
        method: "mobile_click_element",
        params: { resourceId: "com.whatsapp:id/send" },
      });
      expect(resClick.success).toBe(true);

      // 11. mobile_input_text
      const resInput = await orchestrator.handleRobotRpcRequest({
        callId: "call_11",
        method: "mobile_input_text",
        params: { resourceId: "com.whatsapp:id/entry", text: "Automated input" },
      });
      expect(resInput.success).toBe(true);

      // 12. mobile_get_telemetry
      const resTelemetry = await orchestrator.handleRobotRpcRequest({
        callId: "call_12",
        method: "mobile_get_telemetry",
        params: {},
      });
      expect(resTelemetry.success).toBe(true);
      expect((resTelemetry.result as any).batteryPct).toBeDefined();

      // 13. Unknown tool
      const resUnknown = await orchestrator.handleRobotRpcRequest({
        callId: "call_13",
        method: "mobile_unknown_method",
        params: {},
      });
      expect(resUnknown.success).toBe(false);
      expect(resUnknown.error).toContain("Unknown mobile tool method");
    });
  });
});
