import pino from "pino";
import type {
  HostedAutomationPackage,
  AutomationStep,
  RobotCardPreview,
  EmotionType,
} from "@petbot/widget-schema";
import { generatePlainEnglishPipeline } from "@petbot/widget-schema";

export interface DryRunStepPreview {
  readonly stepNumber: number;
  readonly stepId: string;
  readonly title: string;
  readonly plainEnglish: string;
  readonly type: "DESKTOP_TOOL" | "MOBILE_TOOL" | "AI_TRANSFORM" | "ROBOT_ACTION";
  readonly simulatedOutput: string;
  readonly durationMs: number;
  readonly status: "VERIFIED" | "WARNING" | "2FA_REQUIRED";
  readonly mockData: Record<string, any>;
}

export interface SimulatedRobotTftLayout {
  readonly width: 160;
  readonly height: 128;
  readonly headerBadge: string;
  readonly title: string;
  readonly lines: string[];
  readonly petEmotion: EmotionType;
  readonly accentColorRgb565: number;
  readonly soundEffect?: string;
}

export interface AutomationDryRunResult {
  readonly success: boolean;
  readonly totalDurationMs: number;
  readonly stepPreviews: DryRunStepPreview[];
  readonly overallSummary: string;
  readonly robotCardPreview: RobotCardPreview;
  readonly simulatedRobotTftLayout: SimulatedRobotTftLayout;
  readonly riskTier: "TIER_1_SAFE" | "TIER_2_WORKFLOW" | "TIER_3_2FA_REQUIRED";
}

/**
 * AutomationRunner:
 * Safe, instant dry-run sandbox and verification engine for conversational automations.
 * Generates realistic simulation outputs and previews 128x160 robot screen cards
 * before any changes are committed or deployed to physical hardware.
 */
