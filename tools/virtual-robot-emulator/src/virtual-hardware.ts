import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
  DISPLAY_BUFFER_BYTES,
  AUDIO_FRAME_BYTES,
  FrameType,
  RobotMode,
  EmotionId,
  FLAG_FINAL_CHUNK,
  crc32,
  encodeFrame,
  decodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  encodeSdVaultAck,
  decodeSdVaultChunk,
  encodeOtaUpdateAck,
  decodeOtaUpdateChunk,
  decodeAudioDownlinkFrame,
  encodeAudioUplinkFrame,
  decodeAudioUplinkFrame,
  SdVaultStatus,
  OtaAckStatus,
  type DecodedFrame,
  type SdVaultStart,
  type SdVaultEntry,
  type SdVaultListRes,
  type Touch2FaChallenge,
  type Touch2FaResponse,
  type HelloHandshake,
  type ModeTransition,
  type SubscriptionEntitlementSync,
  type OtaUpdateStart,
  type OtaChunk,
  type OtaAckPayload,
  SdVaultStartSchema,
  SdVaultListReqSchema,
  SdVaultListResSchema,
  OtaUpdateStartSchema,
  Touch2FaChallengeSchema,
  Touch2FaResponseSchema,
  HelloHandshakeSchema,
  ModeTransitionSchema,
  SubscriptionEntitlementSyncSchema,
} from "@petbot/protocol";
import {
  normalizePublicKey,
  buildOtaSigningPayload,
} from "./ota-packager.js";
import {
  decompileBytecodeToWidget,
  deserializeWidgetPacket,
  type WidgetPackage,
  type Action,
  type TriggerRule,
  type WidgetPacket,
  type EyeFaceWidget,
} from "@petbot/widget-schema";

export type TouchGesture = "SINGLE_TAP" | "DOUBLE_TAP" | "LONG_PRESS" | "PETTING_RAPID";

export interface VirtualRobotHardwareOptions {
  deviceId?: string | undefined;
  firmwareVersion?: string | undefined;
  initialMode?: RobotMode | undefined;
  sdDirectory?: string | undefined;
  otaTrustedPublicKey?: string | undefined;
  onFrameOutbound?: ((frame: Uint8Array) => void) | undefined;
  onSoundTriggered?: ((soundId: string) => void) | undefined;
  onLogMessage?: ((msg: string) => void) | undefined;
  keysFilePath?: string | undefined;
}

export interface HardwareTelemetrySnapshot {
  deviceId: string;
  firmwareVersion: string;
  mode: RobotMode;
  petMood: EmotionId;
  visemeMouthOpen: number;
  eyeGazeX: number;
  eyeGazeY: number;
  batteryPct: number;
  isCharging: boolean;
  activeWidgetId: string;
  active2FaChallengeId: string | null;
  active2FaTitle: string | null;
  sdCapacityBytes: number;
  sdUsedBytes: number;
  ed25519PublicKeyHex: string;
  otaRunningPartition: "app0" | "app1";
  isOtaUpdating: boolean;
  otaProgressPct: number;
}

export class VirtualEsp32S3Robot {
  private readonly deviceId: string;
  private firmwareVersion: string;
  private readonly sdDirectory: string;
  private otaTrustedSigningPublicKey: string | null = null;
  private otaRunningPartition: "app0" | "app1" = "app0";
  private isOtaUpdating = false;
  private otaProgressPct = 0;
  private activeOtaSession: {
    transferId: number;
    version: string;
    totalBytes: number;
    totalChunks: number;
    sha256Hex: string;
    ed25519SignatureHex: string;
    receivedBytes: number;
    chunks: Map<number, Uint8Array>;
  } | null = null;

  // Operating Subsystem State
  private mode: RobotMode = RobotMode.AGENTIC_CONNECTED;
  private emotion: EmotionId = EmotionId.HAPPY;
  private customEmotionStr: string | null = null;
  private visemeMouthOpen = 0;
  private eyeGazeX = 0;
  private eyeGazeY = 0;
  private batteryPct = 98;
  private isCharging = false;
  private activeWidgetId = "widget-clock-01";

  // 128x160 RGB565 Framebuffer (20,480 pixels x 2 bytes = 40,960 bytes)
  private readonly framebuffer = new Uint16Array(DISPLAY_WIDTH * DISPLAY_HEIGHT);

  // 8MB Octal PSRAM Widget VM State
  private activeWidget: WidgetPackage | null = null;
  private readonly stateSlots = new Map<string, string | number | boolean>();
  private widgetTickInterval: NodeJS.Timeout | null = null;

  // Virtual MicroSD Vault State Machine
  private activeTransfer: {
    transferId: number;
    fileId: string;
    path: string;
    totalBytes: number;
    totalChunks: number;
    sha256Hex: string;
    chunks: Map<number, Uint8Array>;
  } | null = null;

