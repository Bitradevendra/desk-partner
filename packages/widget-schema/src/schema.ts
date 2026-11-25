import { z } from "zod";
import { encode, decode } from "@msgpack/msgpack";
import { DISPLAY_WIDTH, DISPLAY_HEIGHT } from "@petbot/protocol";

/**
 * ============================================================================
 * Declarative Widget & Automation Bytecode Schema
 * Optimized for ESP32-S3 60 FPS rendering from Octal PSRAM with zero-copy O(1) lookups.
 * ============================================================================
 */

export const MAX_STATE_SLOTS = 64;
export const MAX_STATE_STRING_LEN = 64;
export const SCREEN_MAX_X = (DISPLAY_WIDTH - 1) as 159;
export const SCREEN_MAX_Y = (DISPLAY_HEIGHT - 1) as 127;

// --- Manifest ---
export const WidgetManifestSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(24),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must be a valid semver string (e.g. 1.0.0)"),
  author: z.string().min(1).max(32),
  iconId: z.number().int().min(0).max(0xffff),
  refreshIntervalMs: z.number().int().min(16),
  requiresAgenticMode: z.boolean(),
});
export type WidgetManifest = z.infer<typeof WidgetManifestSchema>;

// --- Reactive State Variables ---
export const StateVarTypeSchema = z.enum(["int32", "float", "bool", "string"]);
export type StateVarType = z.infer<typeof StateVarTypeSchema>;

const Int32StateVarSchema = z.object({
  type: z.literal("int32"),
  initialValue: z.number().int().min(-2147483648).max(2147483647),
  persistToSd: z.boolean(),
});

const FloatStateVarSchema = z.object({
  type: z.literal("float"),
  initialValue: z.number(),
  persistToSd: z.boolean(),
});

const BoolStateVarSchema = z.object({
  type: z.literal("bool"),
  initialValue: z.boolean(),
  persistToSd: z.boolean(),
});

const StringStateVarSchema = z.object({
  type: z.literal("string"),
  initialValue: z.string().max(MAX_STATE_STRING_LEN),
  persistToSd: z.boolean(),
});

export const StateVariableSchema = z.discriminatedUnion("type", [
  Int32StateVarSchema,
  FloatStateVarSchema,
  BoolStateVarSchema,
  StringStateVarSchema,
]);
export type StateVariable = z.infer<typeof StateVariableSchema>;

export const WidgetStateDictionarySchema = z
  .record(z.string().min(1).max(32), StateVariableSchema)
  .refine(
    (dict) => Object.keys(dict).length <= MAX_STATE_SLOTS,
    `State dictionary exceeds maximum allowed ${MAX_STATE_SLOTS} slots for O(1) indexing`
  );
export type WidgetStateDictionary = z.infer<typeof WidgetStateDictionarySchema>;

// --- UI Enums and Values ---
export const ColorValueSchema = z.union([
  z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Color must be hex string #RGB or #RRGGBB"),
  z.number().int().min(0).max(0xffff), // Pre-packed RGB565
]);
export type ColorValue = z.infer<typeof ColorValueSchema>;

export const FontSizeSchema = z.enum(["sm", "md", "lg", "xl"]);
export type FontSize = z.infer<typeof FontSizeSchema>;

export const TextAlignSchema = z.enum(["left", "center", "right"]);
export type TextAlign = z.infer<typeof TextAlignSchema>;

export const OrientationSchema = z.enum(["horizontal", "vertical"]);
export type Orientation = z.infer<typeof OrientationSchema>;

export const EmotionTypeSchema = z.enum([
  "IDLE",
  "HAPPY",
  "CURIOUS",
  "SLEEPY",
  "FOCUSED",
  "SPEAKING",
  "LISTENING",
  "ALERT",
]);
export type EmotionType = z.infer<typeof EmotionTypeSchema>;

// --- UI Nodes ---
export const BaseNodeBoundsSchema = z.object({
  x: z.number().int().min(0).max(SCREEN_MAX_X),
  y: z.number().int().min(0).max(SCREEN_MAX_Y),
  w: z.number().int().min(1).max(DISPLAY_WIDTH),
  h: z.number().int().min(1).max(DISPLAY_HEIGHT),
  visible: z.union([z.boolean(), z.string().min(1).max(32)]).optional(),
});

