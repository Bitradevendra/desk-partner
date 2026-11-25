import { z } from "zod";
import {
  EmotionTypeSchema,
  type EmotionType,
  type WidgetPackage,
  type ColorValue,
} from "./schema.js";

/**
 * ============================================================================
 * Zero-Code Conversational Automation DSL (HostedAutomationPackage)
 * Designed for non-technical users: zero code, zero node graphs, zero YAML.
 * Executable across Desktop Harness, Mobile Partner, and standalone ESP32-S3.
 * ============================================================================
 */

// --- Trigger Schemas ---

export const TouchGestureTriggerSchema = z.object({
  type: z.literal("ROBOT_TOUCH_GESTURE"),
  gesture: z.enum([
    "SINGLE_TAP",
    "DOUBLE_TAP",
    "LONG_PRESS",
    "LEFT_TAP",
    "LEFT_DOUBLE_TAP",
    "LEFT_LONG_PRESS",
    "LEFT_PETTING",
    "RIGHT_TAP",
    "RIGHT_DOUBLE_TAP",
    "RIGHT_LONG_PRESS",
    "RIGHT_PETTING",
    "SWIPE_LEFT_TO_RIGHT",
    "SWIPE_RIGHT_TO_LEFT",
    "DUAL_TAP",
    "DUAL_LONG_PRESS",
    "DUAL_PETTING",
    "SIDE_TAP",
    "SIDE_DOUBLE_TAP",
    "SIDE_LONG_PRESS",
    "SIDE_PETTING",
    "RIGHT_PINCH",
    "CROSS_CHORD",
    "SWIPE_TOP_TO_SIDE",
    "SWIPE_SIDE_TO_TOP",
    "TRIPLE_TAP",
    "TRIPLE_LONG_PRESS",
    "FULL_BODY_GROOM",
  ]),
  widgetId: z.string().min(1),
  label: z.string().default("Tap on Robot"),
});
export type TouchGestureTrigger = z.infer<typeof TouchGestureTriggerSchema>;

export const ScheduleCronTriggerSchema = z.object({
  type: z.literal("SCHEDULE_CRON"),
  cronExpression: z.string().min(1),
  humanReadableSchedule: z.string().min(1),
  runOfflineOnRtc: z.boolean().default(true),
  timezone: z.string().default("UTC"),
});
export type ScheduleCronTrigger = z.infer<typeof ScheduleCronTriggerSchema>;

export const SystemEventTypeSchema = z.enum([
  "ON_PC_UNLOCK",
  "ON_MEETING_START",
  "ON_MOBILE_NOTIFICATION_FROM_VIP",
  "ON_FILE_ADDED_TO_FOLDER",
  "ON_BATTERY_LOW",
  "ON_CLIPBOARD_COPY",
]);
export type SystemEventType = z.infer<typeof SystemEventTypeSchema>;

export const SystemEventTriggerSchema = z.object({
  type: z.literal("SYSTEM_EVENT"),
  eventType: SystemEventTypeSchema,
  eventFilter: z.record(z.string(), z.any()).optional(),
  label: z.string().default("System Event"),
});
export type SystemEventTrigger = z.infer<typeof SystemEventTriggerSchema>;

export const VoicePhraseTriggerSchema = z.object({
  type: z.literal("VOICE_PHRASE"),
  voiceShortcut: z.string().min(1),
  activationPhrases: z.array(z.string().min(1)),
});
export type VoicePhraseTrigger = z.infer<typeof VoicePhraseTriggerSchema>;

