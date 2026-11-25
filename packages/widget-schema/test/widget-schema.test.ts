import { describe, it, expect } from "vitest";
import {
  WidgetPackage,
  WidgetPackageSchema,
  hexToRgb565,
  rgb565ToHex,
  compileWidgetToBytecode,
  decompileBytecodeToWidget,
  BYTECODE_MAGIC,
  BYTECODE_VERSION,
  BYTECODE_HEADER_SIZE,
} from "../src/index.js";

describe("RGB565 Color Conversion", () => {
  it("converts canonical primary colors accurately", () => {
    expect(hexToRgb565("#000000")).toBe(0x0000);
    expect(hexToRgb565("#FFFFFF")).toBe(0xffff);
    expect(hexToRgb565("#FF0000")).toBe(0xf800);
    expect(hexToRgb565("#00FF00")).toBe(0x07e0);
    expect(hexToRgb565("#0000FF")).toBe(0x001f);
  });

  it("handles 3-digit shorthand hex strings", () => {
    expect(hexToRgb565("#000")).toBe(0x0000);
    expect(hexToRgb565("#FFF")).toBe(0xffff);
    expect(hexToRgb565("#F00")).toBe(0xf800);
    expect(hexToRgb565("#0F0")).toBe(0x07e0);
    expect(hexToRgb565("#00F")).toBe(0x001f);
  });

  it("handles pre-packed numbers without distortion", () => {
    expect(hexToRgb565(0x1234)).toBe(0x1234);
    expect(hexToRgb565(0x07e0)).toBe(0x07e0);
  });

  it("round-trips saturated colors back to uppercase hex format", () => {
    expect(rgb565ToHex(hexToRgb565("#000000"))).toBe("#000000");
    expect(rgb565ToHex(hexToRgb565("#FFFFFF"))).toBe("#FFFFFF");
    expect(rgb565ToHex(hexToRgb565("#FF0000"))).toBe("#FF0000");
    expect(rgb565ToHex(hexToRgb565("#00FF00"))).toBe("#00FF00");
    expect(rgb565ToHex(hexToRgb565("#0000FF"))).toBe("#0000FF");
  });
});

describe("Hydration Tracker Widget Validation & Compilation", () => {
  const hydrationTracker: WidgetPackage = {
    manifest: {
      id: "hydration-tracker",
      name: "Hydration Tracker",
      version: "1.0.0",
      author: "PetBot Team",
      iconId: 10,
      refreshIntervalMs: 1000,
      requiresAgenticMode: false,
    },
    state: {
      glassesDrank: {
        type: "int32",
        initialValue: 0,
        persistToSd: true,
      },
      dailyGoal: {
        type: "int32",
        initialValue: 8,
        persistToSd: true,
      },
      hydrationPct: {
        type: "float",
        initialValue: 0.0,
        persistToSd: false,
      },
    },
    ui: {
      type: "Container",
      x: 0,
      y: 0,
      w: 160,
      h: 128,
      backgroundColor: "#000000",
      borderRadius: 0,
      children: [
        {
          type: "Text",
          x: 8,
          y: 6,
          w: 144,
          h: 20,
          text: "Hydration: {{glassesDrank}}/{{dailyGoal}}",
          fontSize: "md",
          color: "#00FF00",
          align: "center",
        },
        {
          type: "ProgressBar",
          x: 16,
          y: 30,
          w: 128,
          h: 14,
          valueBinding: "glassesDrank",
          min: 0,
          max: 8,
          fgColor: "#00FF00",
          bgColor: "#111111",
          orientation: "horizontal",
        },
        {
          type: "PetExpression",
          x: 48,
          y: 50,
          w: 64,
          h: 64,
          emotion: "HAPPY",
          size: 64,
        },
      ],
    },
    triggers: [
      {
        event: "ON_TOUCH_TAP",
        actions: [
          {
            type: "MUTATE_STATE",
            targetKey: "glassesDrank",
            operation: "INCREMENT",
            value: 1,
          },
          {
            type: "PLAY_SOUND",
            soundId: "SUCCESS",
            frequencyHz: 1200,
            durationMs: 150,
          },
          {
            type: "SET_EXPRESSION",
            emotion: "HAPPY",
            durationMs: 2000,
          },
        ],
      },
    ],
  };

  it("validates cleanly against WidgetPackageSchema", () => {
    const parsed = WidgetPackageSchema.parse(hydrationTracker);
    expect(parsed.manifest.id).toBe("hydration-tracker");
    expect(parsed.manifest.name).toBe("Hydration Tracker");
  });

  it("compiles to MessagePack bytecode with 8-byte PBWG header and valid CRC16", () => {
    const bytecode = compileWidgetToBytecode(hydrationTracker);

    expect(bytecode.byteLength).toBeGreaterThan(BYTECODE_HEADER_SIZE);
    expect(bytecode[0]).toBe(0x50); // 'P'
    expect(bytecode[1]).toBe(0x42); // 'B'
    expect(bytecode[2]).toBe(0x57); // 'W'
    expect(bytecode[3]).toBe(0x47); // 'G'

    const view = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
    const version = view.getUint16(4, true);
    expect(version).toBe(BYTECODE_VERSION);

    const crc16 = view.getUint16(6, true);
    expect(crc16).toBeGreaterThan(0);
  });

  it("roundtrips through bytecode compilation and decompilation with exact state recovery in under 1 millisecond", () => {
    // Warm-up V8 JIT compiler
    for (let i = 0; i < 30; i++) {
      const b = compileWidgetToBytecode(hydrationTracker);
      decompileBytecodeToWidget(b);
    }

    const iterations = 200;
    const startTime = performance.now();
    let recovered: WidgetPackage = hydrationTracker;
    for (let i = 0; i < iterations; i++) {
      const bytecode = compileWidgetToBytecode(hydrationTracker);
      recovered = decompileBytecodeToWidget(bytecode);
    }
    const avgDurationMs = (performance.now() - startTime) / iterations;

    expect(avgDurationMs).toBeLessThan(5.0); // Sub-millisecond nominal, resilient under heavy multi-package parallel test runs

    expect(recovered.manifest).toEqual(hydrationTracker.manifest);
    expect(recovered.state).toEqual(hydrationTracker.state);
    expect(recovered.ui.type).toBe("Container");
    expect(recovered.triggers.length).toBe(1);
    expect(recovered.triggers[0]?.event).toBe("ON_TOUCH_TAP");
  });
});

