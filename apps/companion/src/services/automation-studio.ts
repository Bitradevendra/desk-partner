import {
  HostedAutomationPackageSchema,
  compileAutomationToWidgetPackage,
  generatePlainEnglishPipeline,
  type HostedAutomationPackage,
  type AutomationStep,
  type AutomationTrigger,
  type EmotionType,
} from "@petbot/widget-schema";
import { robotConnection } from "./robot-connection.js";
import { webAudioSynth } from "./web-audio-synth.js";

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
  readonly robotCardPreview: {
    readonly headerBadge: string;
    readonly title: string;
    readonly subtitle: string;
    readonly accentColorRgb565: number;
    readonly emotion: EmotionType;
    readonly iconId: number;
  };
  readonly simulatedRobotTftLayout: SimulatedRobotTftLayout;
  readonly riskTier: "TIER_1_SAFE" | "TIER_2_WORKFLOW" | "TIER_3_2FA_REQUIRED";
}

/**
 * Conversational Automation Studio:
 * Natural language compiler and dry-run preview orchestrator for the Zero-Code Automation Builder.
 * Converts spoken/typed requests into verified cross-device pipelines hosted on the ESP32-S3 and Harness.
 */
export class AutomationStudioService {
  private static instance: AutomationStudioService | null = null;

  public static getInstance(): AutomationStudioService {
    if (!AutomationStudioService.instance) {
      AutomationStudioService.instance = new AutomationStudioService();
    }
    return AutomationStudioService.instance;
  }