export class AutomationRunner {
  private readonly logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.logger =
      logger ??
      pino({
        name: "petbot-automation-runner",
        level: process.env["LOG_LEVEL"] ?? "info",
      });
  }

  /**
   * Executes an instant safe dry-run simulation of an automation package.
   */
  public async simulateDryRun(pkg: HostedAutomationPackage): Promise<AutomationDryRunResult> {
    const startTime = Date.now();
    const stepPreviews: DryRunStepPreview[] = [];
    const simulatedVariables = new Map<string, any>();

    // Seed realistic mock initial context
    simulatedVariables.set("currentDate", new Date().toLocaleDateString());
    simulatedVariables.set("currentTime", new Date().toLocaleTimeString());
    simulatedVariables.set("userName", "Alex");

    let highestRisk: "TIER_1_SAFE" | "TIER_2_WORKFLOW" | "TIER_3_2FA_REQUIRED" = "TIER_1_SAFE";
    let finalRobotEmotion: EmotionType = pkg.robotCardPreview.emotion;
    let finalAlertTitle = pkg.robotCardPreview.title;
    let finalAlertBody = pkg.robotCardPreview.subtitle;
    let triggeredSound: string | undefined = "CHIRP";

    for (let i = 0; i < pkg.steps.length; i++) {
      const step = pkg.steps[i]!;
      const stepNum = i + 1;
      const stepDuration = Math.floor(25 + Math.random() * 40);

      if (step.requiresTouch2Fa) {
        highestRisk = "TIER_3_2FA_REQUIRED";
      }

      let simulatedOutput = "";
      let status: "VERIFIED" | "WARNING" | "2FA_REQUIRED" = step.requiresTouch2Fa
        ? "2FA_REQUIRED"
        : "VERIFIED";
      const mockData: Record<string, any> = {};

      switch (step.payload.type) {
        case "DESKTOP_TOOL": {
          const tool = step.payload.toolName;
          if (tool.includes("file") || tool.includes("read")) {
            simulatedOutput = "Read 3 unread VIP messages from Sarah, David, and Team Lead.";
            mockData["messages"] = [
              { from: "Sarah", text: "Please review PR #142 for the firmware OTA updater." },
              { from: "David", text: "Board meeting moved to 3:00 PM EST today." },
              { from: "Team Lead", text: "Great work on the 60 FPS widget rendering test!" },
            ];
          } else if (tool.includes("system") || tool.includes("info")) {
            simulatedOutput = "System healthy: CPU 18%, RAM 42%, Battery 88% AC Connected.";
            mockData["cpu"] = 18;
            mockData["ram"] = 42;
          } else {
            simulatedOutput = `Executed headless tool ${tool} in background sandbox without GUI interference.`;
            mockData["executedTool"] = tool;
          }

          if (step.payload.outputVariableKey) {
            simulatedVariables.set(step.payload.outputVariableKey, simulatedOutput);
          }
          break;
        }

        case "MOBILE_TOOL": {
          const mTool = step.payload.toolName;
          if (mTool.includes("reply")) {
            simulatedOutput = "Simulated silent RemoteInput reply via WhatsApp/Telegram without unlocking phone.";
            mockData["targetApp"] = "WhatsApp";
            mockData["replyPayload"] = "Got it! Reviewing this on my robot desk companion now.";
          } else if (mTool.includes("alarm") || mTool.includes("timer")) {
            simulatedOutput = "Scheduled system alarm on smartphone clock app silently.";
            mockData["alarmTime"] = "08:30 AM";
          } else {
            simulatedOutput = `Dispatched mobile background intent ${mTool}.`;
          }

          if (step.payload.outputVariableKey) {
            simulatedVariables.set(step.payload.outputVariableKey, simulatedOutput);
          }
          break;
        }

        case "AI_TRANSFORM": {
          const transform = step.payload.transformType;
          switch (transform) {
            case "SUMMARIZE":
              simulatedOutput = "1. PR #142 ready for OTA review.\n2. Board meeting rescheduled to 3 PM.\n3. 60 FPS widget benchmark passed.";
              break;
            case "EXTRACT_ACTION_ITEMS":
              simulatedOutput = "• [Priority 1] Approve PR #142 before 12 PM\n• [Priority 2] Prepare slides for 3 PM meeting";
              break;
            case "DRAFT_REPLY":
              simulatedOutput = "Thanks Sarah! Testing the signed Ed25519 bundle right now, will merge shortly.";
              break;
            case "ANALYZE_DATA":
              simulatedOutput = "All systems nominal. No hardware thermal throttling detected in the last 24h.";
              break;
            default:
              simulatedOutput = `Processed prompt: "${step.payload.instruction}" with localized transformer model.`;
          }

          if (step.payload.outputVariableKey) {
            simulatedVariables.set(step.payload.outputVariableKey, simulatedOutput);
          }
          break;
        }

        case "ROBOT_ACTION": {
          const rAction = step.payload.actionType;
          const params = step.payload.parameters;

          if (params.emotion) {
            finalRobotEmotion = params.emotion;
          }
          if (params.alertTitle) {
            finalAlertTitle = params.alertTitle;
          }
          if (params.bodyText) {
            finalAlertBody = params.bodyText.startsWith("$")
              ? (simulatedVariables.get(params.bodyText.substring(1)) ?? "All tasks completed.")
              : params.bodyText;
          }
          if (params.soundName) {
            triggeredSound = params.soundName;
          }

          switch (rAction) {
            case "SHOW_ALERT_CARD":
              simulatedOutput = `Displayed High-Contrast Alert Card on 1.8" TFT: "${finalAlertTitle}" with ${finalRobotEmotion} emotion.`;
              break;
            case "PLAY_SOUND":
              simulatedOutput = `Triggered procedural piezo/I2S sound: ${triggeredSound}.`;
              break;
            case "TOUCH_2FA_CHALLENGE":
              simulatedOutput = "Requested physical capacitive Touch 2FA confirmation from user.";
              status = "2FA_REQUIRED";
              highestRisk = "TIER_3_2FA_REQUIRED";
              break;
            case "SAVE_VAULT_FILE":
              simulatedOutput = `Persisted 1.4 KB report to MicroSD: /sd/vault/${params.vaultFileName || "report.txt"}`;
              break;
            case "UPDATE_WIDGET_STATE":
              simulatedOutput = `Updated reactive slot [${params.stateKey || "status"}] on widget ${params.widgetId || pkg.id}.`;
              break;
          }
          break;
        }
      }

      stepPreviews.push({
        stepNumber: stepNum,
        stepId: step.stepId,
        title: step.title,
        plainEnglish: step.plainEnglishDescription,
        type: step.payload.type,
        simulatedOutput,
        durationMs: stepDuration,
        status,
        mockData,
      });
    }

    const totalDuration = Date.now() - startTime + 85; // Simulated execution total

    // Create 160x128 screen preview layout
    const simulatedRobotTftLayout: SimulatedRobotTftLayout = {
      width: 160,
      height: 128,
      headerBadge: pkg.robotCardPreview.headerBadge,
      title: finalAlertTitle,
      lines: [
        pkg.name.toUpperCase(),
        "STATUS: ACTIVE",
        finalAlertBody.split("\n")[0] ?? "All systems nominal",
        finalAlertBody.split("\n")[1] ?? "Tap to trigger",
      ],
      petEmotion: finalRobotEmotion,
      accentColorRgb565: pkg.robotCardPreview.accentColorRgb565,
      soundEffect: triggeredSound,
    };

    return {
      success: true,
      totalDurationMs: totalDuration,
      stepPreviews,
      overallSummary: generatePlainEnglishPipeline(pkg),
      robotCardPreview: {
        ...pkg.robotCardPreview,
        title: finalAlertTitle,
        subtitle: finalAlertBody.substring(0, 40),
        emotion: finalRobotEmotion,
      },
      simulatedRobotTftLayout,
      riskTier: highestRisk,
    };
  }
}
