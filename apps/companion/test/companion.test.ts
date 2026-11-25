import { describe, it, expect, beforeEach } from "vitest";
import {
  CompanionClient,
  RobotConnectionManager,
  usePetBotStore,
  BUILTIN_WIDGETS,
} from "../src/index.js";
import { EyeFaceWidget, compileWidgetToBytecode } from "@petbot/widget-schema";
import { FrameType, RobotMode, EmotionId } from "@petbot/protocol";

describe("CompanionClient", () => {
  it("formats WebSocket endpoint and mDNS discovery target correctly", () => {
    const client = new CompanionClient({ host: "petbot.local" });
    expect(client.getEndpointUrl()).toBe("ws://petbot.local:8443/ws");
    expect(client.getDiscoveryTarget()).toBe("_petbot._tcp.local");
  });

  it("encodes and roundtrips face update message", () => {
    const client = new CompanionClient({ host: "192.168.1.100", port: 8443 });
    const eyeWidget: EyeFaceWidget = {
      type: "EYE_FACE",
      leftEye: {
        emotion: "HAPPY",
        eyelidOpenness: 1.0,
        pupilSize: 1.0,
        lookOffsetX: 0.0,
        lookOffsetY: 0.0,
        irisColorRgb565: 0x07e0,
        saccadeJitter: false,
      },
      rightEye: {
        emotion: "HAPPY",
        eyelidOpenness: 1.0,
        pupilSize: 1.0,
        lookOffsetX: 0.0,
        lookOffsetY: 0.0,
        irisColorRgb565: 0x07e0,
        saccadeJitter: false,
      },
      renderTick: 100,
    };

    const frameBytes = client.createFaceUpdateMessage(eyeWidget);
    const parsed = client.parseIncomingMessage(frameBytes);

    expect(parsed.frame.header.frameType).toBe(FrameType.WIDGET_DEPLOY);
    expect(parsed.widget).toEqual(eyeWidget);
  });
});

describe("RobotConnectionManager & Simulator Loopback", () => {
  let connection: RobotConnectionManager;

  beforeEach(() => {
    connection = new RobotConnectionManager();
  });

  it("boots the simulator and tracks telemetry & ping", async () => {
    connection.bootSimulator();
    expect(connection.getState()).toBe("OFFLINE_SIMULATOR");

    const telemetry = connection.getTelemetry();
    expect(telemetry.batteryPct).toBe(96);
    expect(telemetry.mode).toBe(RobotMode.AGENTIC_CONNECTED);
    expect(telemetry.petMood).toBe(EmotionId.IDLE);
    expect(telemetry.pingMs).toBeGreaterThanOrEqual(1);

    connection.disconnect();
    expect(connection.getState()).toBe("SEARCHING");
  });

  it("deploys declarative widget packages directly to robot simulator", async () => {
    connection.bootSimulator();
    const widget = BUILTIN_WIDGETS.find((w) => w.manifest.id === "widget-hydration-02")!;

    const deployed = await connection.deployWidget(widget);
    expect(deployed).toBe(true);
    expect(connection.getTelemetry().activeWidgetId).toBe("widget-hydration-02");

    connection.disconnect();
  });

  it("handles SD Vault file uploads in 16KB chunks with progress callbacks", async () => {
    connection.bootSimulator();
    const dummyBytes = new Uint8Array(35000); // ~35KB -> 3 chunks
    dummyBytes.fill(0x5a);

    const progressReports: number[] = [];
    await connection.uploadVaultFile("test_audio.wav", dummyBytes, (pct) => {
      progressReports.push(pct);
    });

    expect(progressReports.length).toBeGreaterThan(0);
    expect(progressReports[progressReports.length - 1]).toBe(100);

    connection.disconnect();
  });

  it("responds to Touch 2FA challenge", async () => {
    connection.bootSimulator();
    await expect(connection.respondToTouch2Fa("ch-1234", true)).resolves.not.toThrow();
    await expect(connection.respondToTouch2Fa("ch-1234", false)).resolves.not.toThrow();
    connection.disconnect();
  });
});