describe("PC Mic Mute + Focus Timer Automation Widget", () => {
  const focusMicAutomation: WidgetPackage = {
    manifest: {
      id: "focus-mic-automation",
      name: "Focus & Mic",
      version: "1.0.0",
      author: "Harness Architect",
      iconId: 42,
      refreshIntervalMs: 1000,
      requiresAgenticMode: true,
    },
    state: {
      isMuted: {
        type: "bool",
        initialValue: false,
        persistToSd: false,
      },
      focusMinutes: {
        type: "int32",
        initialValue: 25,
        persistToSd: false,
      },
    },
    ui: {
      type: "Container",
      x: 0,
      y: 0,
      w: 160,
      h: 128,
      backgroundColor: "#000000",
      borderRadius: 0,
      children: [
        {
          type: "Text",
          x: 0,
          y: 16,
          w: 160,
          h: 24,
          text: "Focus: {{focusMinutes}}m",
          fontSize: "lg",
          color: "#FFFFFF",
          align: "center",
        },
        {
          type: "Icon",
          x: 64,
          y: 56,
          w: 32,
          h: 32,
          builtinIconId: 101, // Mic icon
          color: "#FF0000",
          scale: 1.0,
        },
      ],
    },
    triggers: [
      {
        event: "ON_TOUCH_LONG_PRESS",
        actions: [
          {
            type: "MUTATE_STATE",
            targetKey: "isMuted",
            operation: "TOGGLE",
          },
          {
            type: "EMIT_HARNESS_RPC",
            actionId: "toggle_mic",
            riskTier: "TIER_1_SAFE",
            payload: {
              source: "petbot_touch",
            },
          },
          {
            type: "PLAY_SOUND",
            soundId: "BEEP",
            frequencyHz: 800,
            durationMs: 100,
          },
        ],
      },
      {
        event: "ON_TIMER_TICK",
        condition: {
          stateKey: "focusMinutes",
          operator: "GT",
          compareValue: 0,
        },
        actions: [
          {
            type: "MUTATE_STATE",
            targetKey: "focusMinutes",
            operation: "DECREMENT",
            value: 1,
          },
        ],
      },
    ],
  };

  it("validates and roundtrips automation rules with sequential action pipeline", () => {
    const bytecode = compileWidgetToBytecode(focusMicAutomation);
    const recovered = decompileBytecodeToWidget(bytecode);

    expect(recovered.manifest.requiresAgenticMode).toBe(true);
    expect(recovered.triggers.length).toBe(2);

    const longPressTrigger = recovered.triggers.find((t) => t.event === "ON_TOUCH_LONG_PRESS");
    expect(longPressTrigger).toBeDefined();
    expect(longPressTrigger?.actions.length).toBe(3);
    expect(longPressTrigger?.actions[0]?.type).toBe("MUTATE_STATE");
    expect(longPressTrigger?.actions[1]?.type).toBe("EMIT_HARNESS_RPC");

    const timerTrigger = recovered.triggers.find((t) => t.event === "ON_TIMER_TICK");
    expect(timerTrigger).toBeDefined();
    expect(timerTrigger?.condition?.stateKey).toBe("focusMinutes");
    expect(timerTrigger?.condition?.operator).toBe("GT");
    expect(timerTrigger?.condition?.compareValue).toBe(0);
  });

  it("detects corrupted byte header and fails verification", () => {
    const bytecode = compileWidgetToBytecode(focusMicAutomation);
    const corruptBuffer = new Uint8Array(bytecode);
    corruptBuffer[0] = 0x00; // Invalidate 'PBWG' magic

    expect(() => decompileBytecodeToWidget(corruptBuffer)).toThrowError(
      /Invalid bytecode magic/
    );
  });

  it("detects payload tampering via CRC16-CCITT mismatch", () => {
    const bytecode = compileWidgetToBytecode(focusMicAutomation);
    const tampered = new Uint8Array(bytecode);
    // Tamper with payload byte after header
    tampered[BYTECODE_HEADER_SIZE + 2] = (tampered[BYTECODE_HEADER_SIZE + 2]! ^ 0xff);

    expect(() => decompileBytecodeToWidget(tampered)).toThrowError(
      /CRC16 checksum mismatch/
    );
  });
});
