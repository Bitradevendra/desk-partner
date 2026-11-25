import { encode, decode } from "@msgpack/msgpack";
import {
  WidgetPackage,
  WidgetPackageSchema,
  UINode,
  ContainerNode,
  TextNode,
  ProgressBarNode,
  SparklineNode,
  IconNode,
  PetExpressionNode,
  ListNode,
  TriggerRule,
  Action,
  Condition,
  StateVarType,
  EmotionType,
  FontSize,
  TextAlign,
  Orientation,
  EventType,
  OperatorType,
  MutateOp,
  SoundId,
  RiskTier,
} from "./schema.js";

// --- Magic & Constants ---
export const BYTECODE_MAGIC = 0x50425747; // ASCII: 'P', 'B', 'W', 'G' ('PBWG')
export const BYTECODE_VERSION = 1;
export const BYTECODE_HEADER_SIZE = 8;

// --- Opcode Mappings ---
export enum NodeTypeOpcode {
  CONTAINER = 0x01,
  TEXT = 0x02,
  PROGRESS_BAR = 0x03,
  SPARKLINE = 0x04,
  ICON = 0x05,
  PET_EXPRESSION = 0x06,
  LIST = 0x07,
}

export enum EventTypeOpcode {
  ON_TOUCH_TAP = 0x01,
  ON_TOUCH_DOUBLE_TAP = 0x02,
  ON_TOUCH_LONG_PRESS = 0x03,
  ON_TOUCH_PETTING = 0x04,
  ON_TIMER_TICK = 0x05,
  ON_LOAD = 0x06,
  ON_HARNESS_EVENT = 0x07,
  ON_TOUCH_LEFT_TAP = 0x08,
  ON_TOUCH_RIGHT_TAP = 0x09,
  ON_TOUCH_LEFT_DOUBLE_TAP = 0x0a,
  ON_TOUCH_RIGHT_DOUBLE_TAP = 0x0b,
  ON_TOUCH_SWIPE_L2R = 0x0c,
  ON_TOUCH_SWIPE_R2L = 0x0d,
  ON_TOUCH_DUAL_TAP = 0x0e,
  ON_TOUCH_DUAL_LONG_PRESS = 0x0f,
  ON_TOUCH_DUAL_PETTING = 0x10,
  ON_TOUCH_SIDE_TAP = 0x11,
  ON_TOUCH_SIDE_DOUBLE_TAP = 0x12,
  ON_TOUCH_SIDE_LONG_PRESS = 0x13,
  ON_TOUCH_SIDE_PETTING = 0x14,
  ON_TOUCH_RIGHT_PINCH = 0x15,
  ON_TOUCH_CROSS_CHORD = 0x16,
  ON_TOUCH_SWIPE_TOP_TO_SIDE = 0x17,
  ON_TOUCH_SWIPE_SIDE_TO_TOP = 0x18,
  ON_TOUCH_TRIPLE_TAP = 0x19,
  ON_TOUCH_TRIPLE_LONG_PRESS = 0x1a,
  ON_TOUCH_FULL_BODY_GROOM = 0x1b,
  ON_TOUCH_LEFT_LONG_PRESS = 0x1c,
  ON_TOUCH_RIGHT_LONG_PRESS = 0x1d,
}

export enum ActionTypeOpcode {
  MUTATE_STATE = 0x01,
  PLAY_SOUND = 0x02,
  SET_EXPRESSION = 0x03,
  EMIT_HARNESS_RPC = 0x04,
  NAVIGATE_PAGE = 0x05,
}

export enum EmotionOpcode {
  IDLE = 0x00,
  HAPPY = 0x01,
  CURIOUS = 0x02,
  SLEEPY = 0x03,
  FOCUSED = 0x04,
  SPEAKING = 0x05,
  LISTENING = 0x06,
  ALERT = 0x07,
}

export enum OperatorOpcode {
  EQ = 0x01,
  NEQ = 0x02,
  GT = 0x03,
  LT = 0x04,
  GTE = 0x05,
  LTE = 0x06,
}