  /**
   * Compiles natural language input into a complete, verified HostedAutomationPackage.
   */
  public async compilePromptToAutomation(userPrompt: string): Promise<HostedAutomationPackage> {
    const lower = userPrompt.toLowerCase();
    const id = `auto_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    // 1. Infer Triggers
    const triggers: AutomationTrigger[] = [];

    if (lower.includes("every morning") || lower.includes("8:30") || lower.includes("8 am") || lower.includes("9 am") || lower.includes("weekday")) {
      triggers.push({
        type: "SCHEDULE_CRON",
        cronExpression: lower.includes("9") ? "0 9 * * 1-5" : "30 8 * * 1-5",
        humanReadableSchedule: lower.includes("9") ? "Weekdays at 9:00 AM" : "Weekdays at 8:30 AM",
        runOfflineOnRtc: true,
        timezone: "America/New_York",
      });
    } else if (lower.includes("hour") || lower.includes("every 2 hours")) {
      triggers.push({
        type: "SCHEDULE_CRON",
        cronExpression: "0 */2 * * *",
        humanReadableSchedule: "Every 2 hours",
        runOfflineOnRtc: true,
        timezone: "UTC",
      });
    }

    if (lower.includes("voice") || lower.includes("say") || lower.includes("shortcut")) {
      const match = userPrompt.match(/['"](.*?)['"]/);
      const voiceShortcut = match ? match[1]! : "start automation";
      triggers.push({
        type: "VOICE_PHRASE",
        voiceShortcut,
        activationPhrases: [voiceShortcut, `hey petbot ${voiceShortcut}`],
      });
    }

    if (lower.includes("added to") || lower.includes("new file") || lower.includes("file added") || lower.includes("screenshot")) {
      triggers.push({
        type: "SYSTEM_EVENT",
        eventType: "ON_FILE_ADDED_TO_FOLDER",
        label: "File Added to Folder",
      });
    } else if (lower.includes("meeting") || lower.includes("calendar")) {
      triggers.push({
        type: "SYSTEM_EVENT",
        eventType: "ON_MEETING_START",
        label: "Meeting Started",
      });
    } else if (lower.includes("battery") || lower.includes("low power")) {
      triggers.push({
        type: "SYSTEM_EVENT",
        eventType: "ON_BATTERY_LOW",
        label: "Battery Below 20%",
      });
    }

    if (lower.includes("tap") || lower.includes("touch") || lower.includes("screen") || triggers.length === 0) {
      const gesture = lower.includes("double") ? "DOUBLE_TAP" : lower.includes("hold") ? "LONG_PRESS" : "SINGLE_TAP";
      triggers.push({
        type: "ROBOT_TOUCH_GESTURE",
        gesture,
        widgetId: `widget-${id}`,
        label: `${gesture.replace("_", " ")} on Robot`,
      });
    }

    // 2. Infer Steps
    const steps: AutomationStep[] = [];
    let stepCount = 1;

    // Step 1: Input / Inspection
    if (lower.includes("slack") || lower.includes("message") || lower.includes("vip") || lower.includes("email") || lower.includes("read")) {
      steps.push({
        stepId: `step_${stepCount++}`,
        title: "Inspect Unread VIP Messages",
        plainEnglishDescription: "Reads latest incoming messages from VIP senders without opening apps",
        payload: {
          type: "DESKTOP_TOOL",
          toolName: "desktop_read_file",
          parameters: { query: "vip_messages" },
          outputVariableKey: "vipMessages",
        },
        requiresTouch2Fa: false,
        failPolicy: "CONTINUE_WITH_DEFAULT",
      });
    } else if (lower.includes("focus") || lower.includes("deep work") || lower.includes("distraction")) {
      steps.push({
        stepId: `step_${stepCount++}`,
        title: "Engage Focus Shield",
        plainEnglishDescription: "Suppresses non-urgent desktop notifications and pauses noisy browser tabs",
        payload: {
          type: "DESKTOP_TOOL",
          toolName: "desktop_system_info",
          parameters: { muteAudio: true },
          outputVariableKey: "focusState",
        },
        requiresTouch2Fa: false,
        failPolicy: "CONTINUE_WITH_DEFAULT",
      });
    } else {
      steps.push({
        stepId: `step_${stepCount++}`,
        title: "Check System Environment",
        plainEnglishDescription: "Gathers system telemetry and active work context in background",
        payload: {
          type: "DESKTOP_TOOL",
          toolName: "desktop_system_info",
          parameters: {},
          outputVariableKey: "systemContext",
        },
        requiresTouch2Fa: false,
        failPolicy: "CONTINUE_WITH_DEFAULT",
      });
    }

    // Step 2: AI Transform
    if (lower.includes("action item") || lower.includes("tasks")) {
      steps.push({
        stepId: `step_${stepCount++}`,
        title: "Extract Priority Action Items",
        plainEnglishDescription: "Identifies top 3 urgent tasks and formats actionable bullet points",
        payload: {
          type: "AI_TRANSFORM",
          transformType: "EXTRACT_ACTION_ITEMS",
          instruction: "Extract priority action items with deadlines",
          inputVariableKey: steps[0]?.payload.outputVariableKey || "inputData",
          outputVariableKey: "extractedActions",
        },
        requiresTouch2Fa: false,
        failPolicy: "ABORT",
      });
    } else {
      steps.push({
        stepId: `step_${stepCount++}`,
        title: "AI Synthesis & Summary",
        plainEnglishDescription: "Synthesizes data into a concise 20-word executive summary",
        payload: {
          type: "AI_TRANSFORM",
          transformType: "SUMMARIZE",
          instruction: "Summarize top priority updates into 2 bullet points",
          inputVariableKey: steps[0]?.payload.outputVariableKey || "inputData",
          outputVariableKey: "summaryText",
        },
        requiresTouch2Fa: false,
        failPolicy: "ABORT",
      });
    }

    // Step 3: Optional Mobile Action
    if (lower.includes("reply") || lower.includes("whatsapp") || lower.includes("phone")) {
      steps.push({
        stepId: `step_${stepCount++}`,
        title: "Send Silent RemoteInput Reply",
        plainEnglishDescription: "Sends pre-approved contextual reply in background without unlocking phone",
        payload: {
          type: "MOBILE_TOOL",
          toolName: "mobile_send_reply",
          parameters: { message: "Reviewing on robot desk companion now!" },
          outputVariableKey: "replyStatus",
        },
        requiresTouch2Fa: lower.includes("confirm") || lower.includes("2fa"),
        failPolicy: "CONTINUE_WITH_DEFAULT",
      });
    }

    // Step 4: Robot Alert & Expression
    const robotEmotion: EmotionType = lower.includes("sleepy") || lower.includes("night")
      ? "SLEEPY"
      : lower.includes("focus") || lower.includes("pomodoro")
      ? "FOCUSED"
      : lower.includes("alert") || lower.includes("urgent")
      ? "ALERT"
      : "HAPPY";

    const soundName = lower.includes("purr")
      ? "PURR"
      : lower.includes("success")
      ? "SUCCESS"
      : lower.includes("alert")
      ? "WARNING"
      : "CHIRP";

    steps.push({
      stepId: `step_${stepCount++}`,
      title: "Display Live Card on Robot",
      plainEnglishDescription: `Shows summary card on 1.8" TFT with ${robotEmotion} eyes and plays ${soundName} sound`,
      payload: {
        type: "ROBOT_ACTION",
        actionType: "SHOW_ALERT_CARD",
        parameters: {
          alertTitle: "ACTIVE BRIEFING",
          bodyText: "$summaryText",
          soundName,
          emotion: robotEmotion,
        },
      },
      requiresTouch2Fa: false,
      failPolicy: "CONTINUE_WITH_DEFAULT",
    });

    // 3. Name & Robot Card Preview
    const name = lower.includes("morning") || lower.includes("briefing")
      ? "Morning VIP Briefing"
      : lower.includes("focus") || lower.includes("pomodoro")
      ? "Focus Mode & Distraction Shield"
      : lower.includes("vault") || lower.includes("backup")
      ? "Auto-SD Media Vault Backup"
      : lower.includes("meeting")
      ? "Meeting Distraction Shield"
      : lower.includes("battery")
      ? "Battery Guardian Alert"
      : "Custom Auto Pipeline";

    const headerBadge = (
      lower.includes("morning") || lower.includes("vip")
        ? "VIP BRIEF"
        : lower.includes("focus")
        ? "FOCUS"
        : lower.includes("vault") || lower.includes("backup")
        ? "SD VAULT"
        : lower.includes("meeting")
        ? "MEETING"
        : name.substring(0, 6)
    ).trim().toUpperCase();

    const pkg: HostedAutomationPackage = {
      id,
      name,
      description: userPrompt,
      icon: lower.includes("morning") ? "Sunrise" : lower.includes("focus") ? "Shield" : "Zap",
      version: "1.0.0",
      createdAt: Date.now(),
      hostingTarget: "HYBRID_MESH",
      plainEnglishSummary: "",
      triggers,
      steps,
      robotCardPreview: {
        headerBadge,
        title: name.toUpperCase(),
        subtitle: "Active · Tap to Trigger",
        accentColorRgb565: robotEmotion === "FOCUSED" ? 0x001f : 0x07e0, // Blue or Green
        emotion: robotEmotion,
        iconId: 1,
      },
      enabled: true,
    };

    pkg.plainEnglishSummary = generatePlainEnglishPipeline(pkg);
    return HostedAutomationPackageSchema.parse(pkg);
  }

  /**
   * Refines an existing automation conversationally based on user tweak requests.
   */
  public async refineAutomationConversationally(
    current: HostedAutomationPackage,
    tweakRequest: string
  ): Promise<HostedAutomationPackage> {
    const lower = tweakRequest.toLowerCase();
    const updated = JSON.parse(JSON.stringify(current)) as HostedAutomationPackage;

    // Tweak: Trigger
    if (lower.includes("double-tap") || lower.includes("double tap")) {
      updated.triggers = [
        {
          type: "ROBOT_TOUCH_GESTURE",
          gesture: "DOUBLE_TAP",
          widgetId: `widget-${updated.id}`,
          label: "Double Tap on Robot",
        },
      ];
    } else if (lower.includes("single-tap") || lower.includes("single tap")) {
      updated.triggers = [
        {
          type: "ROBOT_TOUCH_GESTURE",
          gesture: "SINGLE_TAP",
          widgetId: `widget-${updated.id}`,
          label: "Single Tap on Robot",
        },
      ];
    } else if (lower.includes("long press") || lower.includes("hold")) {
      updated.triggers = [
        {
          type: "ROBOT_TOUCH_GESTURE",
          gesture: "LONG_PRESS",
          widgetId: `widget-${updated.id}`,
          label: "Hold Screen on Robot",
        },
      ];
    }

    // Tweak: Sound
    if (lower.includes("purr")) {
      const robotStep = updated.steps.find((s) => s.payload.type === "ROBOT_ACTION");
      if (robotStep && robotStep.payload.type === "ROBOT_ACTION") {
        robotStep.payload.parameters.soundName = "PURR";
        robotStep.plainEnglishDescription = robotStep.plainEnglishDescription.replace(/plays \w+ sound/, "plays PURR sound");
      }
    } else if (lower.includes("chirp")) {
      const robotStep = updated.steps.find((s) => s.payload.type === "ROBOT_ACTION");
      if (robotStep && robotStep.payload.type === "ROBOT_ACTION") {
        robotStep.payload.parameters.soundName = "CHIRP";
      }
    } else if (lower.includes("chime") || lower.includes("alarm")) {
      const hasSoundStep = updated.steps.some(
        (s) => s.payload.type === "ROBOT_ACTION" && s.payload.actionType === "PLAY_SOUND"
      );
      if (!hasSoundStep) {
        updated.steps.push({
          stepId: `step_${updated.steps.length + 1}`,
          title: "Play Completion Chime",
          plainEnglishDescription: "Plays celebratory completion chime on robot speaker",
          payload: {
            type: "ROBOT_ACTION",
            actionType: "PLAY_SOUND",
            parameters: { soundName: "CHIME" },
          },
          requiresTouch2Fa: false,
          failPolicy: "CONTINUE_WITH_DEFAULT",
        });
      }
    }

    // Tweak: Touch 2FA confirmation
    if (lower.includes("2fa") || lower.includes("require physical") || lower.includes("require confirmation") || lower.includes("approval")) {
      for (const step of updated.steps) {
        step.requiresTouch2Fa = true;
      }
    }

    // Tweak: Schedule
    if (lower.includes("every hour") || lower.includes("hourly")) {
      const cronTrigger = updated.triggers.find((t) => t.type === "SCHEDULE_CRON");
      if (cronTrigger && cronTrigger.type === "SCHEDULE_CRON") {
        cronTrigger.cronExpression = "0 * * * *";
        cronTrigger.humanReadableSchedule = "Every hour";
      }
    } else if (lower.includes("9 am") || lower.includes("9:00")) {
      const cronTrigger = updated.triggers.find((t) => t.type === "SCHEDULE_CRON");
      if (cronTrigger && cronTrigger.type === "SCHEDULE_CRON") {
        cronTrigger.cronExpression = "0 9 * * 1-5";
        cronTrigger.humanReadableSchedule = "Weekdays at 9:00 AM";
      }
    }

    // Tweak: Emotion
    if (lower.includes("curious")) {
      updated.robotCardPreview.emotion = "CURIOUS";
    } else if (lower.includes("happy")) {
      updated.robotCardPreview.emotion = "HAPPY";
    } else if (lower.includes("focused")) {
      updated.robotCardPreview.emotion = "FOCUSED";
    }

    // Tweak: Save to SD vault
    if (lower.includes("sd") || lower.includes("save to vault") || lower.includes("save to card")) {
      const hasVault = updated.steps.some(
        (s) => s.payload.type === "ROBOT_ACTION" && s.payload.actionType === "SAVE_VAULT_FILE"
      );
      if (!hasVault) {
        updated.steps.push({
          stepId: `step_${updated.steps.length + 1}`,
          title: "Save Summary to MicroSD",
          plainEnglishDescription: "Writes timestamped report to robot's MicroSD: /sd/vault/briefing.txt",
          payload: {
            type: "ROBOT_ACTION",
            actionType: "SAVE_VAULT_FILE",
            parameters: { vaultFileName: "briefing_note.txt" },
          },
          requiresTouch2Fa: false,
          failPolicy: "CONTINUE_WITH_DEFAULT",
        });
      }
    }

    updated.plainEnglishSummary = generatePlainEnglishPipeline(updated);
    return HostedAutomationPackageSchema.parse(updated);
  }

  /**
   * Runs an instant safe dry run simulation.
   */
  public async runDryRunDemo(pkg: HostedAutomationPackage): Promise<AutomationDryRunResult> {
    const stepPreviews: DryRunStepPreview[] = [];
    const startTime = Date.now();
    let highestRisk: "TIER_1_SAFE" | "TIER_2_WORKFLOW" | "TIER_3_2FA_REQUIRED" = "TIER_1_SAFE";

    for (let i = 0; i < pkg.steps.length; i++) {
      const step = pkg.steps[i]!;
      const is2Fa = step.requiresTouch2Fa;
      if (is2Fa) highestRisk = "TIER_3_2FA_REQUIRED";

      let simulatedOutput = "";
      if (step.payload.type === "DESKTOP_TOOL") {
        simulatedOutput = "Read 3 unread VIP messages from Sarah, David, and Team Lead.";
      } else if (step.payload.type === "MOBILE_TOOL") {
        simulatedOutput = "Prepared silent WhatsApp RemoteInput reply in background.";
      } else if (step.payload.type === "AI_TRANSFORM") {
        simulatedOutput = "1. PR #142 ready for OTA review.\n2. Board meeting rescheduled to 3 PM.\n3. 60 FPS widget benchmark passed.";
      } else {
        simulatedOutput = `Displayed High-Contrast Card on 1.8" TFT: "${pkg.robotCardPreview.title}" with ${pkg.robotCardPreview.emotion} eyes.`;
      }

      stepPreviews.push({
        stepNumber: i + 1,
        stepId: step.stepId,
        title: step.title,
        plainEnglish: step.plainEnglishDescription,
        type: step.payload.type,
        simulatedOutput,
        durationMs: 35,
        status: is2Fa ? "2FA_REQUIRED" : "VERIFIED",
        mockData: {},
      });
    }

    const simulatedRobotTftLayout: SimulatedRobotTftLayout = {
      width: 160,
      height: 128,
      headerBadge: pkg.robotCardPreview.headerBadge,
      title: pkg.robotCardPreview.title,
      lines: [
        pkg.name.toUpperCase(),
        "STATUS: ACTIVE",
        "Tap screen to run",
        "Zero-code pipeline ready",
      ],
      petEmotion: pkg.robotCardPreview.emotion,
      accentColorRgb565: pkg.robotCardPreview.accentColorRgb565,
      soundEffect: "CHIRP",
    };

    return {
      success: true,
      totalDurationMs: Date.now() - startTime + 60,
      stepPreviews,
      overallSummary: generatePlainEnglishPipeline(pkg),
      robotCardPreview: pkg.robotCardPreview,
      simulatedRobotTftLayout,
      riskTier: highestRisk,
    };
  }

  /**
   * Deploys and hosts the automation package on the physical ESP32-S3 and Desktop Harness.
   */
  public async deployAndHostOnRobot(pkg: HostedAutomationPackage): Promise<{
    success: boolean;
    widgetId: string;
    message: string;
  }> {
    // 1. Compile 128x160 Widget Package for robot
    const widgetPackage = compileAutomationToWidgetPackage(pkg);

    // 2. Deploy bytecode directly to ESP32-S3 Octal PSRAM/Flash
    const delivered = await robotConnection.deployWidget(widgetPackage);
    if (!delivered) {
      return {
        success: false,
        widgetId: widgetPackage.manifest.id,
        message: "Not connected to Lobo. Pair over Wi-Fi or Bluetooth before saving to the device.",
      };
    }

    // 3. Play friendly celebratory chime
    webAudioSynth.play("SUCCESS");

    return {
      success: true,
      widgetId: widgetPackage.manifest.id,
      message: `Saved "${pkg.name}" to your Lobo device.`,
    };
  }
}

export const automationStudio = AutomationStudioService.getInstance();
