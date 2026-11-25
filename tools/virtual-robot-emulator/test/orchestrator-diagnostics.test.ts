import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Phase 2 Orchestrator, Dual-Core FreeRTOS Tasks & Hardware Diagnostics Suite", () => {
  const firmwareDir = path.resolve(__dirname, "../../../firmware");
  const mainCppPath = path.join(firmwareDir, "src/main.cpp");
  const uiManagerHPath = path.join(firmwareDir, "include/ui/ui_manager.h");
  const uiManagerCppPath = path.join(firmwareDir, "src/ui/ui_manager.cpp");
  const touchHalHPath = path.join(firmwareDir, "include/hal/touch_hal.h");
  const touchHalCppPath = path.join(firmwareDir, "src/hal/touch_hal.cpp");
  const audioHalCppPath = path.join(firmwareDir, "src/hal/audio_hal.cpp");
  const storageHalCppPath = path.join(firmwareDir, "src/hal/storage_hal.cpp");

  it("verifies main.cpp, ui_manager.h, and ui_manager.cpp contain zero placeholders or TODOs", () => {
    expect(fs.existsSync(mainCppPath)).toBe(true);
    expect(fs.existsSync(uiManagerHPath)).toBe(true);
    expect(fs.existsSync(uiManagerCppPath)).toBe(true);

    const mainContent = fs.readFileSync(mainCppPath, "utf-8");
    const uiHContent = fs.readFileSync(uiManagerHPath, "utf-8");
    const uiCppContent = fs.readFileSync(uiManagerCppPath, "utf-8");

    for (const [name, content] of [
      ["main.cpp", mainContent],
      ["ui_manager.h", uiHContent],
      ["ui_manager.cpp", uiCppContent],
    ] as const) {
      expect(content).not.toMatch(/\bTODO\b/i);
      expect(content).not.toMatch(/\bFIXME\b/i);
      expect(content).not.toMatch(/\bplaceholder\b/i);
      expect(content).not.toMatch(/\bstub\b/i);
    }
  });

  it("enforces strict FreeRTOS Dual-Core separation across Core 0 and Core 1", () => {
    const mainContent = fs.readFileSync(mainCppPath, "utf-8");
    const audioContent = fs.readFileSync(audioHalCppPath, "utf-8");
    const touchContent = fs.readFileSync(touchHalCppPath, "utf-8");

    // Core 1 Tasks: UI & Interaction
    expect(mainContent).toContain("Task_UIRender");
    expect(mainContent).toContain("Task_TouchPoll");

    // Task_UIRender: Priority 5, Core 1, vTaskDelayUntil (60Hz deterministic loop)
    expect(mainContent).toMatch(/Task_UIRender[\s\S]*?,\s*5\s*,[^,]+,\s*1\s*\/\/\s*Core 1/);
    expect(mainContent).toContain("vTaskDelayUntil");
    expect(mainContent).toContain("swapAndFlushDMA");

    // Task_TouchPoll: Priority 6, Core 1 (200Hz touch gesture dispatch)
    expect(mainContent).toMatch(/Task_TouchPoll[\s\S]*?,\s*6\s*,[^,]+,\s*1\s*\/\/\s*Core 1/);

    // Core 0 Tasks: Audio & Storage
    // Task_AudioEngine: Priority 4, Core 0 (I2S DMA audio synthesis)
    expect(audioContent).toMatch(/Task_AudioEngine/);
    expect(audioContent).toMatch(/audioEngineTask[\s\S]*?,\s*4\s*,[^,]+,\s*0\s*\/\/\s*Pin strictly to Core 0/);

    // Task_StorageWorker: Priority 2, Core 0 (Background SD/Flash writer)
    expect(mainContent).toContain("Task_StorageWorker");
    expect(mainContent).toMatch(/Task_StorageWorker[\s\S]*?,\s*2\s*,[^,]+,\s*0\s*\/\/\s*Core 0/);
    expect(mainContent).toContain("processAsyncWrites");

    // TouchHal engine task: Priority 6, Core 1
    expect(touchContent).toMatch(/TouchHal::touchTask[\s\S]*?,\s*6\s*,[^,]+,\s*1\s*\/\/\s*Core 1/);
  });

  it("verifies Boot Sequence requirements in main.cpp", () => {
    const mainContent = fs.readFileSync(mainCppPath, "utf-8");

    // 1. Serial at 115200 baud
    expect(mainContent).toContain("Serial.begin(115200)");

    // 2. Octal PSRAM capability & partition report
    expect(mainContent).toContain("ESP.getPsramSize()");
    expect(mainContent).toContain("esp_partition_find");
    expect(mainContent).toContain("PsramMemoryManager::isPsramAvailable()");
    expect(mainContent).toContain("PsramMemoryManager::getFreePsram()");

    // 3. Capacitive touch sensor check during boot for telemetry overlay override
    expect(mainContent).toContain("PIN_TOUCH_SENSOR");
    expect(mainContent).toContain("INPUT_PULLDOWN");
    expect(mainContent).toContain("setTelemetryEnabled(true)");

    // 4. Initializing HAL & UI subsystems
    expect(mainContent).toContain("StorageHal::instance().init()");
    expect(mainContent).toContain("DisplayHal::instance().init()");
    expect(mainContent).toContain("AudioHal::instance().init()");
    expect(mainContent).toContain("TouchHal::instance().init()");
    expect(mainContent).toContain("UIManager::instance().init()");

    // 5. 1.2-second 60FPS Wakeup Boot Animation
    expect(mainContent).toContain("SoundId::Chirp");
    expect(mainContent).toContain("BOOT_ANIM_DURATION_MS = 1200");
    expect(mainContent).toContain("BOOT_ANIM_FRAME_MS = 16");
    expect(mainContent).toContain("setEmotion(EmotionId::Sleepy");
    expect(mainContent).toContain("setEmotion(EmotionId::Happy");
    expect(mainContent).toContain("setEmotion(EmotionId::Idle");
  });

  it("verifies non-blocking Serial CLI parser supports all required commands", () => {
    const mainContent = fs.readFileSync(mainCppPath, "utf-8");

    const requiredCommands = [
      "help",
      "status",
      "tap",
      "doubletap",
      "longpress",
      "pet",
      "emotion",
      "diag",
      "notes",
      "habits",
      "pomo",
    ];

    for (const cmd of requiredCommands) {
      expect(mainContent).toContain(`"${cmd}"`);
    }

    // Check action handlers in CLI parser
    expect(mainContent).toContain("Single Tap");
    expect(mainContent).toContain("nextPage()");
    expect(mainContent).toContain("Long Press");
    expect(mainContent).toContain("onPettingGesture()");
    expect(mainContent).toContain("toggleTelemetry()");
  });

  it("verifies UIManager implements 2-page cubicOut slide transition with PSRAM scratch buffer", () => {
    const uiCpp = fs.readFileSync(uiManagerCppPath, "utf-8");
    const uiH = fs.readFileSync(uiManagerHPath, "utf-8");

    // Allocation of 40,960 Bytes PSRAM buffer
    expect(uiCpp).toContain("PsramMemoryManager::allocatePsram(petbot::hal::LCD_FRAME_BYTES");
    expect(uiCpp).toContain("m_transitionCanvas.setTargetBuffer(m_transitionScratchBuffer)");
    expect(uiCpp).toContain("PsramMemoryManager::freePsram(m_transitionScratchBuffer)");

    // 200ms cubicOut easing
    expect(uiH).toContain("easeCubicOut");
    expect(uiH).toContain("durationMs{200}");
    expect(uiCpp).toContain("durationMs = 200");

    // Two-page horizontal composition and glowing cyan seam
    expect(uiCpp).toContain("fromPage->render(m_transitionCanvas)");
    expect(uiCpp).toContain("toPage->render(canvas)");
    expect(uiCpp).toContain("drawFastVLine(seamX, 0, H, petbot::hal::colors::Cyan)");

    // Extensible dynamic widget slot APIs
    expect(uiCpp).toContain("registerWidgetPage");
    expect(uiCpp).toContain("unregisterWidgetPage");
    expect(uiCpp).toContain("getBuiltinPageCount");
    expect(uiCpp).toContain("getWidgetPageCount");
    expect(uiCpp).toContain("getPageById");
  });

  it("verifies Top HUD Toast and Telemetry Overlay implementation", () => {
    const uiCpp = fs.readFileSync(uiManagerCppPath, "utf-8");

    // Top HUD Toast positioning (y = 7)
    expect(uiCpp).toContain("TOAST_Y = 7");
    expect(uiCpp).toContain("blendAlpha");
    expect(uiCpp).toContain("drawRoundRect");

    // Telemetry Overlay
    expect(uiCpp).toContain("updateTelemetry");
    expect(uiCpp).toContain("renderTelemetryOverlay");
    expect(uiCpp).toContain("m_fpsFiltered");
    expect(uiCpp).toContain("freeSramKb");
    expect(uiCpp).toContain("freePsramKb");
  });

  it("simulates easeCubicOut math for 200ms transition progress", () => {
    const easeCubicOut = (t: number) => {
      const f = 1.0 - Math.min(Math.max(t, 0.0), 1.0);
      return 1.0 - f * f * f;
    };

    // Boundary conditions
    expect(easeCubicOut(0.0)).toBeCloseTo(0.0, 5);
    expect(easeCubicOut(1.0)).toBeCloseTo(1.0, 5);

    // Easing progression: cubic out decelerates smoothly towards end
    expect(easeCubicOut(0.5)).toBeCloseTo(0.875, 4); // 1 - 0.5^3 = 0.875
    expect(easeCubicOut(0.25)).toBeCloseTo(0.578125, 4); // 1 - 0.75^3 = 0.578125
    expect(easeCubicOut(0.75)).toBeCloseTo(0.984375, 4); // 1 - 0.25^3 = 0.984375

    // Verify monotonic increase
    let prev = 0.0;
    for (let i = 1; i <= 20; ++i) {
      const t = i / 20;
      const v = easeCubicOut(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }

    // Verify horizontal seam displacement for width = 128
    const width = 128;
    const tValues = [0.0, 0.25, 0.5, 0.75, 1.0];
    const leftSeams = tValues.map((t) => Math.round(width - easeCubicOut(t) * width));
    const rightSeams = tValues.map((t) => Math.round(easeCubicOut(t) * width));

    // Next page (slide left): seam moves from 128 to 0
    expect(leftSeams[0]).toBe(128);
    expect(leftSeams[leftSeams.length - 1]).toBe(0);

    // Prev page (slide right): seam moves from 0 to 128
    expect(rightSeams[0]).toBe(0);
    expect(rightSeams[rightSeams.length - 1]).toBe(128);
  });

  it("simulates Telemetry FPS exponential moving average (EMA) filter", () => {
    // EMA: fps = 0.9 * prev + 0.1 * instant
    let filteredFps = 60.0;
    const idealFrameUs = 16666; // 16.666 ms = 60 FPS

    for (let f = 0; f < 60; ++f) {
      const instant = 1000000.0 / idealFrameUs;
      filteredFps = filteredFps * 0.9 + instant * 0.1;
    }
    expect(filteredFps).toBeCloseTo(60.0, 1);

    // Step response to 30 FPS load (33333 us)
    const loadFrameUs = 33333;
    for (let f = 0; f < 75; ++f) {
      const instant = 1000000.0 / loadFrameUs;
      filteredFps = filteredFps * 0.9 + instant * 0.1;
    }
    // After 75 frames (1.25s), converges to 30 FPS
    expect(filteredFps).toBeCloseTo(30.0, 1);
  });

  it("simulates Serial CLI parser command execution flow", () => {
    class MockCliRunner {
      public lastAction = "";
      public emotionId = 0;
      public telemetry = false;

      execute(cmd: string): string {
        const trimmed = cmd.trim();
        if (trimmed === "help") {
          this.lastAction = "help";
          return "HELP_SHOWN";
        } else if (trimmed === "status") {
          this.lastAction = "status";
          return "STATUS_SHOWN";
        } else if (trimmed === "tap") {
          this.lastAction = "tap";
          return "TAP_DISPATCHED";
        } else if (trimmed === "doubletap") {
          this.lastAction = "doubletap";
          return "NEXT_PAGE_DISPATCHED";
        } else if (trimmed === "longpress") {
          this.lastAction = "longpress";
          return "LONGPRESS_DISPATCHED";
        } else if (trimmed === "pet") {
          this.lastAction = "pet";
          return "PETTING_DISPATCHED";
        } else if (trimmed.startsWith("emotion")) {
          const id = parseInt(trimmed.substring(7).trim(), 10);
          this.emotionId = id;
          this.lastAction = `emotion_${id}`;
          return `EMOTION_${id}`;
        } else if (trimmed === "diag") {
          this.telemetry = !this.telemetry;
          this.lastAction = "diag";
          return this.telemetry ? "DIAG_ENABLED" : "DIAG_DISABLED";
        } else if (trimmed === "notes") {
          this.lastAction = "notes";
          return "NOTES_PRINTED";
        } else if (trimmed === "habits") {
          this.lastAction = "habits";
          return "HABITS_PRINTED";
        } else if (trimmed === "pomo") {
          this.lastAction = "pomo";
          return "POMO_PRINTED";
        }
        return "UNKNOWN_COMMAND";
      }
    }

    const runner = new MockCliRunner();
    expect(runner.execute("help")).toBe("HELP_SHOWN");
    expect(runner.execute("status")).toBe("STATUS_SHOWN");
    expect(runner.execute("tap")).toBe("TAP_DISPATCHED");
    expect(runner.execute("doubletap")).toBe("NEXT_PAGE_DISPATCHED");
    expect(runner.execute("longpress")).toBe("LONGPRESS_DISPATCHED");
    expect(runner.execute("pet")).toBe("PETTING_DISPATCHED");
    expect(runner.execute("emotion 3")).toBe("EMOTION_3");
    expect(runner.emotionId).toBe(3);
    expect(runner.execute("diag")).toBe("DIAG_ENABLED");
    expect(runner.telemetry).toBe(true);
    expect(runner.execute("diag")).toBe("DIAG_DISABLED");
    expect(runner.telemetry).toBe(false);
    expect(runner.execute("notes")).toBe("NOTES_PRINTED");
    expect(runner.execute("habits")).toBe("HABITS_PRINTED");
    expect(runner.execute("pomo")).toBe("POMO_PRINTED");
    expect(runner.execute("invalid")).toBe("UNKNOWN_COMMAND");
  });

  it("simulates 1.2-second 60FPS wakeup boot animation timing", () => {
    const BOOT_ANIM_DURATION_MS = 1200;
    const BOOT_ANIM_FRAME_MS = 16;
    const totalFrames = Math.floor(BOOT_ANIM_DURATION_MS / BOOT_ANIM_FRAME_MS);

    expect(totalFrames).toBe(75);

    // Frame timeline simulation
    let currentEmotion = "Sleepy";
    let backlightPct = 20;

    for (let frame = 0; frame <= totalFrames; ++frame) {
      const elapsedMs = Math.min(frame * BOOT_ANIM_FRAME_MS, BOOT_ANIM_DURATION_MS);
      const t = elapsedMs / BOOT_ANIM_DURATION_MS;

      // At 40% progress (~480ms), sleepy eyes transition to Happy
      if (t >= 0.4 && currentEmotion === "Sleepy") {
        currentEmotion = "Happy";
      }

      backlightPct = Math.min(Math.max(Math.round(t * 100), 20), 100);
    }

    // At end of boot animation, robot is awake and backlight is at 100%
    expect(currentEmotion).toBe("Happy");
    expect(backlightPct).toBe(100);
  });
});