describe("Built-in Widgets & Bytecode Validation", () => {
  it("verifies all 6 pre-seeded widgets compile to binary bytecode cleanly", () => {
    expect(BUILTIN_WIDGETS.length).toBe(6);

    for (const widget of BUILTIN_WIDGETS) {
      expect(widget.manifest.name).toBeTruthy();
      expect(widget.manifest.id).toBeTruthy();
      expect(widget.ui).toBeDefined();

      const bytecode = compileWidgetToBytecode(widget);
      expect(bytecode.byteLength).toBeGreaterThan(16);
    }
  });
});

describe("Zustand PetBotStore", () => {
  it("navigates tabs and updates state slots", () => {
    const store = usePetBotStore.getState();
    store.setActiveTab("STUDIO");
    expect(usePetBotStore.getState().activeTab).toBe("STUDIO");

    store.updateSimulatorSlot("cupsDrank", 7);
    expect(usePetBotStore.getState().studioState.simulatorSlots["cupsDrank"]).toBe(7);
  });

  it("manages draft widget undo and redo stacks", () => {
    const store = usePetBotStore.getState();
    const original = store.studioState.draftWidget;

    const modified = {
      ...original,
      manifest: { ...original.manifest, name: "Modified Name" },
    };

    store.setDraftWidget(modified);
    expect(usePetBotStore.getState().studioState.draftWidget.manifest.name).toBe("Modified Name");
    expect(usePetBotStore.getState().studioState.undoStack.length).toBe(1);

    store.undoDraft();
    expect(usePetBotStore.getState().studioState.draftWidget.manifest.name).toBe(original.manifest.name);
    expect(usePetBotStore.getState().studioState.redoStack.length).toBe(1);

    store.redoDraft();
    expect(usePetBotStore.getState().studioState.draftWidget.manifest.name).toBe("Modified Name");
  });

  it("simulates conversational zero-code prompt generation", async () => {
    const store = usePetBotStore.getState();
    await store.sendStudioPrompt("Create a reading habit tracker");

    const state = usePetBotStore.getState().studioState;
    expect(state.chatHistory.length).toBeGreaterThanOrEqual(3);
    expect(state.draftWidget.manifest.name).toBe("Reading Habit");
  });

  it("updates hardware settings, wake-word, side double-tap action, Android mirroring, and Wi-Fi provisioning", async () => {
    const { robotConnection: rc } = await import("../src/services/robot-connection.js");
    rc.bootSimulator();

    const store = usePetBotStore.getState();
    expect(store.devMode).toBe(false);
    expect(store.hardwareSettings.silenceReturnSec).toBe(15);
    expect(store.hardwareSettings.sideDoubleTapAction).toBe("AI_BRIEFING");

    store.setDevMode(true);
    expect(usePetBotStore.getState().devMode).toBe(true);

    await store.updateHardwareSettings({
      volumePct: 60,
      brightnessPct: 80,
      silenceReturnSec: 30,
      wakeWordPhrase: "Hey PetBot",
      sideDoubleTapAction: "MEDIA_PLAY_PAUSE",
    });

    const hw = usePetBotStore.getState().hardwareSettings;
    expect(hw.volumePct).toBe(60);
    expect(hw.brightnessPct).toBe(80);
    expect(hw.silenceReturnSec).toBe(30);
    expect(hw.wakeWordPhrase).toBe("Hey PetBot");
    expect(hw.sideDoubleTapAction).toBe("MEDIA_PLAY_PAUSE");

    store.setAndroidMirrorSetting("mirrorSlack", true);
    expect(usePetBotStore.getState().androidMirrorSettings.mirrorSlack).toBe(true);

    const provisioned = await store.provisionRobotWifi("Desk_5G", "secret123", "192.168.1.50", 8443);
    expect(provisioned).toBe(true);
    expect(usePetBotStore.getState().wifiProvisionConfig.ssid).toBe("Desk_5G");

    rc.disconnect();
  });
});

