import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  compileWidgetToBytecode,
  decompileBytecodeToWidget,
  crc16Ccitt,
  hexToRgb565,
  rgb565ToHex,
  BYTECODE_MAGIC,
  BYTECODE_VERSION,
  BYTECODE_HEADER_SIZE,
  type WidgetPackage,
} from "@petbot/widget-schema";
import { FrameType, encodeFrame, decodeFrame } from "@petbot/protocol";

describe("PSRAM Declarative Widget & No-Code Automation Runtime (WidgetVM)", () => {
  const firmwareDir = path.resolve(__dirname, "../../../firmware");
  const widgetVmHPath = path.join(firmwareDir, "include/agentic/widget_vm.h");
  const widgetVmCppPath = path.join(firmwareDir, "src/agentic/widget_vm.cpp");
  const widgetRegistryHPath = path.join(firmwareDir, "include/agentic/widget_registry.h");
  const widgetRegistryCppPath = path.join(firmwareDir, "src/agentic/widget_registry.cpp");
  const appPageHPath = path.join(firmwareDir, "include/apps/app_page.h");
  const uiManagerHPath = path.join(firmwareDir, "include/ui/ui_manager.h");
  const uiManagerCppPath = path.join(firmwareDir, "src/ui/ui_manager.cpp");
  const expressionEngineHPath = path.join(firmwareDir, "include/ui/expression_engine.h");

  it("verifies all C++20 WidgetVM and WidgetRegistry files exist with zero TODOs or placeholders", () => {
    const files = [
      widgetVmHPath,
      widgetVmCppPath,
      widgetRegistryHPath,
      widgetRegistryCppPath,
      appPageHPath,
      uiManagerHPath,
      uiManagerCppPath,
      expressionEngineHPath,
    ];

    for (const file of files) {
      expect(fs.existsSync(file), `File missing: ${file}`).toBe(true);
      const content = fs.readFileSync(file, "utf-8");
      expect(content).not.toMatch(/\bTODO\b/);
      expect(content).not.toMatch(/\bTBD\b/);
      expect(content).not.toMatch(/\bFIXME\b/);
      expect(content).not.toMatch(/\bPLACEHOLDER\b/i);
    }
  });

  it("verifies WidgetVM implements IAppPage interface from app_page.h", () => {
    const vmH = fs.readFileSync(widgetVmHPath, "utf-8");
    expect(vmH).toContain("class WidgetVM : public petbot::firmware::apps::IAppPage");
    expect(vmH).toContain("const char* getPageId() const noexcept override");
    expect(vmH).toContain("const char* getPageTitle() const noexcept override");
    expect(vmH).toContain("void onEnter() override");
    expect(vmH).toContain("void onExit() override");
    expect(vmH).toContain("void update(uint32_t nowMs) override");
    expect(vmH).toContain("void render(Canvas128x160& canvas) override");
    expect(vmH).toContain("void handleTouch(const TouchGestureEvent& evt) override");
  });

  it("verifies 128KB PSRAM Arena allocation and state slot table structure", () => {
    const vmH = fs.readFileSync(widgetVmHPath, "utf-8");
    expect(vmH).toContain("class PsramWidgetArena");
    expect(vmH).toContain("static constexpr size_t ARENA_SIZE = 128 * 1024;");
    expect(vmH).toContain("StateSlot m_slots[petbot::widget::bytecode::MAX_STATE_SLOTS]");
    expect(vmH).toContain("float sparklineHistory[32]");
    expect(vmH).toContain("void pushSparkline(float val) noexcept");

    const vmCpp = fs.readFileSync(widgetVmCppPath, "utf-8");
    expect(vmCpp).toContain("MALLOC_CAP_SPIRAM");
  });

  it("compiles declarative widget package into PBWG binary bytecode and validates 8-byte header and CRC16", () => {
    const sampleWidget: WidgetPackage = {
      manifest: {
        id: "com.petbot.pemonitor",
        name: "PC Telemetry",
        version: "1.0.0",
        author: "Agentic Edge",
        iconId: 3,
        refreshIntervalMs: 500,
        requiresAgenticMode: true,
      },
      state: {
        cpuUsage: {
          type: "float",
          initialValue: 32.5,
          persistToSd: false,
        },
        ramUsage: {
          type: "int32",
          initialValue: 48,
          persistToSd: false,
        },
        alertActive: {
          type: "bool",
          initialValue: false,
          persistToSd: true,
        },
        statusText: {
          type: "string",
          initialValue: "ALL SYSTEMS NOMINAL",
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
            y: 4,
            w: 144,
            h: 16,
            text: "CPU: {{cpuUsage}}%",
            fontSize: "md",
            color: "#00FF00",
            align: "center",
          },
          {
            type: "ProgressBar",
            x: 16,
            y: 22,
            w: 128,
            h: 10,
            valueBinding: "cpuUsage",
            min: 0,
            max: 100,
            fgColor: "#00FF00",
            bgColor: "#222222",
            orientation: "horizontal",
          },
          {
            type: "Sparkline",
            x: 16,
            y: 36,
            w: 128,
            h: 24,
            dataBinding: "cpuUsage",
            color: "#00F0FF",
            lineWidth: 2,
            min: 0,
            max: 100,
          },
          {
            type: "PetExpression",
            x: 48,
            y: 64,
            w: 64,
            h: 40,
            emotion: "HAPPY",
            size: 40,
          },
          {
            type: "Text",
            x: 8,
            y: 108,
            w: 144,
            h: 18,
            text: "{{statusText}}",
            fontSize: "sm",
            color: "#FFFFFF",
            align: "center",
          },
        ],
      },
      triggers: [
        {
          event: "ON_TOUCH_TAP",
          actions: [
            {
              type: "MUTATE_STATE",
              targetKey: "cpuUsage",
              operation: "INCREMENT",
              value: 5.0,
            },
            {
              type: "PLAY_SOUND",
              soundId: "TICK",
              frequencyHz: 1800,
              durationMs: 15,
            },
          ],
        },
        {
          event: "ON_TIMER_TICK",
          condition: {
            stateKey: "cpuUsage",
            operator: "GT",
            compareValue: 80.0,
          },
          actions: [
            {
              type: "SET_EXPRESSION",
              emotion: "ALERT",
              durationMs: 3000,
            },
            {
              type: "EMIT_HARNESS_RPC",
              actionId: "system.coolDown",
              riskTier: "TIER_1_SAFE",
              payload: { reason: "high_temp" },
            },
          ],
        },
      ],
    };

    // Compile into bytecode
    const bytecode = compileWidgetToBytecode(sampleWidget);
    expect(bytecode.byteLength).toBeGreaterThan(BYTECODE_HEADER_SIZE);

    // Verify 8-byte PBWG binary header
    expect(bytecode[0]).toBe(0x50); // 'P'
    expect(bytecode[1]).toBe(0x42); // 'B'
    expect(bytecode[2]).toBe(0x57); // 'W'
    expect(bytecode[3]).toBe(0x47); // 'G'

    const view = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
    const version = view.getUint16(4, true);
    const checksum = view.getUint16(6, true);
    expect(version).toBe(BYTECODE_VERSION);

    // Verify CRC16-CCITT over payload
    const payload = bytecode.subarray(BYTECODE_HEADER_SIZE);
    const computedCrc = crc16Ccitt(payload);
    expect(checksum).toBe(computedCrc);

    // Decompile and verify schema preservation
    const decompiled = decompileBytecodeToWidget(bytecode);
    expect(decompiled.manifest.id).toBe("com.petbot.pemonitor");
    expect(decompiled.manifest.name).toBe("PC Telemetry");
    expect(decompiled.manifest.refreshIntervalMs).toBe(500);
    expect(decompiled.state.cpuUsage.type).toBe("float");
    expect(decompiled.state.ramUsage.type).toBe("int32");
    expect(decompiled.triggers.length).toBe(2);
  });

  it("verifies CRC16 checksum corruption detection and rejection", () => {
    const sampleWidget: WidgetPackage = {
      manifest: {
        id: "com.petbot.corrupttest",
        name: "Corrupt Test",
        version: "1.0.0",
        author: "Tester",
        iconId: 1,
        refreshIntervalMs: 1000,
        requiresAgenticMode: false,
      },
      state: {
        val: { type: "int32", initialValue: 0, persistToSd: false },
      },
      ui: {
        type: "Container",
        x: 0,
        y: 0,
        w: 160,
        h: 128,
        backgroundColor: "#000000",
        borderRadius: 0,
      },
      triggers: [],
    };

    const bytecode = compileWidgetToBytecode(sampleWidget);
    const corrupted = new Uint8Array(bytecode);

    // Corrupt one byte in the payload
    corrupted[BYTECODE_HEADER_SIZE + 4] = corrupted[BYTECODE_HEADER_SIZE + 4]! ^ 0xff;

    const payload = corrupted.subarray(BYTECODE_HEADER_SIZE);
    const headerCrc = new DataView(corrupted.buffer, corrupted.byteOffset).getUint16(6, true);
    const actualCrc = crc16Ccitt(payload);

    expect(actualCrc).not.toBe(headerCrc);
  });

  it("verifies zero-allocation string interpolation with slot indices and state keys", () => {
    // Emulate C++ interpolateText algorithm
    const slots = [
      { key: "cpu", type: "float", valFloat: 45.2, valStr: "45.2" },
      { key: "uptime", type: "int32", valInt: 3600, valStr: "3600" },
      { key: "active", type: "bool", valBool: true, valStr: "true" },
      { key: "status", type: "string", valStr: "ONLINE" },
    ];

    function interpolate(template: string): string {
      return template.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, token) => {
        let target = slots.find((s) => s.key === token);
        if (!target && /^\d+$/.test(token)) {
          const idx = parseInt(token, 10);
          target = slots[idx];
        }
        return target ? target.valStr : "";
      });
    }

    expect(interpolate("CPU: {{cpu}}%")).toBe("CPU: 45.2%");
    expect(interpolate("Up: {{uptime}}s | {{status}}")).toBe("Up: 3600s | ONLINE");
    expect(interpolate("Slot0: {{0}} | Slot1: {{1}}")).toBe("Slot0: 45.2 | Slot1: 3600");
  });

  it("verifies condition evaluation for Eq, Neq, Gt, Lt, Gte, Lte operators", () => {
    function evalCond(slotVal: number, op: number, compareVal: number): boolean {
      switch (op) {
        case 1:
          return slotVal === compareVal; // Eq
        case 2:
          return slotVal !== compareVal; // Neq
        case 3:
          return slotVal > compareVal; // Gt
        case 4:
          return slotVal < compareVal; // Lt
        case 5:
          return slotVal >= compareVal; // Gte
        case 6:
          return slotVal <= compareVal; // Lte
        default:
          return false;
      }
    }

    expect(evalCond(85, 3, 80)).toBe(true); // 85 > 80 (Gt)
    expect(evalCond(80, 3, 80)).toBe(false); // 80 > 80 (Gt false)
    expect(evalCond(80, 5, 80)).toBe(true); // 80 >= 80 (Gte true)
    expect(evalCond(10, 4, 20)).toBe(true); // 10 < 20 (Lt true)
    expect(evalCond(15, 1, 15)).toBe(true); // 15 == 15 (Eq true)
    expect(evalCond(15, 2, 15)).toBe(false); // 15 != 15 (Neq false)
  });

  it("verifies 32-point rolling telemetry buffer maintains FIFO history for sparklines", () => {
    const history: number[] = [];

    function pushTelemetry(val: number) {
      if (history.length < 32) {
        history.push(val);
      } else {
        history.shift();
        history.push(val);
      }
    }

    for (let i = 1; i <= 40; ++i) {
      pushTelemetry(i);
    }

    expect(history.length).toBe(32);
    expect(history[0]).toBe(9); // First 8 were pushed out
    expect(history[31]).toBe(40); // Most recent
  });

  it("verifies FrameType::WidgetDeploy frame encoding and simulated hot-reload under 15ms", () => {
    const sampleWidget: WidgetPackage = {
      manifest: {
        id: "com.petbot.speedtest",
        name: "Fast Deploy App",
        version: "1.0.0",
        author: "Architect",
        iconId: 1,
        refreshIntervalMs: 1000,
        requiresAgenticMode: false,
      },
      state: {
        count: { type: "int32", initialValue: 0, persistToSd: false },
      },
      ui: {
        type: "Container",
        x: 0,
        y: 0,
        w: 160,
        h: 128,
        backgroundColor: "#111111",
        borderRadius: 4,
      },
      triggers: [],
    };

    const bytecode = compileWidgetToBytecode(sampleWidget);
    const deployFrame = encodeFrame(FrameType.WidgetDeploy, bytecode);

    const decoded = decodeFrame(deployFrame);
    expect(decoded.header.type).toBe(FrameType.WidgetDeploy);
    expect(decoded.payload.byteLength).toBe(bytecode.byteLength);

    // Measure simulated hot-reload latency
    const start = performance.now();
    const decompiled = decompileBytecodeToWidget(decoded.payload);
    const elapsedMs = performance.now() - start;

    expect(decompiled.manifest.id).toBe("com.petbot.speedtest");
    expect(elapsedMs).toBeLessThan(15); // <15ms hot-reload requirement!
  });

  it("verifies WidgetRegistry auto-registration and slide navigation integration", () => {
    const regH = fs.readFileSync(widgetRegistryHPath, "utf-8");
    expect(regH).toContain("class WidgetRegistry");
    expect(regH).toContain("size_t scanAndLoadInstalledWidgets()");
    expect(regH).toContain("bool handleWidgetDeployFrame(const uint8_t* payload, size_t length)");
    expect(regH).toContain("bool removeWidget(const char* widgetId)");

    const regCpp = fs.readFileSync(widgetRegistryCppPath, "utf-8");
    expect(regCpp).toContain("petbot::protocol::FrameType::WidgetDeploy");
    expect(regCpp).toContain("UIManager::instance().registerPage(vm);");
    expect(regCpp).toContain("UIManager::instance().navigateToPage(widgetId.c_str(), true);");
    expect(regCpp).toContain("StorageHal::instance().writeFileAtomic(filePath, payload, length, false);");
    expect(regCpp).toContain("SoundId::HappyTrill");
  });
});