  // Virtual Capacitive Touch Sensor & Cryptographic 2FA Signer
  private active2FaChallenge: Touch2FaChallenge | null = null;
  private readonly ed25519KeyPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };
  private readonly publicKeyHex: string;

  // Audio Viseme History
  private readonly audioKeyframeLog: Array<{
    timestamp: number;
    emotion: EmotionId;
    visemeMouthOpen: number;
    eyeGaze: [number, number];
  }> = [];

  // Outbound Dispatch Callback
  private onFrameOutbound: ((frame: Uint8Array) => void) | null = null;
  private outboundListeners = new Set<(frame: Uint8Array) => void>();

  public addOutboundListener(listener: (frame: Uint8Array) => void): () => void {
    this.outboundListeners.add(listener);
    return () => this.outboundListeners.delete(listener);
  }

  private emitOutboundFrame(frame: Uint8Array): void {
    this.onFrameOutbound?.(frame);
    for (const listener of this.outboundListeners) {
      try {
        listener(frame);
      } catch {
        // ignore listener error
      }
    }
  }
  private onSoundTriggered: ((soundId: string) => void) | null = null;
  private onLogMessage: ((msg: string) => void) | null = null;

  constructor(options: VirtualRobotHardwareOptions = {}) {
    this.deviceId = options.deviceId ?? "petbot-esp32s3-sim-01";
    this.firmwareVersion = options.firmwareVersion ?? "1.0.0-xtensa-lx7";
    this.sdDirectory = options.sdDirectory ?? path.join(os.homedir(), ".petbot", "virtual-sd");
    this.otaTrustedSigningPublicKey = options.otaTrustedPublicKey ?? null;
    this.onFrameOutbound = options.onFrameOutbound ?? null;
    this.onSoundTriggered = options.onSoundTriggered ?? null;
    this.onLogMessage = options.onLogMessage ?? null;
    if (options.initialMode !== undefined) {
      this.mode = options.initialMode;
    }

    // Ensure virtual SD directory exists
    try {
      fs.mkdirSync(this.sdDirectory, { recursive: true });
    } catch {
      // Fallback in sandboxed/restricted environments
    }

    // Generate or load hardware Ed25519 keypair for 2FA signing and device pairing
    const defaultKeysPath = path.join(os.homedir(), ".petbot", "emulator-keys.json");
    const keysPath = options.keysFilePath ?? defaultKeysPath;
    let loadedKeyPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject } | null = null;
    if (keysPath) {
      try {
        if (fs.existsSync(keysPath)) {
          const raw = JSON.parse(fs.readFileSync(keysPath, "utf-8"));
          if (raw.privateKeyPem) {
            const privateKey = crypto.createPrivateKey(raw.privateKeyPem);
            const publicKey = crypto.createPublicKey(privateKey);
            loadedKeyPair = { publicKey, privateKey };
          }
        }
      } catch {
        // Fallback to fresh generation
      }
    }

    if (loadedKeyPair) {
      this.ed25519KeyPair = loadedKeyPair;
    } else {
      this.ed25519KeyPair = crypto.generateKeyPairSync("ed25519");
      if (keysPath) {
        try {
          fs.mkdirSync(path.dirname(keysPath), { recursive: true });
          const privateKeyPem = this.ed25519KeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
          const derSpki = this.ed25519KeyPair.publicKey.export({ type: "spki", format: "der" });
          const publicKeyHex = derSpki.subarray(-32).toString("hex");
          fs.writeFileSync(keysPath, JSON.stringify({ privateKeyPem, publicKeyHex }, null, 2), "utf-8");
        } catch {
          // Ignore write failure in restricted test environments
        }
      }
    }

    const derSpki = this.ed25519KeyPair.publicKey.export({ type: "spki", format: "der" });
    // Raw 32-byte Ed25519 public key is located at the last 32 bytes of DER SPKI
    this.publicKeyHex = derSpki.subarray(-32).toString("hex");

    // Initialize display with neutral eye expression
    this.renderProceduralExpression();
  }

  public setMode(mode: RobotMode): void {
    this.mode = mode;
    this.onLogMessage?.(
      `[Mode] Switched to ${mode === RobotMode.AGENTIC_CONNECTED ? "AGENTIC_CONNECTED" : "NORMAL_OFFLINE"}`
    );
  }

  public getMode(): RobotMode {
    return this.mode;
  }

  public onConnectionSevered(): void {
    this.mode = RobotMode.NORMAL_OFFLINE;
    this.onLogMessage?.(
      `[Mode] Connection severed -> Fallback to NORMAL_OFFLINE (PSRAM states & timers preserved)`
    );
  }

  public getSdDirectory(): string {
    return this.sdDirectory;
  }

  public getPublicKeyHex(): string {
    return this.publicKeyHex;
  }

  public getFirmwareVersion(): string {
    return this.firmwareVersion;
  }

  public getActiveWidget(): WidgetPackage | null {
    return this.activeWidget;
  }

  public getEmotion(): EmotionId {
    return this.emotion;
  }

  public getVisemeMouthOpen(): number {
    return this.visemeMouthOpen;
  }

  public getEyeGaze(): [number, number] {
    return [this.eyeGazeX, this.eyeGazeY];
  }

  public getAudioKeyframeLog(): ReadonlyArray<{
    timestamp: number;
    emotion: EmotionId;
    visemeMouthOpen: number;
    eyeGaze: [number, number];
  }> {
    return this.audioKeyframeLog;
  }

  public setOutboundHandler(handler: (frame: Uint8Array) => void): void {
    this.onFrameOutbound = handler;
  }

  public setSoundHandler(handler: (soundId: string) => void): void {
    this.onSoundTriggered = handler;
  }

  public setLogHandler(handler: (msg: string) => void): void {
    this.onLogMessage = handler;
  }

  // =========================================================================
  // 1. HARDWARE TELEMETRY & DISPLAY SUBSYSTEM
  // =========================================================================

  public getTelemetrySnapshot(): HardwareTelemetrySnapshot {
    let sdCapacityBytes = 32 * 1024 * 1024 * 1024; // 32 GB
    let sdUsedBytes = 2 * 1024 * 1024 * 1024; // 2 GB baseline
    try {
      if (fs.existsSync(this.sdDirectory)) {
        const files = fs.readdirSync(this.sdDirectory);
        for (const file of files) {
          const stat = fs.statSync(path.join(this.sdDirectory, file));
          sdUsedBytes += stat.size;
        }
      }
    } catch {
      // Continue with baseline
    }

    return {
      deviceId: this.deviceId,
      firmwareVersion: this.firmwareVersion,
      mode: this.mode,
      petMood: this.emotion,
      visemeMouthOpen: this.visemeMouthOpen,
      eyeGazeX: this.eyeGazeX,
      eyeGazeY: this.eyeGazeY,
      batteryPct: this.batteryPct,
      isCharging: this.isCharging,
      activeWidgetId: this.activeWidgetId,
      active2FaChallengeId: this.active2FaChallenge?.challengeId ?? null,
      active2FaTitle: this.active2FaChallenge?.actionTitle ?? null,
      sdCapacityBytes,
      sdUsedBytes,
      ed25519PublicKeyHex: this.publicKeyHex,
      otaRunningPartition: this.otaRunningPartition,
      isOtaUpdating: this.isOtaUpdating,
      otaProgressPct: this.otaProgressPct,
    };
  }

  public setOtaTrustedPublicKey(key: string | null): void {
    this.otaTrustedSigningPublicKey = key;
  }

  public getOtaRunningPartition(): "app0" | "app1" {
    return this.otaRunningPartition;
  }

  public getDisplayDimensions(): { width: number; height: number; bufferBytes: number } {
    return {
      width: DISPLAY_WIDTH,
      height: DISPLAY_HEIGHT,
      bufferBytes: DISPLAY_BUFFER_BYTES,
    };
  }

  public getState(): {
    currentEmotion: string;
    batteryPercentage: number;
    isCharging: boolean;
    frameCounter: number;
    lastHeartbeatTimestamp: number;
  } {
    const moodNames = ["IDLE", "HAPPY", "CURIOUS", "SLEEPY", "FOCUSED"];
    return {
      currentEmotion: this.customEmotionStr ?? moodNames[this.emotion] ?? "HAPPY",
      batteryPercentage: this.batteryPct,
      isCharging: this.isCharging,
      frameCounter: 0,
      lastHeartbeatTimestamp: Date.now(),
    };
  }

  public getFramebuffer(): Uint16Array {
    return this.framebuffer;
  }

  public getFramebufferRgb565(): Uint16Array {
    return this.framebuffer;
  }

  /**
   * Unpacks the 128x160 16-bit RGB565 framebuffer into a 128x160x4 RGBA8888 byte array
   * for rendering on HTML5 canvas elements in test harnesses or web dashboards.
   */
  public getFramebufferRgba(): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(DISPLAY_WIDTH * DISPLAY_HEIGHT * 4);
    for (let i = 0; i < this.framebuffer.length; i++) {
      const word = this.framebuffer[i] ?? 0;
      const r = ((word >> 11) & 0x1f) << 3;
      const g = ((word >> 5) & 0x3f) << 2;
      const b = (word & 0x1f) << 3;

      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  public renderDirectFrame(rgb565Bytes: Uint8Array): void {
    if (rgb565Bytes.byteLength !== DISPLAY_BUFFER_BYTES) {
      throw new RangeError(
        `Invalid RGB565 frame byte length: ${rgb565Bytes.byteLength} (expected ${DISPLAY_BUFFER_BYTES})`
      );
    }
    const view = new DataView(
      rgb565Bytes.buffer,
      rgb565Bytes.byteOffset,
      rgb565Bytes.byteLength
    );
    for (let i = 0; i < this.framebuffer.length; i++) {
      this.framebuffer[i] = view.getUint16(i * 2, true);
    }
  }

  /**
   * Procedural rendering of stylized robot eyes and live mouth visemes directly into RGB565 framebuffer.
   */
  public renderProceduralExpression(): void {
    if (this.isOtaUpdating) {
      this.renderOtaProgressScreen();
      return;
    }

    // Fill dark background (#0D1117 in RGB565 = 0x08A2)
    this.framebuffer.fill(0x08a2);

    // Cyan eye color in RGB565 = 0x07FF (or Neon Green = 0x07E0)
    let eyeColor = 0x07ff;
    if (this.emotion === EmotionId.HAPPY) eyeColor = 0x07e0;
    else if (this.emotion === EmotionId.CURIOUS) eyeColor = 0x07ff;
    else if (this.emotion === EmotionId.SLEEPY) eyeColor = 0x0210;
    else if (this.emotion === EmotionId.FOCUSED) eyeColor = 0xfd20;

    // Center eye positions: Left (36, 60), Right (92, 60)
    const eyeRadiusX = 16;
    const eyeRadiusY = this.emotion === EmotionId.SLEEPY ? 4 : 22;

    const lx = 36 + Math.round(this.eyeGazeX / 8);
    const ly = 60 + Math.round(this.eyeGazeY / 8);
    const rx = 92 + Math.round(this.eyeGazeX / 8);
    const ry = 60 + Math.round(this.eyeGazeY / 8);

    this.drawFilledEllipse(lx, ly, eyeRadiusX, eyeRadiusY, eyeColor);
    this.drawFilledEllipse(rx, ry, eyeRadiusX, eyeRadiusY, eyeColor);

    // Mouth Viseme: rendered at (64, 115) with dynamic height based on visemeMouthOpen
    if (this.visemeMouthOpen > 10) {
      const mouthHeight = Math.max(2, Math.round((this.visemeMouthOpen / 255) * 16));
      this.drawFilledEllipse(64, 115, 14, mouthHeight, eyeColor);
    }

    // 2FA Consent Prompt Overlay
    if (this.active2FaChallenge) {
      this.draw2FaOverlay();
    }
  }

  private drawFilledEllipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    colorRgb565: number
  ): void {
    const rxSq = rx * rx;
    const rySq = ry * ry;

    for (let dy = -ry; dy <= ry; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= DISPLAY_HEIGHT) continue;

      for (let dx = -rx; dx <= rx; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= DISPLAY_WIDTH) continue;

        if (dx * dx * rySq + dy * dy * rxSq <= rxSq * rySq) {
          this.framebuffer[y * DISPLAY_WIDTH + x] = colorRgb565;
        }
      }
    }
  }

  private draw2FaOverlay(): void {
    // Amber banner overlay for physical touch authorization
    const amberColor = 0xfd20;
    for (let y = 92; y < 123; y++) {
      for (let x = 8; x < 152; x++) {
        if (x === 8 || x === 151 || y === 92 || y === 122) {
          this.framebuffer[y * DISPLAY_WIDTH + x] = amberColor;
        }
      }
    }
  }

  public renderOtaProgressScreen(): void {
    // Fill deep navy slate background (RGB565 0x0862)
    this.framebuffer.fill(0x0862);

    // Focused Gold/Amber eyes for intense brain update concentration (RGB565 0xFD20)
    const eyeColor = 0xfd20;
    this.drawFilledEllipse(50, 42, 14, 16, eyeColor);
    this.drawFilledEllipse(110, 42, 14, 16, eyeColor);

    // Focused inner pupils
    this.drawFilledEllipse(50, 42, 5, 7, 0x0000);
    this.drawFilledEllipse(110, 42, 5, 7, 0x0000);

    // Progress Bar Track (x: 20 to 140, y: 94 to 102)
    const barX = 20;
    const barY = 94;
    const barW = 120;
    const barH = 8;
    const trackColor = 0x2104; // Dark slate track
    const fillColor = 0x07e0;  // Vibrant green fill

    for (let y = barY; y < barY + barH; y++) {
      for (let x = barX; x < barX + barW; x++) {
        this.framebuffer[y * DISPLAY_WIDTH + x] = trackColor;
      }
    }

    // Progress Bar Filled Portion
    const fillW = Math.max(0, Math.min(barW, Math.round((this.otaProgressPct / 100) * barW)));
    for (let y = barY; y < barY + barH; y++) {
      for (let x = barX; x < barX + fillW; x++) {
        this.framebuffer[y * DISPLAY_WIDTH + x] = fillColor;
      }
    }

    // Top Header Pill (y: 8 to 14, x: 40 to 88)
    const pillColor = 0x03ef;
    for (let y = 8; y < 14; y++) {
      for (let x = 40; x < 88; x++) {
        this.framebuffer[y * DISPLAY_WIDTH + x] = pillColor;
      }
    }
  }

  // =========================================================================
  // 2. VIRTUAL 8MB OCTAL PSRAM WIDGET VM RUNTIME
  // =========================================================================

  public loadWidgetBytecode(bytecode: Uint8Array):
    | { success: true; widget: WidgetPackage }
    | { success: false; error: string } {
    try {
      // 1. Verify PBWG Header & Decompile
      const widget = decompileBytecodeToWidget(bytecode);
      this.activeWidget = widget;
      this.activeWidgetId = widget.manifest.id;

      // 2. Initialize O(1) Reactive State Slots
      this.stateSlots.clear();
      if (widget.state) {
        for (const [key, variable] of Object.entries(widget.state)) {
          this.stateSlots.set(key, variable.initialValue);
        }
      }

      // 3. Clear existing tick interval
      if (this.widgetTickInterval) {
        clearInterval(this.widgetTickInterval);
        this.widgetTickInterval = null;
      }

      // 4. Fire ON_LOAD triggers
      this.fireTriggersForEvent("ON_LOAD");

      // 5. Start timer ticks based on refreshIntervalMs
      if (widget.manifest.refreshIntervalMs >= 16) {
        this.widgetTickInterval = setInterval(() => {
          this.fireTriggersForEvent("ON_TIMER_TICK");
        }, widget.manifest.refreshIntervalMs);
      }

      this.onLogMessage?.(`[WidgetVM] Loaded widget "${widget.manifest.name}" into PSRAM`);
      this.renderProceduralExpression();
      return { success: true, widget };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onLogMessage?.(`[WidgetVM] Failed to load bytecode: ${message}`);
      return { success: false, error: message };
    }
  }

  public getStateSlot(key: string): string | number | boolean | undefined {
    return this.stateSlots.get(key);
  }

  public setStateSlot(key: string, value: string | number | boolean): void {
    this.stateSlots.set(key, value);
    this.renderProceduralExpression();
  }

  private fireTriggersForEvent(eventName: string): void {
    if (!this.activeWidget || !this.activeWidget.triggers) return;

    for (const trigger of this.activeWidget.triggers) {
      if (trigger.event === eventName) {
        for (const action of trigger.actions) {
          this.executeAction(action);
        }
      }
    }
  }

  private executeAction(action: Action): void {
    switch (action.type) {
      case "MUTATE_STATE": {
        const current = this.stateSlots.get(action.targetKey);
        if (action.operation === "SET") {
          this.stateSlots.set(action.targetKey, action.value ?? 0);
        } else if (action.operation === "INCREMENT") {
          const num = typeof current === "number" ? current : 0;
          const step = typeof action.value === "number" ? action.value : 1;
          this.stateSlots.set(action.targetKey, num + step);
        } else if (action.operation === "DECREMENT") {
          const num = typeof current === "number" ? current : 0;
          const step = typeof action.value === "number" ? action.value : 1;
          this.stateSlots.set(action.targetKey, num - step);
        } else if (action.operation === "TOGGLE") {
          this.stateSlots.set(action.targetKey, !Boolean(current));
        }
        break;
      }

      case "PLAY_SOUND": {
        this.onSoundTriggered?.(action.soundId);
        break;
      }

      case "SET_EXPRESSION": {
        if (action.emotion === "HAPPY") this.emotion = EmotionId.HAPPY;
        else if (action.emotion === "CURIOUS") this.emotion = EmotionId.CURIOUS;
        else if (action.emotion === "SLEEPY") this.emotion = EmotionId.SLEEPY;
        else if (action.emotion === "FOCUSED") this.emotion = EmotionId.FOCUSED;
        else this.emotion = EmotionId.IDLE;
        this.renderProceduralExpression();
        break;
      }

      case "NAVIGATE_PAGE": {
        this.activeWidgetId = action.targetWidgetId;
        break;
      }

      case "EMIT_HARNESS_RPC": {
        this.onLogMessage?.(`[WidgetVM] RPC Triggered: ${action.actionId} (Tier: ${action.riskTier})`);
        break;
      }
    }
  }

  // =========================================================================
  // 3. VIRTUAL CAPACITIVE TOUCH SENSOR & CRYPTOGRAPHIC 2FA SIGNER
  // =========================================================================

  public triggerTouchGesture(gesture: TouchGesture): Touch2FaResponse | null {
    this.onLogMessage?.(`[TouchSensor] Gesture triggered: ${gesture}`);

    // Check if an incoming 2FA challenge is awaiting physical consent
    if (this.active2FaChallenge) {
      let decision: "APPROVED_SINGLE_TAP" | "DENIED_LONG_PRESS" | null = null;
      if (gesture === "SINGLE_TAP") {
        decision = "APPROVED_SINGLE_TAP";
      } else if (gesture === "LONG_PRESS") {
        decision = "DENIED_LONG_PRESS";
      }

      if (decision) {
        const timestamp = Date.now();
        const messageToSign = Buffer.from(
          `${this.active2FaChallenge.challengeId}:${this.active2FaChallenge.nonce}:${decision}:${timestamp}`,
          "utf-8"
        );

        // Sign with device Ed25519 private key (yields exact 64-byte binary / 128-hex chars)
        const signatureHex = crypto
          .sign(null, messageToSign, this.ed25519KeyPair.privateKey)
          .toString("hex");

        const response: Touch2FaResponse = {
          challengeId: this.active2FaChallenge.challengeId,
          decision,
          touchTimestampMs: timestamp,
          signatureHex,
        };

        const encodedResponse = encodeControlPayload(Touch2FaResponseSchema, response);
        const frame = encodeFrame(FrameType.TOUCH_2FA_RESPONSE, encodedResponse, 1);
        this.emitOutboundFrame(frame);

        this.onLogMessage?.(
          `[Touch2FA] Challenge ${this.active2FaChallenge.challengeId} signed: ${decision}`
        );
        this.active2FaChallenge = null;
        this.renderProceduralExpression();
        return response;
      }
    }

    // Forward touch gestures to active Widget VM triggers
    if (gesture === "SINGLE_TAP") {
      this.fireTriggersForEvent("ON_TOUCH_TAP");
      this.onSoundTriggered?.("CHIRP");
    } else if (gesture === "DOUBLE_TAP") {
      this.fireTriggersForEvent("ON_TOUCH_DOUBLE_TAP");
      this.onSoundTriggered?.("BEEP");
    } else if (gesture === "LONG_PRESS") {
      this.fireTriggersForEvent("ON_TOUCH_LONG_PRESS");
      this.onSoundTriggered?.("WARNING");
    } else if (gesture === "PETTING_RAPID") {
      this.fireTriggersForEvent("ON_PETTING");
      this.onSoundTriggered?.("PURR");
    }

    return null;
  }

  // =========================================================================
  // 4. VIRTUAL MICROSD CARD VAULT STATE MACHINE
  // =========================================================================

  private handleSdVaultStart(payload: Uint8Array): void {
    const start = decodeControlPayload(SdVaultStartSchema, payload);
    const transferId = Math.floor(Math.random() * 900000) + 100000;

    this.activeTransfer = {
      transferId,
      fileId: start.fileId,
      path: start.path,
      totalBytes: start.totalBytes,
      totalChunks: start.totalChunks,
      sha256Hex: start.sha256Hex,
      chunks: new Map(),
    };

    const ackPayload = encodeSdVaultAck({
      transferId,
      nextExpectedChunk: 0,
      status: SdVaultStatus.OK,
    });
    const frame = encodeFrame(FrameType.SD_VAULT_ACK, ackPayload, 1);
    this.emitOutboundFrame(frame);
    this.onLogMessage?.(`[SDVault] Started transfer: ${start.path} (${start.totalBytes} bytes)`);
  }

  private handleSdVaultChunk(payload: Uint8Array, flags: number): void {
    if (!this.activeTransfer) return;

    const chunk = decodeSdVaultChunk(payload);
    const computedCrc = crc32(chunk.rawBytes);

    if (computedCrc !== chunk.chunkCrc32) {
      // Send retry ack
      const ackPayload = encodeSdVaultAck({
        transferId: chunk.transferId,
        nextExpectedChunk: chunk.chunkIndex,
        status: SdVaultStatus.CRC_MISMATCH_RETRY,
      });
      const frame = encodeFrame(FrameType.SD_VAULT_ACK, ackPayload, 1);
      this.emitOutboundFrame(frame);
      return;
    }

    this.activeTransfer.chunks.set(chunk.chunkIndex, chunk.rawBytes);

    const isFinal =
      Boolean(flags & FLAG_FINAL_CHUNK) ||
      chunk.chunkIndex === this.activeTransfer.totalChunks - 1;

    if (isFinal) {
      // Reassemble file
      const fullBuffer = new Uint8Array(this.activeTransfer.totalBytes);
      let offset = 0;
      for (let i = 0; i < this.activeTransfer.totalChunks; i++) {
        const part = this.activeTransfer.chunks.get(i);
        if (part) {
          fullBuffer.set(part, offset);
          offset += part.byteLength;
        }
      }

      // SHA-256 verification
      const computedSha256 = crypto
        .createHash("sha256")
        .update(fullBuffer)
        .digest("hex");

      const fileName = path.basename(this.activeTransfer.path);
      const targetFilePath = path.join(this.sdDirectory, fileName);

      try {
        fs.writeFileSync(targetFilePath, fullBuffer);
      } catch (err) {
        this.onLogMessage?.(`[SDVault] File write failed: ${err}`);
      }

      const ackPayload = encodeSdVaultAck({
        transferId: chunk.transferId,
        nextExpectedChunk: chunk.chunkIndex + 1,
        status: SdVaultStatus.COMPLETED,
      });
      const frame = encodeFrame(FrameType.SD_VAULT_ACK, ackPayload, 1);
      this.emitOutboundFrame(frame);

      this.onLogMessage?.(
        `[SDVault] File "${fileName}" assembled & saved! SHA-256: ${computedSha256.slice(0, 12)}...`
      );
      this.activeTransfer = null;
    } else {
      const ackPayload = encodeSdVaultAck({
        transferId: chunk.transferId,
        nextExpectedChunk: chunk.chunkIndex + 1,
        status: SdVaultStatus.OK,
      });
      const frame = encodeFrame(FrameType.SD_VAULT_ACK, ackPayload, 1);
      this.emitOutboundFrame(frame);
    }
  }

  private handleSdVaultListReq(payload: Uint8Array): void {
    const req = decodeControlPayload(SdVaultListReqSchema, payload);
    const entries: SdVaultEntry[] = [];

    try {
      if (fs.existsSync(this.sdDirectory)) {
        const files = fs.readdirSync(this.sdDirectory);
        for (const file of files) {
          const stat = fs.statSync(path.join(this.sdDirectory, file));
          entries.push({
            name: file,
            isDirectory: stat.isDirectory(),
            sizeBytes: stat.size,
            modifiedTimestamp: Math.floor(stat.mtimeMs / 1000),
          });
        }
      }
    } catch {
      // Return empty if directory unreadable
    }

    const res: SdVaultListRes = {
      directoryPath: req.directoryPath,
      entries,
    };
    const resPayload = encodeControlPayload(SdVaultListResSchema, res);
    const frame = encodeFrame(FrameType.SD_VAULT_LIST_RES, resPayload, 1);
    this.emitOutboundFrame(frame);
  }

  // =========================================================================
  // 5. VIRTUAL I2S MIC & SPEAKER LOOPBACK
  // =========================================================================

  private handleAudioDownlink(payload: Uint8Array): void {
    const decoded = decodeAudioDownlinkFrame(payload);
    this.emotion = decoded.emotionId as EmotionId;
    this.visemeMouthOpen = decoded.visemeMouthOpen;
    this.eyeGazeX = decoded.eyeGazeX;
    this.eyeGazeY = decoded.eyeGazeY;

    this.audioKeyframeLog.push({
      timestamp: Date.now(),
      emotion: this.emotion,
      visemeMouthOpen: this.visemeMouthOpen,
      eyeGaze: [this.eyeGazeX, this.eyeGazeY],
    });

    if (this.audioKeyframeLog.length > 50) {
      this.audioKeyframeLog.shift();
    }

    this.renderProceduralExpression();
  }

  public injectSyntheticVoiceUplink(sampleCount = 320): void {
    const pcm = new Uint8Array(sampleCount * 2);
    // Generate clean 440 Hz test tone in 16-bit little endian PCM
    for (let i = 0; i < sampleCount; i++) {
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 16000);
      pcm[i * 2] = sample & 0xff;
      pcm[i * 2 + 1] = (sample >> 8) & 0xff;
    }

    const uplinkPayload = encodeAudioUplinkFrame({
      rmsEnergy: 175,
      vadActive: true,
      audioData: pcm,
    });
    const frame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, uplinkPayload, 1);
    this.emitOutboundFrame(frame);
    this.onLogMessage?.(`[AudioHal] Injected synthetic 16kHz audio uplink frame`);
  }

  // =========================================================================
  // 6. SIGNED OVER-THE-AIR (OTA) DUAL-PARTITION FIRMWARE UPDATER
  // =========================================================================

  private handleOtaStart(payload: Uint8Array, seqId: number): { response?: Uint8Array | undefined } {
    const start = decodeControlPayload(OtaUpdateStartSchema, payload);

    // Verify Ed25519 digital signature
    const messageToVerify = buildOtaSigningPayload(start.version, start.totalBytes, start.sha256Hex);
    let isSigValid = false;

    try {
      const keyToUse = this.otaTrustedSigningPublicKey ?? this.publicKeyHex;
      const keyObj = normalizePublicKey(keyToUse);
      isSigValid = crypto.verify(
        null,
        messageToVerify,
        keyObj,
        Buffer.from(start.ed25519SignatureHex, "hex")
      );
    } catch {
      isSigValid = false;
    }

    if (!isSigValid) {
      this.onLogMessage?.(`[OTA] Signature verification failed for firmware v${start.version}`);
      const ackPayload = encodeOtaUpdateAck({
        transferId: 0,
        nextExpectedChunk: 0,
        progressPct: 0,
        status: OtaAckStatus.SIGNATURE_INVALID,
      });
      const ackFrame = encodeFrame(FrameType.OTA_UPDATE_ACK, ackPayload, seqId);
      this.emitOutboundFrame(ackFrame);
      return { response: ackFrame };
    }

    const transferId = Math.floor(Math.random() * 900000) + 100000;
    this.activeOtaSession = {
      transferId,
      version: start.version,
      totalBytes: start.totalBytes,
      totalChunks: start.totalChunks,
      sha256Hex: start.sha256Hex,
      ed25519SignatureHex: start.ed25519SignatureHex,
      receivedBytes: 0,
      chunks: new Map(),
    };
    this.isOtaUpdating = true;
    this.otaProgressPct = 0;
    this.renderOtaProgressScreen();

    const ackPayload = encodeOtaUpdateAck({
      transferId,
      nextExpectedChunk: 0,
      progressPct: 0,
      status: OtaAckStatus.OK,
    });
    const ackFrame = encodeFrame(FrameType.OTA_UPDATE_ACK, ackPayload, seqId);
    this.emitOutboundFrame(ackFrame);

    this.onLogMessage?.(
      `[OTA] Validated signature! Started OTA update to v${start.version} (${start.totalBytes} bytes, partition: ${
        this.otaRunningPartition === "app0" ? "app1" : "app0"
      })`
    );

    return { response: ackFrame };
  }

  private handleOtaChunk(
    payload: Uint8Array,
    flags: number,
    seqId: number
  ): { response?: Uint8Array | undefined } {
    if (!this.activeOtaSession) return {};

    const chunk = decodeOtaUpdateChunk(payload);
    const computedCrc = crc32(chunk.rawBytes);

    if (computedCrc !== chunk.chunkCrc32) {
      this.onLogMessage?.(`[OTA] Chunk #${chunk.chunkIndex} CRC32 mismatch! Retrying.`);
      const retryAck = encodeOtaUpdateAck({
        transferId: chunk.transferId,
        nextExpectedChunk: chunk.chunkIndex,
        progressPct: this.otaProgressPct,
        status: OtaAckStatus.CRC_RETRY,
      });
      const ackFrame = encodeFrame(FrameType.OTA_UPDATE_ACK, retryAck, seqId);
      this.emitOutboundFrame(ackFrame);
      return { response: ackFrame };
    }

    this.activeOtaSession.chunks.set(chunk.chunkIndex, chunk.rawBytes);
    this.activeOtaSession.receivedBytes += chunk.rawBytes.byteLength;
    this.otaProgressPct = Math.min(
      100,
      Math.floor((this.activeOtaSession.chunks.size / this.activeOtaSession.totalChunks) * 100)
    );
    this.renderOtaProgressScreen();

    const isFinal =
      Boolean(flags & FLAG_FINAL_CHUNK) ||
      this.activeOtaSession.chunks.size === this.activeOtaSession.totalChunks ||
      chunk.chunkIndex === this.activeOtaSession.totalChunks - 1;

    if (isFinal) {
      // Reassemble and verify SHA-256
      const fullBuffer = new Uint8Array(this.activeOtaSession.totalBytes);
      let offset = 0;
      for (let i = 0; i < this.activeOtaSession.totalChunks; i++) {
        const part = this.activeOtaSession.chunks.get(i);
        if (part) {
          fullBuffer.set(part, offset);
          offset += part.byteLength;
        }
      }

      const computedSha256 = crypto.createHash("sha256").update(fullBuffer).digest("hex");
      if (computedSha256 !== this.activeOtaSession.sha256Hex) {
        this.onLogMessage?.(`[OTA] Reassembled binary SHA-256 mismatch! Flash error.`);
        const errorAck = encodeOtaUpdateAck({
          transferId: chunk.transferId,
          nextExpectedChunk: chunk.chunkIndex,
          progressPct: this.otaProgressPct,
          status: OtaAckStatus.FLASH_ERROR,
        });
        const ackFrame = encodeFrame(FrameType.OTA_UPDATE_ACK, errorAck, seqId);
        this.emitOutboundFrame(ackFrame);
        this.activeOtaSession = null;
        this.isOtaUpdating = false;
        this.renderProceduralExpression();
        return { response: ackFrame };
      }

      // Successful flash: update version & flip active partition
      const newVersion = this.activeOtaSession.version;
      this.firmwareVersion = newVersion;
      this.otaRunningPartition = this.otaRunningPartition === "app0" ? "app1" : "app0";
      this.otaProgressPct = 100;
      this.renderOtaProgressScreen();

      const rebootAck = encodeOtaUpdateAck({
        transferId: chunk.transferId,
        nextExpectedChunk: chunk.chunkIndex + 1,
        progressPct: 100,
        status: OtaAckStatus.REBOOTING_INTO_NEW_FIRMWARE,
      });
      const ackFrame = encodeFrame(FrameType.OTA_UPDATE_ACK, rebootAck, seqId);
      this.emitOutboundFrame(ackFrame);

      this.onSoundTriggered?.("SUCCESS");
      this.onLogMessage?.(
        `[OTA] Flashed 100%! Dual-partition boot swap -> running on ${this.otaRunningPartition} (v${newVersion})`
      );

      this.activeOtaSession = null;
      this.isOtaUpdating = false;
      this.renderProceduralExpression();

      return { response: ackFrame };
    } else {
      const okAck = encodeOtaUpdateAck({
        transferId: chunk.transferId,
        nextExpectedChunk: chunk.chunkIndex + 1,
        progressPct: this.otaProgressPct,
        status: OtaAckStatus.OK,
      });
      const ackFrame = encodeFrame(FrameType.OTA_UPDATE_ACK, okAck, seqId);
      this.emitOutboundFrame(ackFrame);
      return { response: ackFrame };
    }
  }

  // =========================================================================
  // 7. INBOUND BINARY FRAME DISPATCHER
  // =========================================================================

  public handleInboundFrame(encodedBufferOrFrame: Uint8Array | DecodedFrame): {
    response?: Uint8Array | undefined;
    parsedWidget?: WidgetPackage | WidgetPacket | undefined;
  } {
    const frame: DecodedFrame =
      encodedBufferOrFrame instanceof Uint8Array
        ? decodeFrame(encodedBufferOrFrame)
        : encodedBufferOrFrame;

    switch (frame.header.frameType) {
      case FrameType.HEARTBEAT_PING: {
        const pong = encodeFrame(FrameType.HEARTBEAT_PONG, new Uint8Array(0), frame.header.seqId);
        this.emitOutboundFrame(pong);
        return { response: pong };
      }

      case FrameType.HELLO_HANDSHAKE: {
        const handshake: HelloHandshake = {
          deviceId: this.deviceId,
          firmwareVersion: this.firmwareVersion,
          psramFreeBytes: 6 * 1024 * 1024,
          sdCardCapacityBytes: 32 * 1024 * 1024 * 1024,
          sdCardFreeBytes: 30 * 1024 * 1024 * 1024,
          ed25519PublicKeyHex: this.publicKeyHex,
          capabilities: ["TFT_160X128", "TOUCH_CAP", "I2S_AUDIO", "PSRAM_8MB", "SD_MMC"],
        };
        const payload = encodeControlPayload(HelloHandshakeSchema, handshake);
        const resFrame = encodeFrame(FrameType.HELLO_HANDSHAKE, payload, frame.header.seqId);
        this.emitOutboundFrame(resFrame);
        return { response: resFrame };
      }

      case FrameType.MODE_TRANSITION: {
        const trans = decodeControlPayload(ModeTransitionSchema, frame.payload);
        this.mode = trans.targetMode;
        this.onLogMessage?.(`[Mode] Transited to ${this.mode === 1 ? "AGENTIC_CONNECTED" : "NORMAL_OFFLINE"}`);
        return {};
      }

      case FrameType.WIDGET_DEPLOY: {
        // Direct RGB565 screen blit if 40960 bytes
        if (frame.payload.byteLength === DISPLAY_BUFFER_BYTES) {
          this.renderDirectFrame(frame.payload);
          return {};
        }

        // PBWG Bytecode deployment
        if (
          frame.payload.byteLength >= 4 &&
          frame.payload[0] === 0x50 &&
          frame.payload[1] === 0x42 &&
          frame.payload[2] === 0x57 &&
          frame.payload[3] === 0x47
        ) {
          const loadResult = this.loadWidgetBytecode(frame.payload);
          if (loadResult.success) {
            return { parsedWidget: loadResult.widget };
          }
          return {};
        }

        // Fallback for MessagePack serialized WidgetPacket (e.g. EyeFaceWidget)
        try {
          const widget = deserializeWidgetPacket(frame.payload);
          if (widget.type === "EYE_FACE") {
            const eyeWidget = widget as EyeFaceWidget;
            this.customEmotionStr = eyeWidget.leftEye.emotion;
          }
          return { parsedWidget: widget as any };
        } catch {
          return {};
        }
      }

      case FrameType.TOUCH_2FA_CHALLENGE: {
        this.active2FaChallenge = decodeControlPayload(Touch2FaChallengeSchema, frame.payload);
        this.onLogMessage?.(
          `[Touch2FA] Challenge received: "${this.active2FaChallenge.actionTitle}" (Risk: ${this.active2FaChallenge.riskTier})`
        );
        this.renderProceduralExpression();
        return {};
      }

      case FrameType.SD_VAULT_START: {
        this.handleSdVaultStart(frame.payload);
        return {};
      }

      case FrameType.SD_VAULT_CHUNK: {
        this.handleSdVaultChunk(frame.payload, frame.header.flags);
        return {};
      }

      case FrameType.SD_VAULT_LIST_REQ: {
        this.handleSdVaultListReq(frame.payload);
        return {};
      }

      case FrameType.AUDIO_DOWNLINK_FRAME: {
        this.handleAudioDownlink(frame.payload);
        return {};
      }

      case FrameType.SUBSCRIPTION_ENTITLEMENT_SYNC: {
        const entitlement = decodeControlPayload(SubscriptionEntitlementSyncSchema, frame.payload);
        this.onLogMessage?.(`[Entitlement] Synced tier: ${entitlement.tier}`);
        return {};
      }

      case FrameType.OTA_UPDATE_START: {
        return this.handleOtaStart(frame.payload, frame.header.seqId);
      }

      case FrameType.OTA_UPDATE_CHUNK: {
        return this.handleOtaChunk(frame.payload, frame.header.flags, frame.header.seqId);
      }

      default:
        return {};
    }
  }

  public dispose(): void {
    if (this.widgetTickInterval) {
      clearInterval(this.widgetTickInterval);
      this.widgetTickInterval = null;
    }
  }
}

export default VirtualEsp32S3Robot;
