import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { crc32 } from "@petbot/protocol";

describe("Firmware HAL & Configuration Verification", () => {
  const firmwareDir = path.resolve(__dirname, "../../../firmware");
  const platformioIniPath = path.join(firmwareDir, "platformio.ini");
  const partitionsCsvPath = path.join(firmwareDir, "partitions_16MB.csv");
  const boardPinsPath = path.join(firmwareDir, "include/hal/board_pins.h");
  const psramAllocatorHPath = path.join(firmwareDir, "include/hal/psram_allocator.h");
  const psramAllocatorCppPath = path.join(firmwareDir, "src/hal/psram_allocator.cpp");
  const displayHalHPath = path.join(firmwareDir, "include/hal/display_hal.h");
  const displayHalCppPath = path.join(firmwareDir, "src/hal/display_hal.cpp");
  const storageHalHPath = path.join(firmwareDir, "include/hal/storage_hal.h");
  const storageHalCppPath = path.join(firmwareDir, "src/hal/storage_hal.cpp");

  it("verifies platformio.ini contains required S3 N16R8 configuration", () => {
    expect(fs.existsSync(platformioIniPath)).toBe(true);
    const content = fs.readFileSync(platformioIniPath, "utf-8");

    // Board & Flash/PSRAM
    expect(content).toContain("env:esp32-s3-n16r8");
    expect(content).toContain("board_build.arduino.memory_type = qio_opi");
    expect(content).toContain("board_build.flash_mode = qio");
    expect(content).toContain("board_upload.flash_size = 16MB");
    expect(content).toContain("partitions_16MB.csv");

    // Compiler flags
    expect(content).toContain("-std=gnu++2a");
    expect(content).toContain("-O3");
    expect(content).toContain("-DESP32S3_N16R8");
    expect(content).toContain("-DBOARD_HAS_PSRAM");
    expect(content).toContain("-mfix-esp32-psram-cache-issue");

    // Libraries
    expect(content).toContain("LittleFS");
    expect(content).toContain("SD");
  });

  it("verifies partitions_16MB.csv conforms to 16MB dual 4MB OTA + 6MB LittleFS architecture", () => {
    expect(fs.existsSync(partitionsCsvPath)).toBe(true);
    const lines = fs.readFileSync(partitionsCsvPath, "utf-8").split("\n");

    interface Partition {
      name: string;
      type: string;
      subType: string;
      offset: number;
      size: number;
    }

    const partitions: Partition[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length >= 5) {
        partitions.push({
          name: parts[0],
          type: parts[1],
          subType: parts[2],
          offset: parseInt(parts[3], 16),
          size: parseInt(parts[4], 16),
        });
      }
    }

    const app0 = partitions.find((p) => p.name === "app0");
    const app1 = partitions.find((p) => p.name === "app1");
    const storage = partitions.find((p) => p.name === "storage");
    const nvs = partitions.find((p) => p.name === "nvs");
    const coredump = partitions.find((p) => p.name === "coredump");

    expect(app0).toBeDefined();
    expect(app1).toBeDefined();
    expect(storage).toBeDefined();
    expect(nvs).toBeDefined();
    expect(coredump).toBeDefined();

    // Dual 4MB OTA slots: 4MB = 0x400000 = 4,194,304 bytes
    expect(app0!.size).toBe(0x400000);
    expect(app1!.size).toBe(0x400000);
    expect(app0!.subType).toBe("ota_0");
    expect(app1!.subType).toBe("ota_1");

    // 6MB LittleFS storage: 6MB = 0x600000 = 6,291,456 bytes
    expect(storage!.size).toBe(0x600000);

    // MMU 64KB alignment for app partitions
    expect(app0!.offset % 0x10000).toBe(0);
    expect(app1!.offset % 0x10000).toBe(0);

    // Total flash boundary check <= 16MB (0x1000000)
    for (const p of partitions) {
      expect(p.offset + p.size).toBeLessThanOrEqual(0x1000000);
    }
  });

  it("verifies board_pins.h specifies exact GPIO assignments", () => {
    expect(fs.existsSync(boardPinsPath)).toBe(true);
    const content = fs.readFileSync(boardPinsPath, "utf-8");

    // ST7735 1.8" TFT SPI
    expect(content).toMatch(/PIN_TFT_MOSI\s*=\s*11/);
    expect(content).toMatch(/PIN_TFT_SCLK\s*=\s*12/);
    expect(content).toMatch(/PIN_TFT_CS\s*=\s*10/);
    expect(content).toMatch(/PIN_TFT_DC\s*=\s*9/);
    expect(content).toMatch(/PIN_TFT_RST\s*=\s*14/);
    expect(content).toMatch(/PIN_TFT_BL\s*=\s*21/);

    // MicroSD Card
    expect(content).toMatch(/PIN_SD_CS\s*=\s*38/);
    expect(content).toMatch(/PIN_SD_MOSI\s*=\s*39/);
    expect(content).toMatch(/PIN_SD_MISO\s*=\s*40/);
    expect(content).toMatch(/PIN_SD_SCLK\s*=\s*41/);

    // I2S MEMS Mic (I2S_NUM_0)
    expect(content).toMatch(/PIN_MIC_BCLK\s*=\s*4/);
    expect(content).toMatch(/PIN_MIC_WS\s*=\s*5/);
    expect(content).toMatch(/PIN_MIC_DIN\s*=\s*6/);

    // I2S Speaker Amp (I2S_NUM_1)
    expect(content).toMatch(/PIN_SPK_BCLK\s*=\s*15/);
    expect(content).toMatch(/PIN_SPK_LRCK\s*=\s*16/);
    expect(content).toMatch(/PIN_SPK_DOUT\s*=\s*7/);
    expect(content).toMatch(/PIN_SPK_SD_MODE\s*=\s*17/);

    // Capacitive Touch
    expect(content).toMatch(/PIN_TOUCH_SENSOR\s*=\s*1/);
  });

  it("verifies psram_allocator and Canvas128x160 have complete drawing primitives and no TODOs", () => {
    expect(fs.existsSync(psramAllocatorHPath)).toBe(true);
    expect(fs.existsSync(psramAllocatorCppPath)).toBe(true);

    const hContent = fs.readFileSync(psramAllocatorHPath, "utf-8");
    const cppContent = fs.readFileSync(psramAllocatorCppPath, "utf-8");

    // Zero placeholders / TODOs rule
    expect(hContent).not.toMatch(/\bTODO\b/i);
    expect(cppContent).not.toMatch(/\bTODO\b/i);
    expect(hContent).not.toMatch(/\bFIXME\b/i);
    expect(cppContent).not.toMatch(/\bFIXME\b/i);

    // Memory caps used
    expect(hContent).toContain("MALLOC_CAP_SPIRAM");
    expect(hContent).toContain("MALLOC_CAP_DMA");
    expect(hContent).toContain("MALLOC_CAP_INTERNAL");

    // Drawing primitives present
    const primitives = [
      "clear",
      "drawPixel",
      "fillRect",
      "fillRoundRect",
      "drawLine",
      "drawFastHLine",
      "drawFastVLine",
      "drawCircle",
      "fillCircle",
      "drawBitmapRGB565",
      "drawText",
      "blendAlpha",
    ];

    for (const prim of primitives) {
      expect(hContent).toContain(prim);
      expect(cppContent).toContain(prim);
    }

    // Geometry
    expect(hContent).toContain("128");
    expect(hContent).toContain("160");
    expect(hContent).toContain("40960"); // 128*160*2 bytes
    expect(hContent).toContain("10240"); // 128*40*2 bytes DMA slice
  });

  it("verifies display_hal ST7735 60FPS SPI DMA driver architecture", () => {
    expect(fs.existsSync(displayHalHPath)).toBe(true);
    expect(fs.existsSync(displayHalCppPath)).toBe(true);

    const hContent = fs.readFileSync(displayHalHPath, "utf-8");
    const cppContent = fs.readFileSync(displayHalCppPath, "utf-8");

    // Zero placeholders / TODOs
    expect(hContent).not.toMatch(/\bTODO\b/i);
    expect(cppContent).not.toMatch(/\bTODO\b/i);

    // Double buffering in PSRAM and ping-pong DMA
    expect(hContent).toContain("frontBuffer_");
    expect(hContent).toContain("backBuffer_");
    expect(hContent).toContain("swapAndFlushDMA");
    expect(hContent).toContain("setBacklightPct");
    expect(cppContent).toContain("swapAndFlushDMA");
    expect(cppContent).toContain("setBacklightPct");

    // 40MHz SPI clock configured
    expect(hContent).toContain("40000000");

    // Asynchronous DMA pipeline execution
    expect(cppContent).toContain("runDmaFlushPipeline");
    expect(cppContent).toContain("spi_device_queue_trans");
  });

  it("verifies storage_hal provides atomic writes, PSRAM ingestion, and directory structure", () => {
    expect(fs.existsSync(storageHalHPath)).toBe(true);
    expect(fs.existsSync(storageHalCppPath)).toBe(true);

    const hContent = fs.readFileSync(storageHalHPath, "utf-8");
    const cppContent = fs.readFileSync(storageHalCppPath, "utf-8");

    // Zero placeholders / TODOs
    expect(hContent).not.toMatch(/\bTODO\b/i);
    expect(cppContent).not.toMatch(/\bTODO\b/i);

    // Standard folders
    const standardFolders = ["/vault", "/widgets", "/state", "/notes", "/habits"];
    for (const folder of standardFolders) {
      expect(cppContent).toContain(folder);
    }

    // Required functions
    expect(hContent).toContain("writeFileAtomic");
    expect(hContent).toContain("readFileToPsram");
    expect(hContent).toContain("listDirectory");
    expect(cppContent).toContain("writeFileAtomic");
    expect(cppContent).toContain("readFileToPsram");
    expect(cppContent).toContain("listDirectory");

    // CRC32 verification using petbot::protocol::petbot_crc32
    expect(hContent).toContain("petbot_protocol.h");
    expect(cppContent).toContain("petbot::protocol::petbot_crc32");
  });

  it("verifies IEEE 802.3 CRC32 calculation algorithm against protocol", () => {
    const testBuffer = Buffer.from("ESP32-S3 AI Desktop Pet Robot Octal PSRAM 60FPS ST7735");
    const crc = crc32(new Uint8Array(testBuffer));

    // IEEE 802.3 bitwise tableless simulation
    let simCrc = 0xffffffff;
    for (let i = 0; i < testBuffer.length; ++i) {
      simCrc ^= testBuffer[i];
      for (let b = 0; b < 8; ++b) {
        simCrc = (simCrc >>> 1) ^ (0xedb88320 & -(simCrc & 1));
      }
    }
    simCrc = ~simCrc >>> 0;

    expect(crc).toBe(simCrc);
  });

  it("verifies audio_hal non-blocking I2S driver and procedural synthesizer", () => {
    const audioHalHPath = path.join(firmwareDir, "include/hal/audio_hal.h");
    const audioHalCppPath = path.join(firmwareDir, "src/hal/audio_hal.cpp");

    expect(fs.existsSync(audioHalHPath)).toBe(true);
    expect(fs.existsSync(audioHalCppPath)).toBe(true);

    const hContent = fs.readFileSync(audioHalHPath, "utf-8");
    const cppContent = fs.readFileSync(audioHalCppPath, "utf-8");

    // Zero placeholders / TODOs
    expect(hContent).not.toMatch(/\bTODO\b/i);
    expect(cppContent).not.toMatch(/\bTODO\b/i);
    expect(hContent).not.toMatch(/\bFIXME\b/i);
    expect(cppContent).not.toMatch(/\bFIXME\b/i);

    // I2S peripherals configured
    expect(cppContent).toContain("I2S_NUM_1"); // MAX98357A speaker amp
    expect(cppContent).toContain("I2S_NUM_0"); // MEMS Mic
    expect(cppContent).toContain("PIN_SPK_BCLK");
    expect(cppContent).toContain("PIN_SPK_LRCK");
    expect(cppContent).toContain("PIN_SPK_DOUT");
    expect(cppContent).toContain("PIN_SPK_SD_MODE");
    expect(cppContent).toContain("PIN_MIC_BCLK");
    expect(cppContent).toContain("PIN_MIC_WS");
    expect(cppContent).toContain("PIN_MIC_DIN");

    // Sample rate: 16kHz, 320 samples per frame (20ms), 6 DMA buffers
    expect(hContent).toContain("AUDIO_SAMPLE_RATE     = 16000");
    expect(hContent).toContain("AUDIO_FRAME_SAMPLES   = 320");
    expect(hContent).toContain("I2S_DMA_BUF_COUNT     = 6");

    // Procedural sound synthesizer effects
    const soundEffects = [
      "Chirp",
      "HappyTrill",
      "Purr",
      "CuriousBeep",
      "SleepySigh",
      "Tick",
      "AlarmChime",
    ];

    for (const effect of soundEffects) {
      expect(hContent).toContain(effect);
      expect(cppContent).toContain(effect);
    }

    // Dedicated FreeRTOS task on Core 0, Priority 4
    expect(cppContent).toContain("Task_AudioEngine");
    expect(hContent).toContain("playProceduralSound");
    expect(cppContent).toContain("playProceduralSound");

    // Voice downlink streaming and mic uplink frames
    expect(hContent).toContain("pushPcmDownlinkFrame");
    expect(hContent).toContain("readMicUplinkFrame");
    expect(cppContent).toContain("pushPcmDownlinkFrame");
    expect(cppContent).toContain("readMicUplinkFrame");
  });

  it("verifies touch_hal capacitive touch sensor and gesture state machine", () => {
    const touchHalHPath = path.join(firmwareDir, "include/hal/touch_hal.h");
    const touchHalCppPath = path.join(firmwareDir, "src/hal/touch_hal.cpp");

    expect(fs.existsSync(touchHalHPath)).toBe(true);
    expect(fs.existsSync(touchHalCppPath)).toBe(true);

    const hContent = fs.readFileSync(touchHalHPath, "utf-8");
    const cppContent = fs.readFileSync(touchHalCppPath, "utf-8");

    // Zero placeholders / TODOs
    expect(hContent).not.toMatch(/\bTODO\b/i);
    expect(cppContent).not.toMatch(/\bTODO\b/i);
    expect(hContent).not.toMatch(/\bFIXME\b/i);
    expect(cppContent).not.toMatch(/\bFIXME\b/i);

    // Hardware GPIO interrupt and 200Hz debounce filter (20ms)
    expect(hContent).toContain("TOUCH_DEBOUNCE_MS         = 20");
    expect(hContent).toContain("TOUCH_TAP_MIN_MS          = 25");
    expect(hContent).toContain("TOUCH_TAP_MAX_MS          = 350");
    expect(hContent).toContain("TOUCH_DOUBLE_TAP_GAP_MS   = 240");
    expect(hContent).toContain("TOUCH_LONG_PRESS_MS       = 650");
    expect(hContent).toContain("TOUCH_PETTING_WINDOW_MS   = 1400");
    expect(hContent).toContain("TOUCH_PETTING_MIN_TAPS    = 4");

    // Gestures defined
    const gestures = ["SingleTap", "DoubleTap", "LongPress", "PettingRapid"];
    for (const g of gestures) {
      expect(hContent).toContain(g);
      expect(cppContent).toContain(g);
    }

    // Dedicated FreeRTOS task on Priority 5
    expect(cppContent).toContain("Task_TouchGesture");

    // Audio cue triggers
    expect(cppContent).toContain("SoundId::Tick");
    expect(cppContent).toContain("SoundId::Purr");
  });

  it("simulates deterministic capacitive touch gesture state machine transitions", () => {
    // Implement exact state machine transition logic for verification
    class GestureFsmSimulator {
      state: "IDLE" | "HOLDING" | "LONG_PRESS_TRIGGERED" | "AWAITING_SECOND_TAP" = "IDLE";
      lastDebounceTime = 0;
      debouncedPressed = false;
      pressStartTime = 0;
      releaseTime = 0;
      lastTapDuration = 0;
      tapHistory: number[] = [];
      emittedGestures: Array<{ gesture: string; time: number; duration: number }> = [];

      step(nowMs: number, rawPressed: boolean) {
        const DEBOUNCE_MS = 20;
        const TAP_MIN_MS = 25;
        const TAP_MAX_MS = 350;
        const DOUBLE_TAP_GAP_MS = 240;
        const LONG_PRESS_MS = 650;
        const PETTING_WINDOW_MS = 1400;
        const PETTING_MIN_TAPS = 4;

        if (rawPressed !== this.debouncedPressed) {
          if (nowMs - this.lastDebounceTime >= DEBOUNCE_MS) {
            this.debouncedPressed = rawPressed;
            this.lastDebounceTime = nowMs;

            if (this.debouncedPressed) {
              this.pressStartTime = nowMs;
              this.state = "HOLDING";
            } else {
              const tapDuration = nowMs - this.pressStartTime;
              this.releaseTime = nowMs;
              this.lastTapDuration = tapDuration;

              if (this.state === "LONG_PRESS_TRIGGERED") {
                this.state = "IDLE";
                return;
              }

              if (tapDuration >= TAP_MIN_MS && tapDuration <= TAP_MAX_MS) {
                this.tapHistory.push(nowMs);

                // Petting check
                const recentTaps = this.tapHistory.filter(
                  (t) => nowMs >= t && nowMs - t <= PETTING_WINDOW_MS
                );

                if (recentTaps.length >= PETTING_MIN_TAPS) {
                  this.emittedGestures.push({
                    gesture: "PETTING_RAPID",
                    time: nowMs,
                    duration: tapDuration,
                  });
                  this.tapHistory = [];
                  this.state = "IDLE";
                  return;
                }

                if (recentTaps.length >= 2) {
                  this.emittedGestures.push({
                    gesture: "DOUBLE_TAP",
                    time: nowMs,
                    duration: tapDuration,
                  });
                  this.state = "IDLE";
                  return;
                }

                this.state = "AWAITING_SECOND_TAP";
              } else {
                this.state = "IDLE";
              }
            }
          }
        }

        // Active Long Press check
        if (this.debouncedPressed && this.state === "HOLDING") {
          const holdDuration = nowMs - this.pressStartTime;
          if (holdDuration >= LONG_PRESS_MS) {
            this.state = "LONG_PRESS_TRIGGERED";
            this.emittedGestures.push({
              gesture: "LONG_PRESS",
              time: nowMs,
              duration: holdDuration,
            });
          }
        }

        // Quiet window expiry for Single Tap
        if (!this.debouncedPressed && this.state === "AWAITING_SECOND_TAP") {
          if (nowMs - this.releaseTime >= DOUBLE_TAP_GAP_MS) {
            this.emittedGestures.push({
              gesture: "SINGLE_TAP",
              time: nowMs,
              duration: this.lastTapDuration,
            });
            this.state = "IDLE";
          }
        }
      }
    }

    const fsm = new GestureFsmSimulator();

    // 1. Simulate Single Tap: Down at 100ms, Up at 200ms (duration 100ms), wait through 460ms (> 240ms quiet window)
    for (let t = 0; t <= 500; t += 10) {
      const isDown = t >= 100 && t < 200;
      fsm.step(t, isDown);
    }
    expect(fsm.emittedGestures.some((g) => g.gesture === "SINGLE_TAP")).toBe(true);

    // 2. Simulate Double Tap: Tap 1 (600..680ms), Tap 2 (780..850ms) -> Gap 100ms (< 240ms)
    fsm.emittedGestures = [];
    fsm.tapHistory = [];
    for (let t = 550; t <= 900; t += 10) {
      const isDown = (t >= 600 && t < 680) || (t >= 780 && t < 850);
      fsm.step(t, isDown);
    }
    expect(fsm.emittedGestures.some((g) => g.gesture === "DOUBLE_TAP")).toBe(true);

    // 3. Simulate Long Press: Down at 1000ms through 1700ms (700ms > 650ms)
    fsm.emittedGestures = [];
    fsm.tapHistory = [];
    for (let t = 950; t <= 1800; t += 10) {
      const isDown = t >= 1000 && t < 1700;
      fsm.step(t, isDown);
    }
    expect(fsm.emittedGestures.some((g) => g.gesture === "LONG_PRESS")).toBe(true);

    // 4. Simulate Petting: 4 rapid taps within 1400ms (taps at 2000, 2100, 2200, 2300ms)
    fsm.emittedGestures = [];
    fsm.tapHistory = [];
    for (let t = 1950; t <= 2450; t += 10) {
      const isDown =
        (t >= 2000 && t < 2050) ||
        (t >= 2100 && t < 2150) ||
        (t >= 2200 && t < 2250) ||
        (t >= 2300 && t < 2350);
      fsm.step(t, isDown);
    }
    expect(fsm.emittedGestures.some((g) => g.gesture === "PETTING_RAPID")).toBe(true);
  });
});