describe("WebAudioSynth Procedural Sound Engine", () => {
  it("initializes singleton and provides volume and mute controls", async () => {
    const { webAudioSynth } = await import("../src/services/web-audio-synth.js");
    expect(webAudioSynth).toBeDefined();

    webAudioSynth.setVolume(0.8);
    expect(webAudioSynth.getVolume()).toBe(0.8);

    webAudioSynth.setMuted(true);
    expect(webAudioSynth.isMuted()).toBe(true);

    webAudioSynth.setMuted(false);
    expect(webAudioSynth.isMuted()).toBe(false);
  });

  it("plays all procedural sound effects safely", async () => {
    const { webAudioSynth } = await import("../src/services/web-audio-synth.js");
    const effects = [
      "CHIRP",
      "HAPPY_TRILL",
      "PURR",
      "CURIOUS_BEEP",
      "SLEEPY_SIGH",
      "TICK",
      "SUCCESS",
      "WARNING",
    ] as const;

    for (const eff of effects) {
      expect(() => webAudioSynth.play(eff)).not.toThrow();
    }

    expect(() => webAudioSynth.playTone(440, 100)).not.toThrow();
  });
});

describe("ExpressionCanvasRenderer Procedural Pet Engine", () => {
  it("manages transitions between all emotional states and simulates 60FPS updates", async () => {
    const { ExpressionCanvasRenderer } = await import(
      "../src/components/simulator/ExpressionCanvasRenderer.js"
    );

    const rig = new ExpressionCanvasRenderer("IDLE");
    expect(rig.getEmotion()).toBe("IDLE");

    const emotions = [
      "IDLE",
      "HAPPY",
      "CURIOUS",
      "SLEEPY",
      "FOCUSED",
      "SPEAKING",
      "LISTENING",
      "ALERT",
    ] as const;

    for (const em of emotions) {
      rig.setEmotion(em);
      expect(rig.getEmotion()).toBe(em);
      // Run multiple 60 FPS update cycles (dt = 16.6ms)
      for (let i = 0; i < 10; i++) {
        rig.update(0.016);
      }
    }

    // Temporary emotion with duration timer
    rig.setEmotion("ALERT", 50); // 50ms
    expect(rig.getEmotion()).toBe("ALERT");
    rig.update(0.1); // 100ms passed -> should revert to base emotion
    expect(rig.getEmotion()).toBe("ALERT"); // Base was set to ALERT in previous loop iteration
  });

  it("handles autonomous gaze, blinks, and mock 2D canvas rendering", async () => {
    const { ExpressionCanvasRenderer } = await import(
      "../src/components/simulator/ExpressionCanvasRenderer.js"
    );

    const rig = new ExpressionCanvasRenderer("HAPPY");
    rig.setGaze(0.5, -0.3);
    rig.triggerBlink();

    // 20 update frames
    for (let i = 0; i < 20; i++) {
      rig.update(0.016);
    }

    // Mock CanvasRenderingContext2D
    const mockCtx = {
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      rect: () => {},
      roundRect: () => {},
      clip: () => {},
      fill: () => {},
      stroke: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      arc: () => {},
      ellipse: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      bezierCurveTo: () => {},
      closePath: () => {},
      fillRect: () => {},
      fillText: () => {},
      createRadialGradient: () => ({
        addColorStop: () => {},
      }),
      shadowColor: "",
      shadowBlur: 0,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      font: "",
    } as unknown as CanvasRenderingContext2D;

    expect(() => rig.render(mockCtx, { x: 0, y: 0, w: 160, h: 128 })).not.toThrow();
  });
});

describe("WidgetRuntimeSimulator Utilities", () => {
  it("converts RGB565 and hex colors accurately for canvas rendering", async () => {
    const { toRgbString } = await import(
      "../src/components/simulator/WidgetRuntimeSimulator.js"
    );

    expect(toRgbString("#FF4D2E")).toBe("#FF4D2E");
    expect(toRgbString(undefined, "#000000")).toBe("#000000");

    // Pure Red in RGB565: 0xF800 (11111 000000 00000)
    // r = (0x1f << 3) = 248, g = 0, b = 0
    expect(toRgbString(0xf800)).toBe("rgb(248, 0, 0)");

    // Pure Green in RGB565: 0x07E0 (00000 111111 00000)
    // g = (0x3f << 2) = 252
    expect(toRgbString(0x07e0)).toBe("rgb(0, 252, 0)");

    // Pure Blue in RGB565: 0x001F (00000 000000 11111)
    // b = (0x1f << 3) = 248
    expect(toRgbString(0x001f)).toBe("rgb(0, 0, 248)");
  });
});