export const AutomationTriggerSchema = z.discriminatedUnion("type", [
  TouchGestureTriggerSchema,
  ScheduleCronTriggerSchema,
  SystemEventTriggerSchema,
  VoicePhraseTriggerSchema,
]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

// --- Execution Step Schemas ---

export const DesktopToolStepSchema = z.object({
  type: z.literal("DESKTOP_TOOL"),
  toolName: z.string().min(1),
  parameters: z.record(z.string(), z.any()).default({}),
  outputVariableKey: z.string().optional(),
});
export type DesktopToolStep = z.infer<typeof DesktopToolStepSchema>;

export const MobileToolStepSchema = z.object({
  type: z.literal("MOBILE_TOOL"),
  toolName: z.string().min(1),
  parameters: z.record(z.string(), z.any()).default({}),
  outputVariableKey: z.string().optional(),
});
export type MobileToolStep = z.infer<typeof MobileToolStepSchema>;

export const AiTransformTypeSchema = z.enum([
  "SUMMARIZE",
  "EXTRACT_ACTION_ITEMS",
  "DRAFT_REPLY",
  "ANALYZE_DATA",
  "TRANSLATE",
  "CUSTOM",
]);
export type AiTransformType = z.infer<typeof AiTransformTypeSchema>;

export const AiTransformStepSchema = z.object({
  type: z.literal("AI_TRANSFORM"),
  transformType: AiTransformTypeSchema,
  instruction: z.string().min(1),
  inputVariableKey: z.string().min(1),
  outputVariableKey: z.string().min(1),
});
export type AiTransformStep = z.infer<typeof AiTransformStepSchema>;

export const RobotActionTypeSchema = z.enum([
  "UPDATE_WIDGET_STATE",
  "SHOW_ALERT_CARD",
  "PLAY_SOUND",
  "TOUCH_2FA_CHALLENGE",
  "SAVE_VAULT_FILE",
]);
export type RobotActionType = z.infer<typeof RobotActionTypeSchema>;

export const RobotActionParamsSchema = z.object({
  widgetId: z.string().optional(),
  stateKey: z.string().optional(),
  stateValue: z.any().optional(),
  alertTitle: z.string().optional(),
  bodyText: z.string().optional(),
  soundName: z.string().optional(),
  emotion: EmotionTypeSchema.optional(),
  vaultFileName: z.string().optional(),
});
export type RobotActionParams = z.infer<typeof RobotActionParamsSchema>;

export const RobotActionStepSchema = z.object({
  type: z.literal("ROBOT_ACTION"),
  actionType: RobotActionTypeSchema,
  parameters: RobotActionParamsSchema.default({}),
  outputVariableKey: z.string().optional(),
});
export type RobotActionStep = z.infer<typeof RobotActionStepSchema>;

export const AutomationStepPayloadSchema = z.discriminatedUnion("type", [
  DesktopToolStepSchema,
  MobileToolStepSchema,
  AiTransformStepSchema,
  RobotActionStepSchema,
]);
export type AutomationStepPayload = z.infer<typeof AutomationStepPayloadSchema>;

export const StepFailPolicySchema = z.enum(["ABORT", "CONTINUE_WITH_DEFAULT", "FALLBACK_OFFLINE"]);
export type StepFailPolicy = z.infer<typeof StepFailPolicySchema>;

export const AutomationStepSchema = z.object({
  stepId: z.string().min(1),
  title: z.string().min(1),
  plainEnglishDescription: z.string().min(1),
  payload: AutomationStepPayloadSchema,
  requiresTouch2Fa: z.boolean().default(false),
  failPolicy: StepFailPolicySchema.default("ABORT"),
});
export type AutomationStep = z.infer<typeof AutomationStepSchema>;

// --- Robot Card Preview Schema ---

export const RobotCardPreviewSchema = z.object({
  headerBadge: z.string().default("AUTO"),
  title: z.string().min(1).default("Automation"),
  subtitle: z.string().default("Ready"),
  accentColorRgb565: z.number().int().min(0).max(0xffff).default(0x07e0), // Emerald green
  emotion: EmotionTypeSchema.default("HAPPY"),
  iconId: z.number().int().default(1),
});
export type RobotCardPreview = z.infer<typeof RobotCardPreviewSchema>;

// --- Hosted Automation Package ---

export const HostingTargetSchema = z.enum([
  "ROBOT_STANDALONE",
  "DESKTOP_HARNESS",
  "MOBILE_HARNESS",
  "HYBRID_MESH",
]);
export type HostingTarget = z.infer<typeof HostingTargetSchema>;

export const HostedAutomationPackageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  icon: z.string().default("Zap"),
  version: z.string().default("1.0.0"),
  createdAt: z.number().default(() => Date.now()),
  hostingTarget: HostingTargetSchema.default("HYBRID_MESH"),
  plainEnglishSummary: z.string().min(1),
  triggers: z.array(AutomationTriggerSchema).min(1),
  steps: z.array(AutomationStepSchema).min(1),
  robotCardPreview: RobotCardPreviewSchema.default({}),
  enabled: z.boolean().default(true),
});
export type HostedAutomationPackage = z.infer<typeof HostedAutomationPackageSchema>;

// ============================================================================
// Helper Utilities
// ============================================================================

/**
 * Formats a clean step-by-step plain-English verification summary of an automation package.
 */
export function generatePlainEnglishPipeline(pkg: HostedAutomationPackage): string {
  const parts: string[] = [];

  // Triggers description
  const triggerDescs = pkg.triggers.map((t) => {
    switch (t.type) {
      case "ROBOT_TOUCH_GESTURE":
        return `When you ${t.gesture.toLowerCase().replace("_", " ")} on the robot`;
      case "SCHEDULE_CRON":
        return `Every ${t.humanReadableSchedule}`;
      case "SYSTEM_EVENT":
        return `On ${t.eventType.toLowerCase().replace(/_/g, " ")}`;
      case "VOICE_PHRASE":
        return `When you say "${t.voiceShortcut}"`;
    }
  });

  parts.push(`TRIGGER: ${triggerDescs.join(" OR ")}`);

  // Step breakdown
  pkg.steps.forEach((step, idx) => {
    let prefix = `${idx + 1}. ${step.title}`;
    if (step.requiresTouch2Fa) {
      prefix += " [Physical Touch 2FA Required]";
    }
    parts.push(`-> ${prefix}: ${step.plainEnglishDescription}`);
  });

  return parts.join("\n");
}