export type UINode =
  | ContainerNode
  | TextNode
  | ProgressBarNode
  | SparklineNode
  | IconNode
  | PetExpressionNode
  | ListNode;

export interface ContainerNode {
  type: "Container";
  x: number;
  y: number;
  w: number;
  h: number;
  visible?: boolean | string | undefined;
  backgroundColor: ColorValue;
  borderRadius: number;
  borderColor?: ColorValue | undefined;
  padding?: number | undefined;
  children?: UINode[] | undefined;
}

export interface TextNode {
  type: "Text";
  x: number;
  y: number;
  w: number;
  h: number;
  visible?: boolean | string | undefined;
  text: string;
  fontSize: FontSize;
  color: ColorValue;
  align: TextAlign;
}

export interface ProgressBarNode {
  type: "ProgressBar";
  x: number;
  y: number;
  w: number;
  h: number;
  visible?: boolean | string | undefined;
  valueBinding: string;
  min: number;
  max: number;
  fgColor: ColorValue;
  bgColor: ColorValue;
  orientation: Orientation;
}

export interface SparklineNode {
  type: "Sparkline";
  x: number;
  y: number;
  w: number;
  h: number;
  visible?: boolean | string | undefined;
  dataBinding: string;
  color: ColorValue;
  lineWidth: number;
  min: number;
  max: number;
}

export interface IconNode {
  type: "Icon";
  x: number;
  y: number;
  w: number;
  h: number;
  visible?: boolean | string | undefined;
  builtinIconId: number;
  color: ColorValue;
  scale: number;
}

export interface PetExpressionNode {
  type: "PetExpression";
  x: number;
  y: number;
  w: number;
  h: number;
  visible?: boolean | string | undefined;
  emotion: EmotionType;
  size: number;
}

export interface ListNode {
  type: "List";
  x: number;
  y: number;
  w: number;
  h: number;
  visible?: boolean | string | undefined;
  itemsBinding: string;
  rowHeight: number;
  activeItemColor: ColorValue;
}

export const TextNodeSchema = BaseNodeBoundsSchema.extend({
  type: z.literal("Text"),
  text: z.string().min(1).max(128),
  fontSize: FontSizeSchema,
  color: ColorValueSchema,
  align: TextAlignSchema,
});

export const ProgressBarNodeSchema = BaseNodeBoundsSchema.extend({
  type: z.literal("ProgressBar"),
  valueBinding: z.string().min(1).max(32),
  min: z.number(),
  max: z.number(),
  fgColor: ColorValueSchema,
  bgColor: ColorValueSchema,
  orientation: OrientationSchema,
});

export const SparklineNodeSchema = BaseNodeBoundsSchema.extend({
  type: z.literal("Sparkline"),
  dataBinding: z.string().min(1).max(32),
  color: ColorValueSchema,
  lineWidth: z.number().int().min(1).max(8),
  min: z.number(),
  max: z.number(),
});

export const IconNodeSchema = BaseNodeBoundsSchema.extend({
  type: z.literal("Icon"),
  builtinIconId: z.number().int().min(0).max(0xffff),
  color: ColorValueSchema,
  scale: z.number().min(0.1).max(10.0),
});

export const PetExpressionNodeSchema = BaseNodeBoundsSchema.extend({
  type: z.literal("PetExpression"),
  emotion: EmotionTypeSchema,
  size: z.number().int().min(8).max(160),
});

export const ListNodeSchema = BaseNodeBoundsSchema.extend({
  type: z.literal("List"),
  itemsBinding: z.string().min(1).max(32),
  rowHeight: z.number().int().min(8).max(64),
  activeItemColor: ColorValueSchema,
});

export const ContainerNodeSchema: z.ZodObject<any> = BaseNodeBoundsSchema.extend({
  type: z.literal("Container"),
  backgroundColor: ColorValueSchema,
  borderRadius: z.number().int().min(0).max(32),
  borderColor: ColorValueSchema.optional(),
  padding: z.number().int().min(0).max(32).optional(),
  children: z.lazy(() => z.array(UINodeSchema)).optional(),
});

