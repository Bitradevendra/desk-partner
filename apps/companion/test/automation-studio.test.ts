import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AutomationStudioService,
  type AutomationDryRunResult,
} from "../src/services/automation-studio.js";
import {
  compileAutomationToWidgetPackage,
  generatePlainEnglishPipeline,
  type HostedAutomationPackage,
} from "@petbot/widget-schema";
import { robotConnection } from "../src/services/robot-connection.js";

describe("AutomationStudioService (Zero-Code Conversational Studio)", () => {
  let studio: AutomationStudioService;

  beforeEach(() => {
    studio = AutomationStudioService.getInstance();
  });

  describe("Natural Language Compilation (compilePromptToAutomation)", () => {
    it("compiles morning VIP briefing prompt into verified package", async () => {
      const prompt =
        "Every morning at 8:30 AM, read unread WhatsApp messages from VIP contacts, summarize my day's calendar with AI, and display the briefing on the robot screen.";

      const pkg = await studio.compilePromptToAutomation(prompt);

      expect(pkg.name).toBe("Morning VIP Briefing");
      expect(pkg.triggers.length).toBeGreaterThan(0);

      // Verify Cron Trigger
      const cronTrigger = pkg.triggers.find((t) => t.type === "SCHEDULE_CRON");
      expect(cronTrigger).toBeDefined();
      if (cronTrigger && cronTrigger.type === "SCHEDULE_CRON") {
        expect(cronTrigger.runOfflineOnRtc).toBe(true);
        expect(cronTrigger.cronExpression).toBe("30 8 * * 1-5");
      }

      // Verify Steps
      expect(pkg.steps.length).toBeGreaterThanOrEqual(3);
      expect(pkg.steps.some((s) => s.payload.type === "MOBILE_TOOL")).toBe(true);
      expect(pkg.steps.some((s) => s.payload.type === "AI_TRANSFORM")).toBe(true);
      expect(pkg.steps.some((s) => s.payload.type === "ROBOT_ACTION")).toBe(true);

      // Verify Card Preview Metadata
      expect(pkg.robotCardPreview.headerBadge).toBe("VIP BRIEF");
      expect(pkg.robotCardPreview.emotion).toBe("HAPPY");
    });

    it("compiles Focus Mode Pomodoro prompt with touch gesture", async () => {
      const prompt =
        "When I double-tap the robot screen, close distracting browser tabs, set phone to Do Not Disturb, and start a 45-minute Pomodoro timer.";

      const pkg = await studio.compilePromptToAutomation(prompt);

      expect(pkg.name).toBe("Focus Mode & Distraction Shield");

      const touchTrigger = pkg.triggers.find((t) => t.type === "ROBOT_TOUCH_GESTURE");
      expect(touchTrigger).toBeDefined();
      if (touchTrigger && touchTrigger.type === "ROBOT_TOUCH_GESTURE") {
        expect(touchTrigger.gesture).toBe("DOUBLE_TAP");
      }

      expect(pkg.steps.some((s) => s.payload.type === "DESKTOP_TOOL")).toBe(true);
      expect(pkg.steps.some((s) => s.payload.type === "MOBILE_TOOL")).toBe(true);
      expect(pkg.robotCardPreview.headerBadge).toBe("FOCUS");
      expect(pkg.robotCardPreview.emotion).toBe("FOCUSED");
    });

    it("compiles SD Vault Media Backup prompt with system event trigger", async () => {
      const prompt =
        "When a new screenshot or image is added to my desktop screenshots folder, backup the file to /sd/vault/media/ and play a chirp.";

      const pkg = await studio.compilePromptToAutomation(prompt);

      expect(pkg.name).toBe("Auto-SD Media Vault Backup");

      const eventTrigger = pkg.triggers.find((t) => t.type === "SYSTEM_EVENT");
      expect(eventTrigger).toBeDefined();
      if (eventTrigger && eventTrigger.type === "SYSTEM_EVENT") {
        expect(eventTrigger.eventType).toBe("ON_FILE_ADDED_TO_FOLDER");
      }

      expect(pkg.steps.some((s) => s.payload.type === "ROBOT_ACTION")).toBe(true);
      expect(pkg.robotCardPreview.headerBadge).toBe("SD VAULT");
    });
  });

  describe("Conversational Refinement (refineAutomationConversationally)", () => {
    it("updates trigger to double-tap on user conversational request", async () => {
      const initial = await studio.compilePromptToAutomation("Every morning at 8:30 AM do something");
      const refined = await studio.refineAutomationConversationally(initial, "change trigger to double tap");

      const touchTrigger = refined.triggers.find((t) => t.type === "ROBOT_TOUCH_GESTURE");
      expect(touchTrigger).toBeDefined();
      if (touchTrigger && touchTrigger.type === "ROBOT_TOUCH_GESTURE") {
        expect(touchTrigger.gesture).toBe("DOUBLE_TAP");
      }
    });

    it("adds chime sound when user requests audio feedback", async () => {
      const initial = await studio.compilePromptToAutomation("Morning briefing");
      const refined = await studio.refineAutomationConversationally(
        initial,
        "play a chime sound when finished"
      );

      const robotAction = refined.steps.find(
        (s) => s.payload.type === "ROBOT_ACTION" && s.payload.actionType === "PLAY_SOUND"
      );
      expect(robotAction).toBeDefined();
    });

    it("enforces 2FA approval when user asks for security confirmation", async () => {
      const initial = await studio.compilePromptToAutomation("Close all apps");
      const refined = await studio.refineAutomationConversationally(
        initial,
        "require physical 2FA touch approval"
      );

      expect(refined.steps.some((s) => s.requiresTouch2Fa)).toBe(true);
    });

    it("adds SD vault storage step when user asks to save to vault", async () => {
      const initial = await studio.compilePromptToAutomation("Morning briefing");
      const refined = await studio.refineAutomationConversationally(
        initial,
        "save output summary into SD vault"
      );

      const vaultStep = refined.steps.find(
        (s) => s.payload.type === "ROBOT_ACTION" && s.payload.actionType === "SAVE_VAULT_FILE"
      );
      expect(vaultStep).toBeDefined();
    });

    it("changes schedule time when user asks to run at 9 AM", async () => {
      const initial = await studio.compilePromptToAutomation("Morning briefing at 8:30");
      const refined = await studio.refineAutomationConversationally(
        initial,
        "run every morning at 9:00 AM instead"
      );

      const cronTrigger = refined.triggers.find((t) => t.type === "SCHEDULE_CRON");
      expect(cronTrigger).toBeDefined();
      if (cronTrigger && cronTrigger.type === "SCHEDULE_CRON") {
        expect(cronTrigger.cronExpression).toBe("0 9 * * 1-5");
        expect(cronTrigger.humanReadableSchedule).toBe("Weekdays at 9:00 AM");
      }
    });
  });

  describe("Interactive Dry-Run Demo (runDryRunDemo)", () => {
    it("generates deterministic step previews, timing, and 160x128 simulated TFT layout", async () => {
      const pkg = await studio.compilePromptToAutomation(
        "When I double-tap, close browser tabs and set phone DND"
      );

      const dryRun: AutomationDryRunResult = await studio.runDryRunDemo(pkg);

      expect(dryRun.success).toBe(true);
      expect(dryRun.totalDurationMs).toBeGreaterThan(0);
      expect(dryRun.stepPreviews.length).toBe(pkg.steps.length);

      // Verify each step preview
      for (const step of dryRun.stepPreviews) {
        expect(step.status).toBe("VERIFIED");
        expect(step.simulatedOutput).toBeTruthy();
        expect(step.durationMs).toBeGreaterThan(0);
      }

      // Verify 160x128 TFT Layout
      expect(dryRun.simulatedRobotTftLayout.width).toBe(160);
      expect(dryRun.simulatedRobotTftLayout.height).toBe(128);
      expect(dryRun.simulatedRobotTftLayout.headerBadge).toBeTruthy();
      expect(dryRun.simulatedRobotTftLayout.lines.length).toBeGreaterThan(0);
      expect(dryRun.simulatedRobotTftLayout.accentColorRgb565).toBeGreaterThanOrEqual(0);
    });

    it("calculates TIER_3_2FA_REQUIRED when 2FA is enabled", async () => {
      const pkg = await studio.compilePromptToAutomation("Double tap to close apps");
      const securePkg = await studio.refineAutomationConversationally(pkg, "require physical 2FA touch");

      const dryRun = await studio.runDryRunDemo(securePkg);
      expect(dryRun.riskTier).toBe("TIER_3_2FA_REQUIRED");
    });
  });

  describe("Bytecode Compilation & Robot Deployment", () => {
    it("compiles automation package into standard WidgetPackage runnable on ESP32-S3", async () => {
      const pkg = await studio.compilePromptToAutomation("Morning VIP briefing");
      const widget = compileAutomationToWidgetPackage(pkg);

      expect(widget.manifest.id).toBe(`widget-auto-${pkg.id}`);
      expect(widget.manifest.name).toBeTruthy();
      expect(widget.ui).toBeDefined();
      expect(widget.ui.type).toBe("Container");
      expect(widget.triggers.length).toBeGreaterThan(0);
    });

    it("generates plain-English summary checklist for human verification", async () => {
      const pkg = await studio.compilePromptToAutomation("Morning VIP briefing");
      const pipeline = generatePlainEnglishPipeline(pkg);

      expect(typeof pipeline).toBe("string");
      expect(pipeline).toContain("TRIGGER:");
      expect(pipeline).toContain("1.");
    });

    it("deploys widget to robot via deployAndHostOnRobot", async () => {
      const pkg = await studio.compilePromptToAutomation("Morning VIP briefing");

      // Mock robotConnection.deployWidget
      const deploySpy = vi.spyOn(robotConnection, "deployWidget").mockResolvedValue({
        success: true,
        widgetId: pkg.id,
      });

      const res = await studio.deployAndHostOnRobot(pkg);
      expect(res.success).toBe(true);
      expect(res.widgetId).toBe(`widget-auto-${pkg.id}`);
      expect(deploySpy).toHaveBeenCalled();

      deploySpy.mockRestore();
    });
  });
});