/**
 * Compiles a HostedAutomationPackage into a reactive 160x128 landscape WidgetPackage for the robot,
 * allowing the robot to display a custom UI card and trigger the automation via touch sensor!
 */
export function compileAutomationToWidgetPackage(pkg: HostedAutomationPackage): WidgetPackage {
  const widgetId = `widget-auto-${pkg.id}`;
  const accentColorHex = `#${((pkg.robotCardPreview.accentColorRgb565 >> 11) * 8).toString(16).padStart(2, "0")}${(((pkg.robotCardPreview.accentColorRgb565 >> 5) & 0x3f) * 4).toString(16).padStart(2, "0")}${((pkg.robotCardPreview.accentColorRgb565 & 0x1f) * 8).toString(16).padStart(2, "0")}`;

  return {
    manifest: {
      id: widgetId,
      name: pkg.name.substring(0, 24),
      version: pkg.version as `${number}.${number}.${number}`,
      author: "Automation Engine",
      iconId: pkg.robotCardPreview.iconId,
      refreshIntervalMs: 1000,
      requiresAgenticMode: pkg.hostingTarget !== "ROBOT_STANDALONE",
    },
    state: {
      status: {
        type: "string",
        initialValue: "Active",
        persistToSd: true,
      },
      headline: {
        type: "string",
        initialValue: pkg.robotCardPreview.title.substring(0, 32),
        persistToSd: true,
      },
      subtext: {
        type: "string",
        initialValue: pkg.robotCardPreview.subtitle.substring(0, 32),
        persistToSd: false,
      },
      triggerCount: {
        type: "int32",
        initialValue: 0,
        persistToSd: true,
      },
    },
    ui: {
      type: "Container",
      x: 0,
      y: 0,
      w: 160,
      h: 128,
      backgroundColor: "#0D1117",
      borderRadius: 0,
      children: [
        // 1. Header Box
        {
          type: "Container",
          x: 4,
          y: 4,
          w: 152,
          h: 18,
          backgroundColor: "#161B22",
          borderRadius: 4,
          children: [
            {
              type: "Text",
              x: 8,
              y: 6,
              w: 64,
              h: 14,
              text: `[${pkg.robotCardPreview.headerBadge.substring(0, 6)}]`,
              color: accentColorHex,
              fontSize: "sm",
              align: "left",
            },
            {
              type: "Text",
              x: 78,
              y: 6,
              w: 74,
              h: 14,
              text: pkg.name.substring(0, 12),
              color: "#FFFFFF",
              fontSize: "sm",
              align: "right",
            },
          ],
        },
        // 2. Center Face & Headline
        {
          type: "Container",
          x: 4,
          y: 25,
          w: 152,
          h: 74,
          backgroundColor: "#0D1117",
          borderRadius: 4,
          children: [
            {
              type: "PetExpression",
              x: 50,
              y: 27,
              w: 60,
              h: 36,
              emotion: pkg.robotCardPreview.emotion,
              size: 36,
            },
            {
              type: "Text",
              x: 8,
              y: 65,
              w: 144,
              h: 16,
              text: "$headline",
              color: "#58A6FF",
              fontSize: "sm",
              align: "center",
            },
            {
              type: "Text",
              x: 8,
              y: 82,
              w: 144,
              h: 14,
              text: "$subtext",
              color: "#8B949E",
              fontSize: "sm",
              align: "center",
            },
          ],
        },
        // 3. Bottom Action Prompt
        {
          type: "Container",
          x: 4,
          y: 102,
          w: 152,
          h: 22,
          backgroundColor: "#1F2428",
          borderRadius: 4,
          children: [
            {
              type: "Text",
              x: 8,
              y: 106,
              w: 144,
              h: 14,
              text: "TAP TO TRIGGER",
              color: accentColorHex,
              fontSize: "sm",
              align: "center",
            },
          ],
        },
      ],
    },
    triggers: [
      {
        event: "ON_TOUCH_TAP",
        actions: [
          {
            type: "PLAY_SOUND",
            soundId: "CHIRP",
            frequencyHz: 2000,
            durationMs: 150,
          },
          {
            type: "EMIT_HARNESS_RPC",
            actionId: "trigger_automation",
            riskTier: "TIER_1_SAFE",
            payload: {
              automationId: pkg.id,
            },
          },
        ],
      },
    ],
  };
}