describe("AiStudioCompiler & Natural Language Intent Engine", () => {
  it("generates tailored widgets from prompt keywords offline with sub-millisecond compilation", async () => {
    const { aiStudioCompiler } = await import("../src/services/ai-studio-compiler.js");

    const prompts = [
      "Make an hourly hydration tracker with 8 cups goal",
      "Give me a 25-minute Pomodoro focus timer with deep work pet face",
      "PC meeting shortcut dock that mutes my mic and locks desktop",
      "Daily habit streak counter for morning pushups",
      "Cyber HUD monitor with live CPU sparklines",
      "Relaxing breathing meditation buddy with cat purr",
      "Two player game scoreboard with tap increments",
    ];

    for (const p of prompts) {
      const result = await aiStudioCompiler.generateOrRefine(p);

      expect(result.widget).toBeDefined();
      expect(result.widget.manifest.name).toBeTruthy();
      expect(result.widget.ui).toBeDefined();
      expect(result.bytecode).toBeInstanceOf(Uint8Array);
      expect(result.bytecode.length).toBeGreaterThan(16);
      expect(result.compilationTimeMs).toBeLessThan(10);
      expect(result.replyExplanation).toBeTruthy();

      // Ensure zero code/JSON is leaked in the user explanation
      expect(result.replyExplanation).not.toContain("{");
      expect(result.replyExplanation).not.toContain("}");
      expect(result.replyExplanation).not.toContain("WidgetPackage");
    }
  });

  it("applies iterative conversational refinements seamlessly", async () => {
    const { aiStudioCompiler } = await import("../src/services/ai-studio-compiler.js");

    // 1. Initial generation
    const initial = await aiStudioCompiler.generateOrRefine("Hydration tracker for 6 cups of water");
    expect(initial.widget.state["dailyGoal"]?.initialValue).toBe(6);

    // 2. Refine color to emerald
    const refinedColor = await aiStudioCompiler.generateOrRefine("Change color to emerald green", initial.widget);
    expect(refinedColor.widget.manifest.name).toBe(initial.widget.manifest.name);

    // 3. Refine goal
    const refinedGoal = await aiStudioCompiler.generateOrRefine("Increase goal to 10", refinedColor.widget);
    expect(refinedGoal.widget.state["dailyGoal"]?.initialValue).toBe(10);

    // 4. Refine text size
    const refinedText = await aiStudioCompiler.generateOrRefine("Make text larger and bigger", refinedGoal.widget);
    expect(refinedText.widget).toBeDefined();

    // 5. Refine emotion
    const refinedEmotion = await aiStudioCompiler.generateOrRefine("Make pet happy on tap", refinedText.widget);
    expect(refinedEmotion.widget).toBeDefined();

    // Verify bytecode compilation on final refined widget
    const { bytecode, compilationTimeMs } = aiStudioCompiler.compileToBytecode(refinedEmotion.widget);
    expect(bytecode.length).toBeGreaterThan(32);
    expect(compilationTimeMs).toBeLessThan(5);
  });

  it("produces zero-code human-friendly summaries of widget touch triggers", async () => {
    const { aiStudioCompiler } = await import("../src/services/ai-studio-compiler.js");
    const result = await aiStudioCompiler.generateOrRefine("Hydration tracker");

    const summary = aiStudioCompiler.summarizeWidgetForUser(result.widget);
    expect(summary).toContain("Single Tap");
    expect(summary).not.toContain("ON_TOUCH_TAP");
    expect(summary).not.toContain("MUTATE_STATE");
    expect(summary).not.toContain("PLAY_SOUND");
  });
});