export enum StateVarTypeOpcode {
  INT32 = 0x01,
  FLOAT = 0x02,
  BOOL = 0x03,
  STRING = 0x04,
}

export enum FontSizeOpcode {
  SM = 0x01,
  MD = 0x02,
  LG = 0x03,
  XL = 0x04,
}

export enum TextAlignOpcode {
  LEFT = 0x01,
  CENTER = 0x02,
  RIGHT = 0x03,
}

export enum OrientationOpcode {
  HORIZONTAL = 0x01,
  VERTICAL = 0x02,
}

export enum RiskTierOpcode {
  TIER_1_SAFE = 0x01,
  TIER_2_WORKFLOW = 0x02,
  TIER_3_2FA_REQUIRED = 0x03,
}

export enum SoundIdOpcode {
  CHIRP = 0x01,
  PURR = 0x02,
  SUCCESS = 0x03,
  WARNING = 0x04,
  TICK = 0x05,
  BEEP = 0x06,
}

export enum MutateOpcode {
  SET = 0x01,
  INCREMENT = 0x02,
  DECREMENT = 0x03,
  TOGGLE = 0x04,
}

// --- RGB565 Color Conversions ---
/**
 * Converts a hex string (#RGB or #RRGGBB) or integer into a 16-bit RGB565 integer.
 * Formula: ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
 */
