import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  AutomationRunner,
  AutomationHostEngine,
  type HostedAutomationPackage,
} from "../src/index.js";

describe("AutomationRunner & AutomationHostEngine", () => {
  let tempStorageDir: string;
  let runner: AutomationRunner;
  let engine: AutomationHostEngine;

  const samplePackage: HostedAutomationPackage = {
    id: "auto-focus-deep-work",
    name: "Focus Deep Work Shield",
    description: "Blocks notifications, sets calm lighting, and updates robot expression",
    icon: "ShieldAlert",
    version: "1.0.0",
    createdAt: Date.now(),
    hostingTarget: "HYBRID_MESH",
    plainEnglishSummary: "When you double tap the robot, engages focus mode for 45 minutes, mutes PC notifications, and shows focused eyes on the robot.",
    triggers: [
      {
        type: "ROBOT_TOUCH_GESTURE",
        gesture: "DOUBLE_TAP",
        widgetId: "widget-auto-focus",
        label: "Double Tap Robot",
      },
      {
        type: "VOICE_PHRASE",
        voiceShortcut: "focus mode",
        activationPhrases: ["start focus mode", "focus mode", "deep work"],
      },
    ],
    steps: [
      {
        stepId: "step_1",
        title: "Engage Focus Notification Shield",
        plainEnglishDescription: "Suppresses non-urgent desktop notifications",
        payload: {
          type: "DESKTOP_TOOL",
          toolName: "desktop_system_info",
          parameters: {},
          outputVariableKey: "systemState",
        },
        requiresTouch2Fa: false,
        failPolicy: "CONTINUE_WITH_DEFAULT",
      },
      {
        stepId: "step_2",
        title: "Analyze Work Context",
        plainEnglishDescription: "Determines active project task from calendar",
        payload: {
          type: "AI_TRANSFORM",
          transformType: "EXTRACT_ACTION_ITEMS",
          instruction: "Extract current focus objective",
          inputVariableKey: "systemState",
          outputVariableKey: "focusObjective",
        },
        requiresTouch2Fa: false,
        failPolicy: "CONTINUE_WITH_DEFAULT",
      },
      {
        stepId: "step_3",
        title: "Update Robot Display & Eyes",
        plainEnglishDescription: "Sets robot eyes to FOCUSED and shows countdown timer card",
        payload: {
          type: "ROBOT_ACTION",
          actionType: "SHOW_ALERT_CARD",
          parameters: {
            alertTitle: "DEEP WORK",
            bodyText: "Focus Shield Active (45m)",
            soundName: "PURR",
            emotion: "FOCUSED",
          },
        },
        requiresTouch2Fa: false,
        failPolicy: "CONTINUE_WITH_DEFAULT",
      },
    ],
    robotCardPreview: {
      headerBadge: "FOCUS",
      title: "DEEP WORK",
      subtitle: "45m Sprint Active",
      accentColorRgb565: 0x001f, // Blue
      emotion: "FOCUSED",
      iconId: 4,
    },
    enabled: true,
  };

  beforeEach(() => {
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot-auto-test-"));
    runner = new AutomationRunner();
    engine = new AutomationHostEngine({ storageDir: tempStorageDir });
  });

  afterEach(() => {
    engine.destroy();
    if (fs.existsSync(tempStorageDir)) {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    }
  });

  it("simulates an instant safe dry-run with step-by-step plain-English verification previews", async () => {
    const dryRun = await runner.simulateDryRun(samplePackage);

    expect(dryRun.success).toBe(true);
    expect(dryRun.totalDurationMs).toBeGreaterThan(0);
    expect(dryRun.stepPreviews.length).toBe(3);

    // Step 1 check
    const step1 = dryRun.stepPreviews[0]!;
    expect(step1.stepNumber).toBe(1);
    expect(step1.type).toBe("DESKTOP_TOOL");
    expect(step1.status).toBe("VERIFIED");
    expect(step1.simulatedOutput).toContain("System healthy");

    // Step 2 check
    const step2 = dryRun.stepPreviews[1]!;
    expect(step2.stepNumber).toBe(2);
    expect(step2.type).toBe("AI_TRANSFORM");
    expect(step2.status).toBe("VERIFIED");
    expect(step2.simulatedOutput).toContain("Priority");

    // Step 3 check
    const step3 = dryRun.stepPreviews[2]!;
    expect(step3.stepNumber).toBe(3);
    expect(step3.type).toBe("ROBOT_ACTION");
    expect(step3.status).toBe("VERIFIED");
    expect(step3.simulatedOutput).toContain("Alert Card");

    // 160x128 TFT Screen Preview layout check
    expect(dryRun.simulatedRobotTftLayout.width).toBe(160);
    expect(dryRun.simulatedRobotTftLayout.height).toBe(128);
    expect(dryRun.simulatedRobotTftLayout.petEmotion).toBe("FOCUSED");
    expect(dryRun.simulatedRobotTftLayout.headerBadge).toBe("FOCUS");
    expect(dryRun.simulatedRobotTftLayout.lines.length).toBeGreaterThanOrEqual(3);
  });

  it("hosts automation package on robot and harness with persistent disk storage", async () => {
    const hostResult = await engine.hostOnRobot(samplePackage);
    expect(hostResult.success).toBe(true);
    expect(hostResult.packageId).toBe("auto-focus-deep-work");
    expect(hostResult.widgetId).toBe("widget-auto-auto-focus-deep-work");

    // Verify stored on disk
    const storedFile = path.join(tempStorageDir, "auto-focus-deep-work.json");
    expect(fs.existsSync(storedFile)).toBe(true);

    const list = engine.listHostedAutomations();
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe("auto-focus-deep-work");
    expect(list[0]?.name).toBe("Focus Deep Work Shield");
  });

  it("executes live automation pipeline end-to-end and captures variable state", async () => {
    await engine.hostOnRobot(samplePackage);

    const execResult = await engine.executeLive("auto-focus-deep-work", {
      triggerSource: "MANUAL_TEST",
    });

    expect(execResult.success).toBe(true);
    expect(execResult.stepsExecuted).toBe(3);
    expect(execResult.outputVariables["focusObjective"]).toBeDefined();
    expect(execResult.completedAt).toBeGreaterThanOrEqual(execResult.triggeredAt);
  });

  it("unhosts and cleans up automation cleanly", async () => {
    await engine.hostOnRobot(samplePackage);
    expect(engine.listHostedAutomations().length).toBe(1);

    const unhosted = engine.unhostAutomation("auto-focus-deep-work");
    expect(unhosted).toBe(true);
    expect(engine.listHostedAutomations().length).toBe(0);

    const storedFile = path.join(tempStorageDir, "auto-focus-deep-work.json");
    expect(fs.existsSync(storedFile)).toBe(false);
  });
});