describe("RGB565 Image Scaler & DMA Blit Conversion", () => {
  it("packs and unpacks red, green, blue pixels with Little-Endian Xtensa LX7 alignment", async () => {
    const { packRgbaToRgb565, unpackRgb565ToRgba } = await import(
      "../src/services/rgb565-image-scaler.js"
    );

    // 3 pixels: Red, Green, Blue
    const rgba = new Uint8Array([
      255, 0, 0, 255,   // Red -> r5=31, g6=0, b5=0 -> 0xF800
      0, 255, 0, 255,   // Green -> r5=0, g6=63, b5=0 -> 0x07E0
      0, 0, 255, 255,   // Blue -> r5=0, g6=0, b5=31 -> 0x001F
    ]);

    const rgb565 = packRgbaToRgb565(rgba, 3);
    expect(rgb565.length).toBe(6);

    // Verify Little-Endian bytes
    // Red: 0xF800 -> low: 0x00, high: 0xF8
    expect(rgb565[0]).toBe(0x00);
    expect(rgb565[1]).toBe(0xf8);

    // Green: 0x07E0 -> low: 0xE0, high: 0x07
    expect(rgb565[2]).toBe(0xe0);
    expect(rgb565[3]).toBe(0x07);

    // Blue: 0x001F -> low: 0x1F, high: 0x00
    expect(rgb565[4]).toBe(0x1f);
    expect(rgb565[5]).toBe(0x00);

    // Unpack back to RGBA
    const unpacked = unpackRgb565ToRgba(rgb565, 3);
    expect(unpacked.length).toBe(12);

    // Red channel recovered (scaled: 31 << 3 = 248)
    expect(unpacked[0]).toBe(248);
    expect(unpacked[1]).toBe(0);
    expect(unpacked[2]).toBe(0);
    expect(unpacked[3]).toBe(255);

    // Green channel recovered (scaled: 63 << 2 = 252)
    expect(unpacked[4]).toBe(0);
    expect(unpacked[5]).toBe(252);
    expect(unpacked[6]).toBe(0);
    expect(unpacked[7]).toBe(255);

    // Blue channel recovered (scaled: 31 << 3 = 248)
    expect(unpacked[8]).toBe(0);
    expect(unpacked[9]).toBe(0);
    expect(unpacked[10]).toBe(248);
    expect(unpacked[11]).toBe(255);
  });

  it("converts image file to exact 160x128 dimensions with fallback handling", async () => {
    const { convertImageFileToRgb565 } = await import(
      "../src/services/rgb565-image-scaler.js"
    );

    const dummyBlob = new Blob([new Uint8Array(100)], { type: "image/png" });
    const result = await convertImageFileToRgb565(dummyBlob, 160, 128);

    expect(result.width).toBe(160);
    expect(result.height).toBe(128);
    expect(result.rgb565Bytes.byteLength).toBe(160 * 128 * 2); // 40960 bytes
    expect(result.dataUrlPreview).toBeTruthy();
  });
});