export function hexToRgb565(color: string | number): number {
  if (typeof color === "number") {
    return color & 0xffff;
  }
  let hex = color.trim().replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (hex.length !== 6) {
    return 0x0000;
  }
  const num = parseInt(hex, 16);
  if (isNaN(num)) {
    return 0x0000;
  }
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  return (((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)) & 0xffff;
}

/**
 * Converts a 16-bit RGB565 integer back into a normalized uppercase 6-digit hex string (#RRGGBB).
 */
export function rgb565ToHex(c: number): string {
  const r5 = (c >> 11) & 0x1f;
  const g6 = (c >> 5) & 0x3f;
  const b5 = c & 0x1f;

  const r8 = Math.round((r5 * 255) / 31);
  const g8 = Math.round((g6 * 255) / 63);
  const b8 = Math.round((b5 * 255) / 31);

  return (
    "#" +
    r8.toString(16).padStart(2, "0").toUpperCase() +
    g8.toString(16).padStart(2, "0").toUpperCase() +
    b8.toString(16).padStart(2, "0").toUpperCase()
  );
}

// --- CRC16-CCITT Standard Checksum ---
/**
 * Computes CRC16-CCITT (polynomial 0x1021, initial 0xFFFF) across a byte buffer.
 */
export function crc16Ccitt(buffer: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < buffer.byteLength; i++) {
    const b = buffer[i]!;
    crc ^= b << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

// --- Slot Resolver ---
class StateSlotMap {
  private readonly keyToSlot = new Map<string, number>();
  private readonly slotToKey = new Map<number, string>();

  constructor(keys: string[]) {
    keys.forEach((key, idx) => {
      this.keyToSlot.set(key, idx);
      this.slotToKey.set(idx, key);
    });
  }

  public getSlot(key: string): number {
    const slot = this.keyToSlot.get(key);
    if (slot === undefined) {
      throw new Error(`Unresolved state variable binding: "${key}"`);
    }
    return slot;
  }

  public getKey(slot: number): string {
    const key = this.slotToKey.get(slot);
    if (key === undefined) {
      throw new Error(`Unknown state slot index: ${slot}`);
    }
    return key;
  }
}

// --- Internal Compiled Payload Interface ---
interface CompiledNode {
  t: NodeTypeOpcode;
  b: [number, number, number, number];
  v?: number | boolean | undefined;
  // Type-specific fields
  bg?: number;
  r?: number;
  bc?: number;
  pad?: number;
  ch?: CompiledNode[];
  txt?: string;
  sz?: FontSizeOpcode;
  c?: number;
  al?: TextAlignOpcode;
  slots?: number[];
  valSlot?: number;
  min?: number;
  max?: number;
  fg?: number;
  ori?: OrientationOpcode;
  dataSlot?: number;
  w?: number;
  icon?: number;
  scale?: number;
  emo?: EmotionOpcode;
  itemSlot?: number;
  rowH?: number;
  actColor?: number;
}

interface CompiledTrigger {
  ev: EventTypeOpcode;
  cond?: [number, OperatorOpcode, number | boolean | string];
  acts: Array<
    | [ActionTypeOpcode.MUTATE_STATE, number, MutateOpcode, (number | boolean | string)?]
    | [ActionTypeOpcode.PLAY_SOUND, SoundIdOpcode, number, number]
    | [ActionTypeOpcode.SET_EXPRESSION, EmotionOpcode, number]
    | [ActionTypeOpcode.EMIT_HARNESS_RPC, string, RiskTierOpcode, Record<string, string | number | boolean>]
    | [ActionTypeOpcode.NAVIGATE_PAGE, string]
  >;
}

interface CompiledWidgetPayload {
  m: {
    id: string;
    name: string;
    ver: string;
    auth: string;
    icon: number;
    rate: number;
    agent: number;
  };
  slots: Array<[number, string, StateVarTypeOpcode, number | boolean | string, number]>;
  ui: CompiledNode;
  trig: CompiledTrigger[];
}

// --- Compilation Subroutines ---
function compileNode(node: UINode, slotMap: StateSlotMap): CompiledNode {
  const baseBounds: [number, number, number, number] = [node.x, node.y, node.w, node.h];
  const compiled: CompiledNode = {
    t: NodeTypeOpcode.CONTAINER,
    b: baseBounds,
  };

  if (node.visible !== undefined) {
    if (typeof node.visible === "string") {
      compiled.v = slotMap.getSlot(node.visible);
    } else {
      compiled.v = node.visible;
    }
  }

  switch (node.type) {
    case "Container": {
      compiled.t = NodeTypeOpcode.CONTAINER;
      compiled.bg = hexToRgb565(node.backgroundColor);
      compiled.r = node.borderRadius;
      if (node.borderColor !== undefined) {
        compiled.bc = hexToRgb565(node.borderColor);
      }
      if (node.padding !== undefined) {
        compiled.pad = node.padding;
      }
      if (node.children && node.children.length > 0) {
        compiled.ch = node.children.map((child) => compileNode(child, slotMap));
      }
      break;
    }

    case "Text": {
      compiled.t = NodeTypeOpcode.TEXT;
      compiled.txt = node.text;
      compiled.sz = FontSizeOpcode[node.fontSize.toUpperCase() as keyof typeof FontSizeOpcode];
      compiled.c = hexToRgb565(node.color);
      compiled.al = TextAlignOpcode[node.align.toUpperCase() as keyof typeof TextAlignOpcode];

      // Parse {{key}} interpolation bindings into slot indices
      const matches = node.text.match(/\{\{([a-zA-Z0-9_-]+)\}\}/g);
      if (matches) {
        const slots: number[] = [];
        for (const match of matches) {
          const key = match.slice(2, -2);
          slots.push(slotMap.getSlot(key));
        }
        compiled.slots = slots;
      }
      break;
    }

    case "ProgressBar": {
      compiled.t = NodeTypeOpcode.PROGRESS_BAR;
      compiled.valSlot = slotMap.getSlot(node.valueBinding);
      compiled.min = node.min;
      compiled.max = node.max;
      compiled.fg = hexToRgb565(node.fgColor);
      compiled.bg = hexToRgb565(node.bgColor);
      compiled.ori = OrientationOpcode[node.orientation.toUpperCase() as keyof typeof OrientationOpcode];
      break;
    }

    case "Sparkline": {
      compiled.t = NodeTypeOpcode.SPARKLINE;
      compiled.dataSlot = slotMap.getSlot(node.dataBinding);
      compiled.c = hexToRgb565(node.color);
      compiled.w = node.lineWidth;
      compiled.min = node.min;
      compiled.max = node.max;
      break;
    }

    case "Icon": {
      compiled.t = NodeTypeOpcode.ICON;
      compiled.icon = node.builtinIconId;
      compiled.c = hexToRgb565(node.color);
      compiled.scale = node.scale;
      break;
    }

    case "PetExpression": {
      compiled.t = NodeTypeOpcode.PET_EXPRESSION;
      compiled.emo = EmotionOpcode[node.emotion as keyof typeof EmotionOpcode];
      compiled.sz = node.size;
      break;
    }

    case "List": {
      compiled.t = NodeTypeOpcode.LIST;
      compiled.itemSlot = slotMap.getSlot(node.itemsBinding);
      compiled.rowH = node.rowHeight;
      compiled.actColor = hexToRgb565(node.activeItemColor);
      break;
    }
  }

  return compiled;
}

function decompileNode(compiled: CompiledNode, slotMap: StateSlotMap): UINode {
  const [x, y, w, h] = compiled.b;
  let visible: boolean | string | undefined;

  if (compiled.v !== undefined) {
    if (typeof compiled.v === "number") {
      visible = slotMap.getKey(compiled.v);
    } else {
      visible = compiled.v;
    }
  }

  switch (compiled.t) {
    case NodeTypeOpcode.CONTAINER: {
      const container: ContainerNode = {
        type: "Container",
        x,
        y,
        w,
        h,
        backgroundColor: rgb565ToHex(compiled.bg ?? 0),
        borderRadius: compiled.r ?? 0,
      };
      if (visible !== undefined) container.visible = visible;
      if (compiled.bc !== undefined) container.borderColor = rgb565ToHex(compiled.bc);
      if (compiled.pad !== undefined) container.padding = compiled.pad;
      if (compiled.ch && compiled.ch.length > 0) {
        container.children = compiled.ch.map((child) => decompileNode(child, slotMap));
      }
      return container;
    }

    case NodeTypeOpcode.TEXT: {
      const fontSizeKey = (
        Object.entries(FontSizeOpcode).find(([, val]) => val === compiled.sz)?.[0] ?? "SM"
      ).toLowerCase() as FontSize;
      const textAlignKey = (
        Object.entries(TextAlignOpcode).find(([, val]) => val === compiled.al)?.[0] ?? "LEFT"
      ).toLowerCase() as TextAlign;

      const textNode: TextNode = {
        type: "Text",
        x,
        y,
        w,
        h,
        text: compiled.txt ?? "",
        fontSize: fontSizeKey,
        color: rgb565ToHex(compiled.c ?? 0xffff),
        align: textAlignKey,
      };
      if (visible !== undefined) textNode.visible = visible;
      return textNode;
    }

    case NodeTypeOpcode.PROGRESS_BAR: {
      const oriKey = (
        Object.entries(OrientationOpcode).find(([, val]) => val === compiled.ori)?.[0] ?? "HORIZONTAL"
      ).toLowerCase() as Orientation;

      const pbNode: ProgressBarNode = {
        type: "ProgressBar",
        x,
        y,
        w,
        h,
        valueBinding: slotMap.getKey(compiled.valSlot ?? 0),
        min: compiled.min ?? 0,
        max: compiled.max ?? 100,
        fgColor: rgb565ToHex(compiled.fg ?? 0xffff),
        bgColor: rgb565ToHex(compiled.bg ?? 0x0000),
        orientation: oriKey,
      };
      if (visible !== undefined) pbNode.visible = visible;
      return pbNode;
    }

    case NodeTypeOpcode.SPARKLINE: {
      const spark: SparklineNode = {
        type: "Sparkline",
        x,
        y,
        w,
        h,
        dataBinding: slotMap.getKey(compiled.dataSlot ?? 0),
        color: rgb565ToHex(compiled.c ?? 0xffff),
        lineWidth: compiled.w ?? 1,
        min: compiled.min ?? 0,
        max: compiled.max ?? 100,
      };
      if (visible !== undefined) spark.visible = visible;
      return spark;
    }

    case NodeTypeOpcode.ICON: {
      const iconNode: IconNode = {
        type: "Icon",
        x,
        y,
        w,
        h,
        builtinIconId: compiled.icon ?? 0,
        color: rgb565ToHex(compiled.c ?? 0xffff),
        scale: compiled.scale ?? 1.0,
      };
      if (visible !== undefined) iconNode.visible = visible;
      return iconNode;
    }

    case NodeTypeOpcode.PET_EXPRESSION: {
      const emoKey = (
        Object.entries(EmotionOpcode).find(([, val]) => val === compiled.emo)?.[0] ?? "IDLE"
      ) as EmotionType;

      const petNode: PetExpressionNode = {
        type: "PetExpression",
        x,
        y,
        w,
        h,
        emotion: emoKey,
        size: compiled.sz ?? 64,
      };
      if (visible !== undefined) petNode.visible = visible;
      return petNode;
    }

    case NodeTypeOpcode.LIST: {
      const listNode: ListNode = {
        type: "List",
        x,
        y,
        w,
        h,
        itemsBinding: slotMap.getKey(compiled.itemSlot ?? 0),
        rowHeight: compiled.rowH ?? 16,
        activeItemColor: rgb565ToHex(compiled.actColor ?? 0xffff),
      };
      if (visible !== undefined) listNode.visible = visible;
      return listNode;
    }
  }
}

// --- Primary Compiler and Decompiler ---
/**
 * Compiles a declarative WidgetPackage into a deterministic integer-indexed MessagePack binary buffer
 * with an 8-byte PBWG header and CRC16-CCITT checksum.
 */
export function compileWidgetToBytecode(widget: WidgetPackage): Uint8Array {
  // 1. Validate complete input schema
  const validated = WidgetPackageSchema.parse(widget);

  // 2. Build deterministic state slot mapping (0..63)
  const stateKeys = Object.keys(validated.state);
  const slotMap = new StateSlotMap(stateKeys);

  const compiledSlots: Array<[number, string, StateVarTypeOpcode, number | boolean | string, number]> = [];
  for (let slot = 0; slot < stateKeys.length; slot++) {
    const key = stateKeys[slot]!;
    const stateVar = validated.state[key]!;
    const typeOpcode =
      StateVarTypeOpcode[stateVar.type.toUpperCase() as keyof typeof StateVarTypeOpcode];
    compiledSlots.push([
      slot,
      key,
      typeOpcode,
      stateVar.initialValue,
      stateVar.persistToSd ? 1 : 0,
    ]);
  }

  // 3. Compile UI Node Tree
  const compiledUI = compileNode(validated.ui, slotMap);

  // 4. Compile Event Triggers and Action Pipelines
  const compiledTriggers: CompiledTrigger[] = validated.triggers.map((trigger) => {
    const eventOpcode = EventTypeOpcode[trigger.event as keyof typeof EventTypeOpcode];
    let compiledCond: [number, OperatorOpcode, number | boolean | string] | undefined;

    if (trigger.condition) {
      const condSlot = slotMap.getSlot(trigger.condition.stateKey);
      const opOpcode = OperatorOpcode[trigger.condition.operator as keyof typeof OperatorOpcode];
      compiledCond = [condSlot, opOpcode, trigger.condition.compareValue];
    }

    const compiledActions = trigger.actions.map((act) => {
      switch (act.type) {
        case "MUTATE_STATE": {
          const targetSlot = slotMap.getSlot(act.targetKey);
          const mutOpcode = MutateOpcode[act.operation as keyof typeof MutateOpcode];
          return act.value !== undefined
            ? ([ActionTypeOpcode.MUTATE_STATE, targetSlot, mutOpcode, act.value] as const)
            : ([ActionTypeOpcode.MUTATE_STATE, targetSlot, mutOpcode] as const);
        }
        case "PLAY_SOUND": {
          const soundOpcode = SoundIdOpcode[act.soundId as keyof typeof SoundIdOpcode];
          return [ActionTypeOpcode.PLAY_SOUND, soundOpcode, act.frequencyHz, act.durationMs] as const;
        }
        case "SET_EXPRESSION": {
          const emoOpcode = EmotionOpcode[act.emotion as keyof typeof EmotionOpcode];
          return [ActionTypeOpcode.SET_EXPRESSION, emoOpcode, act.durationMs] as const;
        }
        case "EMIT_HARNESS_RPC": {
          const riskOpcode = RiskTierOpcode[act.riskTier as keyof typeof RiskTierOpcode];
          return [ActionTypeOpcode.EMIT_HARNESS_RPC, act.actionId, riskOpcode, act.payload] as const;
        }
        case "NAVIGATE_PAGE": {
          return [ActionTypeOpcode.NAVIGATE_PAGE, act.targetWidgetId] as const;
        }
      }
    });

    const rule: CompiledTrigger = {
      ev: eventOpcode,
      acts: compiledActions as CompiledTrigger["acts"],
    };
    if (compiledCond) {
      rule.cond = compiledCond;
    }
    return rule;
  });

  // 5. Build Aggregated Payload
  const payloadData: CompiledWidgetPayload = {
    m: {
      id: validated.manifest.id,
      name: validated.manifest.name,
      ver: validated.manifest.version,
      auth: validated.manifest.author,
      icon: validated.manifest.iconId,
      rate: validated.manifest.refreshIntervalMs,
      agent: validated.manifest.requiresAgenticMode ? 1 : 0,
    },
    slots: compiledSlots,
    ui: compiledUI,
    trig: compiledTriggers,
  };

  const msgpackPayload = encode(payloadData);
  const crc = crc16Ccitt(msgpackPayload);

  // 6. Prepend 8-byte Binary Bytecode Header (PBWG, Version, CRC16)
  const totalLength = BYTECODE_HEADER_SIZE + msgpackPayload.byteLength;
  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, totalLength);

  // Magic 'PBWG' -> 0x50, 0x42, 0x57, 0x47 in Big-Endian bytes, or 0x47574250 in Little-Endian
  buffer[0] = 0x50; // 'P'
  buffer[1] = 0x42; // 'B'
  buffer[2] = 0x57; // 'W'
  buffer[3] = 0x47; // 'G'
  view.setUint16(4, BYTECODE_VERSION, true); // Version (Little-Endian)
  view.setUint16(6, crc, true); // CRC16 (Little-Endian)

  buffer.set(msgpackPayload, BYTECODE_HEADER_SIZE);
  return buffer;
}

/**
 * Decompiles a compiled MessagePack bytecode buffer back into a validated WidgetPackage.
 */
export function decompileBytecodeToWidget(buffer: Uint8Array): WidgetPackage {
  if (buffer.byteLength < BYTECODE_HEADER_SIZE) {
    throw new RangeError(
      `Buffer too small for bytecode header: ${buffer.byteLength} < ${BYTECODE_HEADER_SIZE}`
    );
  }

  // 1. Verify Magic Header ("PBWG")
  if (
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x42 ||
    buffer[2] !== 0x57 ||
    buffer[3] !== 0x47
  ) {
    throw new Error("Invalid bytecode magic: expected 'PBWG'");
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const version = view.getUint16(4, true);
  if (version !== BYTECODE_VERSION) {
    throw new Error(`Unsupported bytecode version: ${version} (expected ${BYTECODE_VERSION})`);
  }

  const expectedCrc = view.getUint16(6, true);
  const payloadBytes = new Uint8Array(buffer.buffer, buffer.byteOffset + BYTECODE_HEADER_SIZE, buffer.byteLength - BYTECODE_HEADER_SIZE);
  const actualCrc = crc16Ccitt(payloadBytes);

  if (actualCrc !== expectedCrc) {
    throw new Error(
      `CRC16 checksum mismatch: expected 0x${expectedCrc.toString(16)}, computed 0x${actualCrc.toString(16)}`
    );
  }

  // 2. Decode MessagePack Payload
  const payload = decode(payloadBytes) as CompiledWidgetPayload;

  // 3. Rebuild State Dictionary
  const stateKeys = payload.slots.map((s) => s[1]);
  const slotMap = new StateSlotMap(stateKeys);
  const stateDict: Record<string, any> = {};

  for (const slot of payload.slots) {
    const [, name, typeOpcode, initialVal, persist] = slot;
    const typeKey = (
      Object.entries(StateVarTypeOpcode).find(([, val]) => val === typeOpcode)?.[0] ?? "INT32"
    ).toLowerCase() as StateVarType;

    stateDict[name] = {
      type: typeKey,
      initialValue: initialVal,
      persistToSd: persist === 1,
    };
  }

  // 4. Rebuild UI Tree
  const uiTree = decompileNode(payload.ui, slotMap);

  // 5. Rebuild Triggers and Actions
  const triggers: TriggerRule[] = payload.trig.map((trig) => {
    const eventName = Object.entries(EventTypeOpcode).find(
      ([, val]) => val === trig.ev
    )?.[0] as EventType;

    let condition: Condition | undefined;
    if (trig.cond) {
      const [condSlot, opOpcode, compareVal] = trig.cond;
      const opName = Object.entries(OperatorOpcode).find(
        ([, val]) => val === opOpcode
      )?.[0] as OperatorType;
      condition = {
        stateKey: slotMap.getKey(condSlot),
        operator: opName,
        compareValue: compareVal,
      };
    }

    const actions: Action[] = trig.acts.map((act) => {
      const actType = act[0];
      switch (actType) {
        case ActionTypeOpcode.MUTATE_STATE: {
          const [, targetSlot, mutOpcode, val] = act;
          const mutName = Object.entries(MutateOpcode).find(
            ([, v]) => v === mutOpcode
          )?.[0] as MutateOp;
          const mutateAction: Action = {
            type: "MUTATE_STATE",
            targetKey: slotMap.getKey(targetSlot),
            operation: mutName,
          };
          if (val !== undefined) {
            mutateAction.value = val;
          }
          return mutateAction;
        }

        case ActionTypeOpcode.PLAY_SOUND: {
          const [, soundOpcode, freq, dur] = act;
          const soundName = Object.entries(SoundIdOpcode).find(
            ([, v]) => v === soundOpcode
          )?.[0] as SoundId;
          return {
            type: "PLAY_SOUND",
            soundId: soundName,
            frequencyHz: freq,
            durationMs: dur,
          };
        }

        case ActionTypeOpcode.SET_EXPRESSION: {
          const [, emoOpcode, dur] = act;
          const emoName = Object.entries(EmotionOpcode).find(
            ([, v]) => v === emoOpcode
          )?.[0] as EmotionType;
          return {
            type: "SET_EXPRESSION",
            emotion: emoName,
            durationMs: dur,
          };
        }

        case ActionTypeOpcode.EMIT_HARNESS_RPC: {
          const [, actionId, riskOpcode, rpcPayload] = act;
          const riskName = Object.entries(RiskTierOpcode).find(
            ([, v]) => v === riskOpcode
          )?.[0] as RiskTier;
          return {
            type: "EMIT_HARNESS_RPC",
            actionId,
            riskTier: riskName,
            payload: rpcPayload,
          };
        }

        case ActionTypeOpcode.NAVIGATE_PAGE: {
          const [, targetWidgetId] = act;
          return {
            type: "NAVIGATE_PAGE",
            targetWidgetId,
          };
        }
      }
    });

    const rule: TriggerRule = {
      event: eventName,
      actions,
    };
    if (condition) {
      rule.condition = condition;
    }
    return rule;
  });

  const reconstructed: WidgetPackage = {
    manifest: {
      id: payload.m.id,
      name: payload.m.name,
      version: payload.m.ver,
      author: payload.m.auth,
      iconId: payload.m.icon,
      refreshIntervalMs: payload.m.rate,
      requiresAgenticMode: payload.m.agent === 1,
    },
    state: stateDict,
    ui: uiTree,
    triggers,
  };

  return WidgetPackageSchema.parse(reconstructed);
}