export const UINodeSchema: z.ZodType<UINode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    ContainerNodeSchema,
    TextNodeSchema,
    ProgressBarNodeSchema,
    SparklineNodeSchema,
    IconNodeSchema,
    PetExpressionNodeSchema,
    ListNodeSchema,
  ])
) as any as z.ZodType<UINode>;

// --- Triggers & Actions ---
export const EventTypeSchema = z.enum([
  "ON_TOUCH_TAP",
  "ON_TOUCH_DOUBLE_TAP",
  "ON_TOUCH_LONG_PRESS",
  "ON_TOUCH_PETTING",
  "ON_TOUCH_LEFT_TAP",
  "ON_TOUCH_RIGHT_TAP",
  "ON_TOUCH_LEFT_DOUBLE_TAP",
  "ON_TOUCH_RIGHT_DOUBLE_TAP",
  "ON_TOUCH_SWIPE_L2R",
  "ON_TOUCH_SWIPE_R2L",
  "ON_TOUCH_DUAL_TAP",
  "ON_TOUCH_DUAL_LONG_PRESS",
  "ON_TOUCH_DUAL_PETTING",
  "ON_TOUCH_SIDE_TAP",
  "ON_TOUCH_SIDE_DOUBLE_TAP",
  "ON_TOUCH_SIDE_LONG_PRESS",
  "ON_TOUCH_SIDE_PETTING",
  "ON_TOUCH_RIGHT_PINCH",
  "ON_TOUCH_CROSS_CHORD",
  "ON_TOUCH_SWIPE_TOP_TO_SIDE",
  "ON_TOUCH_SWIPE_SIDE_TO_TOP",
  "ON_TOUCH_TRIPLE_TAP",
  "ON_TOUCH_TRIPLE_LONG_PRESS",
  "ON_TOUCH_FULL_BODY_GROOM",
  "ON_TOUCH_LEFT_LONG_PRESS",
  "ON_TOUCH_RIGHT_LONG_PRESS",
  "ON_TIMER_TICK",
  "ON_LOAD",
  "ON_HARNESS_EVENT",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const OperatorTypeSchema = z.enum(["EQ", "NEQ", "GT", "LT", "GTE", "LTE"]);
export type OperatorType = z.infer<typeof OperatorTypeSchema>;

export const ConditionSchema = z.object({
  stateKey: z.string().min(1).max(32),
  operator: OperatorTypeSchema,
  compareValue: z.union([z.number(), z.boolean(), z.string().max(MAX_STATE_STRING_LEN)]),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const MutateOpSchema = z.enum(["SET", "INCREMENT", "DECREMENT", "TOGGLE"]);
export type MutateOp = z.infer<typeof MutateOpSchema>;

export const MutateStateActionSchema = z.object({
  type: z.literal("MUTATE_STATE"),
  targetKey: z.string().min(1).max(32),
  operation: MutateOpSchema,
  value: z.union([z.number(), z.boolean(), z.string().max(MAX_STATE_STRING_LEN)]).optional(),
});
export type MutateStateAction = z.infer<typeof MutateStateActionSchema>;

export const SoundIdSchema = z.enum(["CHIRP", "PURR", "SUCCESS", "WARNING", "TICK", "BEEP"]);
export type SoundId = z.infer<typeof SoundIdSchema>;

export const PlaySoundActionSchema = z.object({
  type: z.literal("PLAY_SOUND"),
  soundId: SoundIdSchema,
  frequencyHz: z.number().int().min(20).max(20000),
  durationMs: z.number().int().min(10).max(10000),
});
export type PlaySoundAction = z.infer<typeof PlaySoundActionSchema>;

export const SetExpressionActionSchema = z.object({
  type: z.literal("SET_EXPRESSION"),
  emotion: EmotionTypeSchema,
  durationMs: z.number().int().min(50).max(60000),
});
export type SetExpressionAction = z.infer<typeof SetExpressionActionSchema>;

export const RiskTierSchema = z.enum(["TIER_1_SAFE", "TIER_2_WORKFLOW", "TIER_3_2FA_REQUIRED"]);
export type RiskTier = z.infer<typeof RiskTierSchema>;

export const EmitHarnessRpcActionSchema = z.object({
  type: z.literal("EMIT_HARNESS_RPC"),
  actionId: z.string().min(1).max(64),
  riskTier: RiskTierSchema,
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type EmitHarnessRpcAction = z.infer<typeof EmitHarnessRpcActionSchema>;

export const NavigatePageActionSchema = z.object({
  type: z.literal("NAVIGATE_PAGE"),
  targetWidgetId: z.string().min(1).max(64),
});
export type NavigatePageAction = z.infer<typeof NavigatePageActionSchema>;

export const ActionSchema = z.discriminatedUnion("type", [
  MutateStateActionSchema,
  PlaySoundActionSchema,
  SetExpressionActionSchema,
  EmitHarnessRpcActionSchema,
  NavigatePageActionSchema,
]);
export type Action = z.infer<typeof ActionSchema>;

export const TriggerRuleSchema = z.object({
  event: EventTypeSchema,
  condition: ConditionSchema.optional(),
  actions: z.array(ActionSchema).min(1),
});
export type TriggerRule = z.infer<typeof TriggerRuleSchema>;

// --- Complete Declarative Widget Package Schema ---
export const WidgetPackageSchema = z.object({
  manifest: WidgetManifestSchema,
  state: WidgetStateDictionarySchema,
  ui: UINodeSchema,
  triggers: z.array(TriggerRuleSchema),
});
export type WidgetPackage = z.infer<typeof WidgetPackageSchema>;

/**
 * ============================================================================
 * Backward Compatibility Structures for Real-time Companion Telemetry & Face
 * ============================================================================
 */
export const EmotionStateSchema = z.enum([
  "NEUTRAL",
  "HAPPY",
  "SAD",
  "ANGRY",
  "SURPRISED",
  "SLEEPING",
  "PROCESSING",
  "WINKING",
  "CONFUSED",
]);
export type EmotionState = z.infer<typeof EmotionStateSchema>;

export const EyeRenderParamsSchema = z.object({
  emotion: EmotionStateSchema,
  eyelidOpenness: z.number().min(0.0).max(1.0),
  pupilSize: z.number().min(0.1).max(2.0),
  lookOffsetX: z.number().min(-1.0).max(1.0),
  lookOffsetY: z.number().min(-1.0).max(1.0),
  irisColorRgb565: z.number().int().min(0).max(0xffff),
  saccadeJitter: z.boolean(),
});
export type EyeRenderParams = z.infer<typeof EyeRenderParamsSchema>;

export const BatteryGaugeWidgetSchema = z.object({
  type: z.literal("BATTERY_GAUGE"),
  percentage: z.number().int().min(0).max(100),
  isCharging: z.boolean(),
  voltageMv: z.number().int().min(2500).max(4500),
  x: z.number().int().min(0).max(DISPLAY_WIDTH),
  y: z.number().int().min(0).max(DISPLAY_HEIGHT),
});
export type BatteryGaugeWidget = z.infer<typeof BatteryGaugeWidgetSchema>;

export const UrgencyLevelSchema = z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]);
export type UrgencyLevel = z.infer<typeof UrgencyLevelSchema>;

export const StatusCardWidgetSchema = z.object({
  type: z.literal("STATUS_CARD"),
  cardId: z.string().max(32),
  title: z.string().max(32),
  subtitle: z.string().max(64),
  iconId: z.number().int().min(0).max(255),
  urgency: UrgencyLevelSchema,
  durationMs: z.number().int().min(500).max(60000),
});
export type StatusCardWidget = z.infer<typeof StatusCardWidgetSchema>;

export const EyeFaceWidgetSchema = z.object({
  type: z.literal("EYE_FACE"),
  leftEye: EyeRenderParamsSchema,
  rightEye: EyeRenderParamsSchema,
  renderTick: z.number().int().nonnegative(),
});
export type EyeFaceWidget = z.infer<typeof EyeFaceWidgetSchema>;

export const WidgetPacketSchema = z.discriminatedUnion("type", [
  EyeFaceWidgetSchema,
  BatteryGaugeWidgetSchema,
  StatusCardWidgetSchema,
]);
export type WidgetPacket = z.infer<typeof WidgetPacketSchema>;

export function serializeWidgetPacket(packet: WidgetPacket): Uint8Array {
  const validated = WidgetPacketSchema.parse(packet);
  return encode(validated);
}

export function deserializeWidgetPacket(data: Uint8Array): WidgetPacket {
  const raw = decode(data);
  return WidgetPacketSchema.parse(raw);
}