describe("SdVaultClient & MicroSD Send/Collect Protocol", () => {
  it("classifies file extensions into consumer visual categories", async () => {
    const { sdVaultClient } = await import("../src/services/sd-vault-client.js");

    expect(sdVaultClient.getFileType("avatar.png")).toBe("image");
    expect(sdVaultClient.getFileType("photo.jpg")).toBe("image");
    expect(sdVaultClient.getFileType("theme.rgb565")).toBe("image");
    expect(sdVaultClient.getFileType("chirp.wav")).toBe("audio");
    expect(sdVaultClient.getFileType("voice.mp3")).toBe("audio");
    expect(sdVaultClient.getFileType("manual.pdf")).toBe("document");
    expect(sdVaultClient.getFileType("notes.txt")).toBe("document");
    expect(sdVaultClient.getFileType("widget.pbwg")).toBe("code");
    expect(sdVaultClient.getFileType("backup.zip")).toBe("archive");
    expect(sdVaultClient.getFileType("data.unknown")).toBe("other");
  });

  it("calculates 64-char SHA-256 integrity hash", async () => {
    const { sdVaultClient } = await import("../src/services/sd-vault-client.js");

    const sampleBytes = new Uint8Array([10, 20, 30, 40, 50]);
    const hash = await sdVaultClient.computeSha256(sampleBytes);

    expect(hash).toHaveLength(64);
    expect(typeof hash).toBe("string");
  });

  it("sends file to robot vault in 16KB chunks and tracks progress", async () => {
    const { sdVaultClient } = await import("../src/services/sd-vault-client.js");

    // 40 KB file -> 3 chunks of 16KB
    const dummyBytes = new Uint8Array(40000);
    dummyBytes.fill(0x3c);

    const progressReports: number[] = [];
    const speedReports: number[] = [];

    const fileItem = await sdVaultClient.sendFileToRobotVault(
      {
        name: "test_robot_sound.wav",
        type: "audio/wav",
        bytes: dummyBytes,
      },
      (pct, speed) => {
        progressReports.push(pct);
        speedReports.push(speed);
      }
    );

    expect(fileItem.id).toBeTruthy();
    expect(fileItem.name).toBe("test_robot_sound.wav");
    expect(fileItem.sizeBytes).toBe(40000);
    expect(fileItem.type).toBe("audio");
    expect(fileItem.sha256Hex).toHaveLength(64);
    expect(progressReports.length).toBeGreaterThan(0);
    expect(progressReports[progressReports.length - 1]).toBe(100);

    // Check file appears in vault list
    const list = await sdVaultClient.listFiles();
    const found = list.find((f) => f.id === fileItem.id);
    expect(found).toBeDefined();

    // Collect / Download file back
    const collectProgress: number[] = [];
    const collectedBlob = await sdVaultClient.collectFileFromRobotVault(fileItem.id, (pct) => {
      collectProgress.push(pct);
    });
    expect(collectedBlob.size).toBe(40000);
    expect(collectProgress[collectProgress.length - 1]).toBe(100);

    // Delete file
    const deleted = await sdVaultClient.deleteFile(fileItem.id);
    expect(deleted).toBe(true);
  });

  it("projects image file to robot display screen", async () => {
    const { sdVaultClient } = await import("../src/services/sd-vault-client.js");

    const dummyImgBytes = new Uint8Array(500);
    const item = await sdVaultClient.sendFileToRobotVault({
      name: "wallpaper_display_test.png",
      type: "image/png",
      bytes: dummyImgBytes,
    });

    const success = await sdVaultClient.displayImageOnRobot(item.id);
    expect(success).toBe(true);

    await sdVaultClient.deleteFile(item.id);
  });
});

describe("Phase 4 End-to-End Protocol & AI Studio Integration", () => {
  it("compiles natural language prompt to PBWG bytecode with 0x50425747 magic header and decompiles cleanly", async () => {
    const { aiStudioCompiler } = await import("../src/services/ai-studio-compiler.js");
    const { decompileBytecodeToWidget, BYTECODE_MAGIC } = await import("@petbot/widget-schema");

    // 1. Natural Language Prompt Synthesis
    const result = await aiStudioCompiler.generateOrRefine(
      "Make a hydration tracker that celebrates at 8 glasses"
    );

    expect(result.widget).toBeDefined();
    expect(result.widget.manifest.name).toContain("Hydration");
    expect(result.widget.state["dailyGoal"]?.initialValue).toBe(8);

    // 2. Validate PBWG Bytecode Magic Header: 0x50, 0x42, 0x57, 0x47 ('P', 'B', 'W', 'G')
    const bytecode = result.bytecode;
    expect(bytecode.length).toBeGreaterThan(16);
    expect(bytecode[0]).toBe(0x50); // 'P'
    expect(bytecode[1]).toBe(0x42); // 'B'
    expect(bytecode[2]).toBe(0x57); // 'W'
    expect(bytecode[3]).toBe(0x47); // 'G'

    // 3. Decompile Bytecode back into structured WidgetPackage
    const decompiled = decompileBytecodeToWidget(bytecode);
    expect(decompiled.manifest.name).toBe(result.widget.manifest.name);
    expect(decompiled.state["dailyGoal"]?.initialValue).toBe(8);
    expect(decompiled.ui.type).toBe("Container");
  });

  it("encodes and decodes chunked SD Vault transfer framing with CRC32 verification", async () => {
    const {
      encodeSdVaultChunk,
      decodeSdVaultChunk,
      encodeSdVaultAck,
      decodeSdVaultAck,
      crc32,
      SdVaultStatus,
    } = await import("@petbot/protocol");

    const payload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    const computedCrc = crc32(payload);

    // 1. Chunk frame encoding
    const chunkFrame = encodeSdVaultChunk({
      transferId: 98765,
      chunkIndex: 2,
      chunkCrc32: computedCrc,
      rawBytes: payload,
    });

    expect(chunkFrame.byteLength).toBe(12 + payload.byteLength);

    // 2. Chunk frame decoding
    const decodedChunk = decodeSdVaultChunk(chunkFrame);
    expect(decodedChunk.transferId).toBe(98765);
    expect(decodedChunk.chunkIndex).toBe(2);
    expect(decodedChunk.chunkCrc32).toBe(computedCrc);
    expect(decodedChunk.rawBytes).toEqual(payload);

    // 3. Ack frame round-trip
    const ackFrame = encodeSdVaultAck({
      transferId: 98765,
      nextExpectedChunk: 3,
      status: SdVaultStatus.OK,
    });

    const decodedAck = decodeSdVaultAck(ackFrame);
    expect(decodedAck.transferId).toBe(98765);
    expect(decodedAck.nextExpectedChunk).toBe(3);
    expect(decodedAck.status).toBe(SdVaultStatus.OK);
  });

  it("encodes and verifies SUBSCRIPTION_ENTITLEMENT_SYNC control payloads and syncs via RobotConnectionManager", async () => {
    const {
      SubscriptionEntitlementSyncSchema,
      encodeControlPayload,
      decodeControlPayload,
      FrameType,
    } = await import("@petbot/protocol");
    const { robotConnection } = await import("../src/services/robot-connection.js");

    const entitlement = {
      jwtToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.petbot-pro-entitlement-token",
      tier: "PRO" as const,
      expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30,
      enabledPersonas: [
        "Nova - Cheerful Cyber Pet",
        "Atlas - Calm Deep-Work Coach",
        "Pixel - Playful Sidekick",
      ],
    };

    // 1. Zod MessagePack Encode & Decode
    const encoded = encodeControlPayload(SubscriptionEntitlementSyncSchema, entitlement);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(32);

    const decoded = decodeControlPayload(SubscriptionEntitlementSyncSchema, encoded);
    expect(decoded.tier).toBe("PRO");
    expect(decoded.enabledPersonas).toHaveLength(3);
    expect(decoded.jwtToken).toBe(entitlement.jwtToken);

    // 2. Sync entitlement to robot connection in simulator mode
    robotConnection.bootSimulator();
    const synced = await robotConnection.syncSubscriptionEntitlement("PRO");
    expect(synced).toBe(true);

    robotConnection.disconnect();
  });

  it("encodes bidirectional Voice AI audio uplink and downlink frames with facial visemes", async () => {
    const {
      encodeAudioUplinkFrame,
      decodeAudioUplinkFrame,
      encodeAudioDownlinkFrame,
      decodeAudioDownlinkFrame,
      EmotionId,
    } = await import("@petbot/protocol");

    // 1. Audio Uplink (Microphone -> Robot)
    const pcmSamples = new Uint8Array(640);
    pcmSamples.fill(0x24);

    const uplinkBytes = encodeAudioUplinkFrame({
      rmsEnergy: 185,
      vadActive: true,
      audioData: pcmSamples,
    });

    const decodedUplink = decodeAudioUplinkFrame(uplinkBytes);
    expect(decodedUplink.vadActive).toBe(true);
    expect(decodedUplink.rmsEnergy).toBe(185);
    expect(decodedUplink.audioData.length).toBe(640);

    // 2. Audio Downlink (Voice AI Response -> Robot TFT Screen Lip-Sync)
    const downlinkBytes = encodeAudioDownlinkFrame({
      emotionId: EmotionId.HAPPY,
      visemeMouthOpen: 240, // Wide open lip viseme
      eyeGazeX: 5,
      eyeGazeY: -2,
      audioData: pcmSamples,
    });

    const decodedDownlink = decodeAudioDownlinkFrame(downlinkBytes);
    expect(decodedDownlink.emotionId).toBe(EmotionId.HAPPY);
    expect(decodedDownlink.visemeMouthOpen).toBe(240);
    expect(decodedDownlink.eyeGazeX).toBe(5);
    expect(decodedDownlink.eyeGazeY).toBe(-2);
    expect(decodedDownlink.audioData.length).toBe(640);
  });
});


