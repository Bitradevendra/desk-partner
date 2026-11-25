import {
  FrameType,
  FrameFlags,
  RobotMode,
  EmotionId,
  FLAG_ACK_REQUIRED,
  FLAG_PRIORITY_REALTIME,
  FLAG_FINAL_CHUNK,
  BLE_SERVICE_UUID,
  BLE_CHAR_RX_UUID,
  BLE_CHAR_TX_UUID,
  BLE_MTU_SAFE_BYTES,
  DEFAULT_WS_PORT,
  SD_CHUNK_SIZE_BYTES,
  encodeFrame,
  decodeFrame,
  crc32,
  encodeControlPayload,
  decodeControlPayload,
  encodeSdVaultChunk,
  decodeSdVaultAck,
  decodeOtaUpdateAck,
  type OtaAckPayload,
  OtaAckStatus,
  encodeAudioDownlinkFrame,
  encodeAudioUplinkFrame,
  decodeAudioUplinkFrame,
  type DecodedFrame,
  type SdVaultAck,
  type Touch2FaChallenge,
  type Touch2FaResponse,
  type HarnessRpcReq,
  type HarnessRpcRes,
  type SdVaultListRes,
  type SubscriptionEntitlementSync,
  Touch2FaChallengeSchema,
  Touch2FaResponseSchema,
  SdVaultStartSchema,
  SdVaultListReqSchema,
  SdVaultListResSchema,
  HelloHandshakeSchema,
  ModeTransitionSchema,
  HeartbeatPayloadSchema,
  HarnessRpcReqSchema,
  HarnessRpcResSchema,
  SubscriptionEntitlementSyncSchema,
  FrameStreamParser,
} from "@petbot/protocol";
import {
  compileWidgetToBytecode,
  type WidgetPackage,
} from "@petbot/widget-schema";
import { pcm16ToWavBytes } from "./gemini-voice-client.js";

export type ConnectionState =
  | "SEARCHING"
  | "BLE_FOUND"
  | "AGENTIC_ONLINE"
  | "OFFLINE_SIMULATOR";

export interface RobotTelemetry {
  batteryPct: number;
  rssi: number;
  mode: RobotMode;
  activeWidgetId: string;
  sdUsedBytes: number;
  sdTotalBytes: number;
  pingMs: number;
  petMood: EmotionId;
  isCharging: boolean;
}

export type ConnectionStateListener = (state: ConnectionState) => void;
export type TelemetryListener = (telemetry: RobotTelemetry) => void;
export type SdVaultAckListener = (ack: SdVaultAck) => void;
export type SdVaultListListener = (list: SdVaultListRes) => void;
export type Touch2FaChallengeListener = (challenge: Touch2FaChallenge) => void;
export type HarnessRpcReqListener = (req: HarnessRpcReq) => void;
export type HarnessRpcResListener = (res: HarnessRpcRes) => void;
export type OtaAckListener = (ack: OtaAckPayload) => void;
export type VoiceUtteranceListener = (wavBytes: Uint8Array, pcmBytes: Uint8Array) => void;

/**
 * Unified connection manager handling WebBluetooth, WebSocket, and Local Simulator Loopback.
 */
export class RobotConnectionManager {
  private state: ConnectionState = "SEARCHING";
  private sequenceCounter = 0;
  private parser = new FrameStreamParser();

  // Transports
  private bleDevice: BluetoothDevice | null = null;
  private bleServer: BluetoothRemoteGATTServer | null = null;
  private rxCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private txCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private nativeBlePlugin: any = null;
  private nativeBleMtuPayloadBytes: number = BLE_MTU_SAFE_BYTES;
  private nativeBleRxListener: { remove?: () => Promise<void> } | null = null;
  private nativeBleDiscListener: { remove?: () => Promise<void> } | null = null;
  private nativeWriteChain: Promise<boolean> = Promise.resolve(true);
  private webSocket: WebSocket | null = null;
  private lastConnectionError: string | null = null;

  // Timers
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastPingSentTimestamp = 0;

  // Simulator state
  private isSimulatorMode = false;
  private simulatorPingTimer: ReturnType<typeof setTimeout> | null = null;

  // Telemetry cache (zeroed/offline until real hardware handshake or explicit preview)
  private telemetry: RobotTelemetry = {
    batteryPct: 0,
    rssi: 0,
    mode: RobotMode.NORMAL_OFFLINE,
    activeWidgetId: "widget-pet-face-00",
    sdUsedBytes: 0,
    sdTotalBytes: 0,
    pingMs: 0,
    petMood: EmotionId.IDLE,
    isCharging: false,
  };

  // Event Listeners
  private stateListeners = new Set<ConnectionStateListener>();
  private telemetryListeners = new Set<TelemetryListener>();
  private sdVaultAckListeners = new Set<SdVaultAckListener>();
  private sdVaultListListeners = new Set<SdVaultListListener>();
  private touch2FaChallengeListeners = new Set<Touch2FaChallengeListener>();
  private harnessRpcReqListeners = new Set<HarnessRpcReqListener>();
  private harnessRpcResListeners = new Set<HarnessRpcResListener>();
  private otaAckListeners = new Set<OtaAckListener>();
  private voiceUtteranceListeners = new Set<VoiceUtteranceListener>();
  private uplinkAudioChunks: Uint8Array[] = [];
  private uplinkTotalBytes = 0;

  constructor() {
    this.parser.onFrame((frame) => this.handleInboundFrame(frame));
  }

  // --- Public Listener Registrations ---

  public onConnectionStateChange(listener: ConnectionStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  public onTelemetry(listener: TelemetryListener): () => void {
    this.telemetryListeners.add(listener);
    listener(this.telemetry);
    return () => this.telemetryListeners.delete(listener);
  }

  public onSdVaultAck(listener: SdVaultAckListener): () => void {
    this.sdVaultAckListeners.add(listener);
    return () => this.sdVaultAckListeners.delete(listener);
  }

  public onSdVaultList(listener: SdVaultListListener): () => void {
    this.sdVaultListListeners.add(listener);
    return () => this.sdVaultListListeners.delete(listener);
  }

  public onTouch2FaChallenge(listener: Touch2FaChallengeListener): () => void {
    this.touch2FaChallengeListeners.add(listener);
    return () => this.touch2FaChallengeListeners.delete(listener);
  }

  public onHarnessRpcReq(listener: HarnessRpcReqListener): () => void {
    this.harnessRpcReqListeners.add(listener);
    return () => this.harnessRpcReqListeners.delete(listener);
  }

  public onHarnessRpcRes(listener: HarnessRpcResListener): () => void {
    this.harnessRpcResListeners.add(listener);
    return () => this.harnessRpcResListeners.delete(listener);
  }

  public onOtaAck(listener: OtaAckListener): () => void {
    this.otaAckListeners.add(listener);
    return () => this.otaAckListeners.delete(listener);
  }

  public onVoiceUtterance(listener: VoiceUtteranceListener): () => void {
    this.voiceUtteranceListeners.add(listener);
    return () => this.voiceUtteranceListeners.delete(listener);
  }

  public getState(): ConnectionState {
    return this.state;
  }

  public getTelemetry(): Readonly<RobotTelemetry> {
    return { ...this.telemetry };
  }

  public isConnected(): boolean {
    return (
      this.state === "AGENTIC_ONLINE" ||
      (this.webSocket !== null && this.webSocket.readyState === WebSocket.OPEN) ||
      Boolean(this.rxCharacteristic && this.bleServer?.connected) ||
      Boolean(this.nativeBlePlugin)
    );
  }

  public getLastConnectionError(): string | null {
    return this.lastConnectionError;
  }

  public isSimulatorActive(): boolean {
    return this.isSimulatorMode || this.state === "OFFLINE_SIMULATOR";
  }

  // --- Connection Actions ---

  /**
   * Attempts connection via Bluetooth (native Android BLE bridge or WebBluetooth)
   * first, then local WebSocket.
   * Stays honestly in SEARCHING (disconnected) unless real hardware responds
   * or `preferSimulator` is explicitly requested.
   */
  public async connect(
    preferSimulator = false,
    host = "petbot.local",
    port: number = DEFAULT_WS_PORT
  ): Promise<ConnectionState> {
    if (preferSimulator) {
      this.bootSimulator();
      return this.state;
    }

    // Try Native Android BLE or WebBluetooth if available
    try {
      const bleSuccess = await this.connectBluetooth(false);
      if (bleSuccess) {
        return this.state;
      }
    } catch (err) {
      console.warn("Bluetooth connection skipped or unavailable:", err);
    }

    // Try WebSocket next
    try {
      const wsSuccess = await this.connectWebSocket(host, port);
      if (wsSuccess) {
        return this.state;
      }
    } catch (err) {
      console.warn("Local WebSocket connection unavailable:", err);
    }

    // No physical robot reachable: stay honestly disconnected in SEARCHING state
    this.setState("SEARCHING");
    return this.state;
  }

  private getNativeBlePlugin(): any {
    if (typeof window === "undefined") return null;
    const cap = (window as unknown as {
      Capacitor?: { isPluginAvailable?: (name: string) => boolean; Plugins?: Record<string, any> };
    }).Capacitor;
    if (!cap?.isPluginAvailable?.("PetBotMobileHarness")) {
      return null;
    }
    const plugin = cap.Plugins?.PetBotMobileHarness;
    return plugin && typeof plugin.connectBleDevice === "function" ? plugin : null;
  }

  /**
   * Connects via Capacitor Native Android BLE GATT (on mobile APK) or WebBluetooth (on Chrome).
   */
  public async connectBluetooth(interactive = true): Promise<boolean> {
    this.lastConnectionError = null;
    const nativePlugin = this.getNativeBlePlugin();

    if (nativePlugin) {
      this.setState("SEARCHING");
      try {
        if (interactive && typeof nativePlugin.requestPermission === "function") {
          const permRes = await nativePlugin.requestPermission({ permission: "BLUETOOTH" });
          if (!permRes?.bluetooth) {
            this.lastConnectionError = "Bluetooth permission is required to find Lobo.";
            return false;
          }
        } else if (typeof nativePlugin.checkPermissions === "function") {
          const permCheck = await nativePlugin.checkPermissions();
          if (!permCheck?.bluetooth) {
            this.lastConnectionError = "Tap Scan BLE to allow Nearby Bluetooth access.";
            return false;
          }
        }

        if (this.nativeBleRxListener?.remove) await this.nativeBleRxListener.remove();
        if (this.nativeBleDiscListener?.remove) await this.nativeBleDiscListener.remove();

        if (typeof nativePlugin.addListener === "function") {
          this.nativeBleRxListener = await nativePlugin.addListener(
            "bleRxData",
            (event: { base64?: string }) => {
              if (!event?.base64) return;
              const raw = atob(event.base64);
              const bytes = new Uint8Array(raw.length);
              for (let i = 0; i < raw.length; i++) {
                bytes[i] = raw.charCodeAt(i);
              }
              this.parser.push(bytes);
            }
          );

          this.nativeBleDiscListener = await nativePlugin.addListener("bleDisconnected", () => {
            this.disconnect();
          });
        }

        const res = await nativePlugin.connectBleDevice({ timeoutMs: 8000 });
        if (!res?.connected) {
          this.lastConnectionError =
            res?.error || "No nearby Lobo responded over Bluetooth. Check power & distance.";
          if (this.nativeBleRxListener?.remove) await this.nativeBleRxListener.remove();
          if (this.nativeBleDiscListener?.remove) await this.nativeBleDiscListener.remove();
          this.nativeBleRxListener = null;
          this.nativeBleDiscListener = null;
          this.setState("SEARCHING");
          return false;
        }

        this.nativeBlePlugin = nativePlugin;
        this.nativeBleMtuPayloadBytes =
          typeof res.mtuPayloadBytes === "number"
            ? Math.max(20, Math.min(BLE_MTU_SAFE_BYTES, res.mtuPayloadBytes))
            : 240;
        this.setState("BLE_FOUND");
        await this.performHandshakeAndUpgrade();
        return true;
      } catch (err) {
        this.lastConnectionError =
          err instanceof Error ? err.message : "Failed to connect over Android Bluetooth LE.";
        this.disconnect();
        return false;
      }
    }

    if (typeof navigator === "undefined" || !("bluetooth" in navigator)) {
      this.lastConnectionError = "Bluetooth is unavailable in this browser environment.";
      return false;
    }

    if (!interactive) {
      // Browser WebBluetooth requires an explicit user gesture to open chooser
      return false;
    }

    this.setState("SEARCHING");

    try {
      this.bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE_SERVICE_UUID] }],
        optionalServices: [BLE_SERVICE_UUID],
      });

      if (!this.bleDevice.gatt) {
        this.lastConnectionError = "Selected device has no GATT server.";
        return false;
      }

      this.setState("BLE_FOUND");
      this.bleServer = await this.bleDevice.gatt.connect();

      const service = await this.bleServer.getPrimaryService(BLE_SERVICE_UUID);
      this.rxCharacteristic = await service.getCharacteristic(BLE_CHAR_RX_UUID);
      this.txCharacteristic = await service.getCharacteristic(BLE_CHAR_TX_UUID);

      await this.txCharacteristic.startNotifications();
      this.txCharacteristic.addEventListener(
        "characteristicvaluechanged",
        (event: Event) => {
          const char = event.target as BluetoothRemoteGATTCharacteristic;
          if (char.value) {
            const bytes = new Uint8Array(char.value.buffer, char.value.byteOffset, char.value.byteLength);
            this.parser.push(bytes);
          }
        }
      );

      this.bleDevice.addEventListener("gattserverdisconnected", () => {
        this.disconnect();
      });

      await this.performHandshakeAndUpgrade();
      return true;
    } catch (err) {
      this.lastConnectionError =
        err instanceof Error ? err.message : "Bluetooth pairing canceled or failed.";
      this.disconnect();
      return false;
    }
  }

  /**
   * Connects to local mDNS / LAN WebSocket server.
   */
  public async connectWebSocket(host = "petbot.local", port: number = DEFAULT_WS_PORT): Promise<boolean> {
    this.setState("SEARCHING");

    return new Promise((resolve) => {
      try {
        const wsUrl = `ws://${host}:${port}/ws`;
        this.webSocket = new WebSocket(wsUrl);
        this.webSocket.binaryType = "arraybuffer";

        const timeout = setTimeout(() => {
          if (this.webSocket && this.webSocket.readyState !== WebSocket.OPEN) {
            this.webSocket.close();
            resolve(false);
          }
        }, 2500);

        this.webSocket.onopen = async () => {
          clearTimeout(timeout);
          await this.performHandshakeAndUpgrade();
          resolve(true);
        };

        this.webSocket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
          if (event.data instanceof ArrayBuffer) {
            this.parser.push(new Uint8Array(event.data));
          }
        };

        this.webSocket.onclose = () => {
          clearTimeout(timeout);
          if (this.state === "AGENTIC_ONLINE") {
            this.disconnect();
          }
        };

        this.webSocket.onerror = () => {
          clearTimeout(timeout);
          resolve(false);
        };
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Boots the offline loopback simulator for instant previewing without hardware.
   */
  public bootSimulator(): void {
    this.disconnect();
    this.isSimulatorMode = true;
    this.setState("OFFLINE_SIMULATOR");

    this.telemetry = {
      batteryPct: 96,
      rssi: -42,
      mode: RobotMode.AGENTIC_CONNECTED,
      activeWidgetId: "widget-pet-face-00",
      sdUsedBytes: 4294967296, // 4 GB
      sdTotalBytes: 32000000000, // 32 GB
      pingMs: 1,
      petMood: EmotionId.IDLE,
      isCharging: false,
    };
    this.notifyTelemetry();
    this.startHeartbeatTimer();
  }

  public disconnect(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.simulatorPingTimer) {
      clearTimeout(this.simulatorPingTimer);
      this.simulatorPingTimer = null;
    }

    if (this.webSocket) {
      try {
        this.webSocket.close();
      } catch {
        // ignore
      }
      this.webSocket = null;
    }

    if (this.bleServer && this.bleServer.connected) {
      try {
        this.bleServer.disconnect();
      } catch {
        // ignore
      }
      this.bleServer = null;
    }

    if (this.nativeBlePlugin) {
      try {
        if (this.nativeBleRxListener?.remove) void this.nativeBleRxListener.remove();
        if (this.nativeBleDiscListener?.remove) void this.nativeBleDiscListener.remove();
        void this.nativeBlePlugin.disconnectBle?.();
      } catch {
        // ignore
      }
      this.nativeBlePlugin = null;
      this.nativeBleRxListener = null;
      this.nativeBleDiscListener = null;
      this.nativeWriteChain = Promise.resolve(true);
    }

    this.bleDevice = null;
    this.rxCharacteristic = null;
    this.txCharacteristic = null;
    this.isSimulatorMode = false;
    this.parser.reset();

    this.telemetry = {
      batteryPct: 0,
      rssi: 0,
      mode: RobotMode.NORMAL_OFFLINE,
      activeWidgetId: this.telemetry.activeWidgetId,
      sdUsedBytes: 0,
      sdTotalBytes: 0,
      pingMs: 0,
      petMood: EmotionId.IDLE,
      isCharging: false,
    };
    this.notifyTelemetry();

    this.setState("SEARCHING");
  }

  // --- Handshake & Protocol Pipeline ---

  private async performHandshakeAndUpgrade(): Promise<void> {
    // 1. Send HELLO_HANDSHAKE
    const handshake = {
      deviceId: "companion-client-web",
      firmwareVersion: "1.0.0-companion",
      psramFreeBytes: 0,
      sdCardCapacityBytes: 0,
      sdCardFreeBytes: 0,
      ed25519PublicKeyHex: "0".repeat(64),
      capabilities: ["COMPANION_STUDIO", "TOUCH_2FA", "SD_VAULT_DOCK"],
    };
    const handshakeBytes = encodeControlPayload(HelloHandshakeSchema, handshake);
    await this.sendRawFrame(FrameType.HELLO_HANDSHAKE, handshakeBytes, FLAG_ACK_REQUIRED);

    // 2. Transition Robot to AGENTIC_CONNECTED
    const transition = {
      targetMode: RobotMode.AGENTIC_CONNECTED,
      companionHost: "companion.local",
      companionPort: 5173,
      transitionReason: "Companion app active session initialized",
    };
    const transitionBytes = encodeControlPayload(ModeTransitionSchema, transition);
    await this.sendRawFrame(FrameType.MODE_TRANSITION, transitionBytes, FLAG_ACK_REQUIRED);

    this.setState("AGENTIC_ONLINE");
    this.startHeartbeatTimer();
  }

  private startHeartbeatTimer(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    this.heartbeatInterval = setInterval(async () => {
      if (this.state !== "AGENTIC_ONLINE" && this.state !== "OFFLINE_SIMULATOR") {
        return;
      }

      this.lastPingSentTimestamp = performance.now();

      if (this.isSimulatorMode) {
        // Simulated zero-jitter latency (1-3 ms)
        this.simulatorPingTimer = setTimeout(() => {
          const latency = Math.max(1, Math.round(performance.now() - this.lastPingSentTimestamp));
          this.telemetry.pingMs = latency;
          this.notifyTelemetry();
        }, 2);
        return;
      }

      const pingPayload = {
        timestampUs: Math.round(performance.now() * 1000),
        batteryPercent: this.telemetry.batteryPct,
        wifiRssi: this.telemetry.rssi,
      };
      const pingBytes = encodeControlPayload(HeartbeatPayloadSchema, pingPayload);
      await this.sendRawFrame(FrameType.HEARTBEAT_PING, pingBytes, FLAG_PRIORITY_REALTIME);
    }, 3000);
  }

  // --- Inbound Frame Dispatcher ---

  private handleInboundFrame(frame: DecodedFrame): void {
    switch (frame.header.frameType) {
      case FrameType.HEARTBEAT_PONG: {
        const rtt = Math.max(1, Math.round(performance.now() - this.lastPingSentTimestamp));
        this.telemetry.pingMs = rtt;
        if (frame.payload.byteLength >= 4) {
          try {
            const pong = decodeControlPayload(HeartbeatPayloadSchema, frame.payload);
            this.telemetry.batteryPct = pong.batteryPercent;
            this.telemetry.rssi = pong.wifiRssi;
          } catch {
            // Heartbeat pong without extended payload
          }
        }
        this.notifyTelemetry();
        break;
      }

      case FrameType.TOUCH_2FA_CHALLENGE: {
        try {
          const challenge = decodeControlPayload(Touch2FaChallengeSchema, frame.payload);
          for (const listener of this.touch2FaChallengeListeners) {
            listener(challenge);
          }
        } catch (err) {
          console.error("Failed to decode Touch 2FA Challenge:", err);
        }
        break;
      }

      case FrameType.SD_VAULT_ACK: {
        try {
          const ack = decodeSdVaultAck(frame.payload);
          for (const listener of this.sdVaultAckListeners) {
            listener(ack);
          }
        } catch (err) {
          console.error("Failed to decode SD Vault Ack:", err);
        }
        break;
      }

      case FrameType.SD_VAULT_LIST_RES: {
        try {
          const list = decodeControlPayload(SdVaultListResSchema, frame.payload);
          for (const listener of this.sdVaultListListeners) {
            listener(list);
          }
        } catch (err) {
          console.error("Failed to decode SD Vault List Res:", err);
        }
        break;
      }

      case FrameType.HARNESS_RPC_REQ: {
        try {
          const rpcReq = decodeControlPayload(HarnessRpcReqSchema, frame.payload);
          for (const listener of this.harnessRpcReqListeners) {
            listener(rpcReq);
          }
        } catch (err) {
          console.error("Failed to decode Harness RPC Req:", err);
        }
        break;
      }

      case FrameType.HARNESS_RPC_RES: {
        try {
          const rpcRes = decodeControlPayload(HarnessRpcResSchema, frame.payload);
          for (const listener of this.harnessRpcResListeners) {
            listener(rpcRes);
          }
        } catch (err) {
          console.error("Failed to decode Harness RPC Res:", err);
        }
        break;
      }

      case FrameType.OTA_UPDATE_ACK: {
        try {
          const ack = decodeOtaUpdateAck(frame.payload);
          for (const listener of this.otaAckListeners) {
            listener(ack);
          }
        } catch (err) {
          console.error("Failed to decode OTA Update Ack:", err);
        }
        break;
      }

      case FrameType.AUDIO_UPLINK_FRAME: {
        try {
          const uplink = decodeAudioUplinkFrame(frame.payload);
          if (uplink.audioData.byteLength > 0) {
            if (this.uplinkTotalBytes + uplink.audioData.byteLength <= 192000) {
              this.uplinkAudioChunks.push(new Uint8Array(uplink.audioData));
              this.uplinkTotalBytes += uplink.audioData.byteLength;
            }
          } else if (!uplink.header.vadActive && this.uplinkTotalBytes > 0) {
            const pcm = new Uint8Array(this.uplinkTotalBytes);
            let offset = 0;
            for (const c of this.uplinkAudioChunks) {
              pcm.set(c, offset);
              offset += c.byteLength;
            }
            this.uplinkAudioChunks = [];
            this.uplinkTotalBytes = 0;
            const wav = pcm16ToWavBytes(pcm, 16000);
            for (const listener of this.voiceUtteranceListeners) {
              listener(wav, pcm);
            }
          }
        } catch (err) {
          console.error("Failed to decode Audio Uplink Frame:", err);
        }
        break;
      }

      default:
        break;
    }
  }

  // --- High-Level Consumer Actions ---

  /**
   * Deploys a compiled declarative widget package to the robot's PSRAM/SD.
   */
  public async deployWidget(widget: WidgetPackage): Promise<boolean> {
    const bytecode = compileWidgetToBytecode(widget);
    const success = await this.sendRawFrame(
      FrameType.WIDGET_DEPLOY,
      bytecode,
      FLAG_ACK_REQUIRED | FLAG_PRIORITY_REALTIME
    );

    if (this.isSimulatorMode) {
      this.telemetry.activeWidgetId = widget.manifest.id;
      this.notifyTelemetry();
    }
    return success;
  }

  /**
   * Sends user decision for an incoming Touch 2FA challenge.
   */
  public async respondToTouch2Fa(challengeId: string, approved: boolean): Promise<void> {
    const response: Touch2FaResponse = {
      challengeId,
      decision: approved ? "APPROVED_SINGLE_TAP" : "DENIED_LONG_PRESS",
      touchTimestampMs: Date.now(),
      signatureHex: "fa".repeat(64), // Simulated hardware-signed HMAC response
    };
    const payload = encodeControlPayload(Touch2FaResponseSchema, response);
    await this.sendRawFrame(FrameType.TOUCH_2FA_RESPONSE, payload, FLAG_PRIORITY_REALTIME);
  }

  /**
   * Requests a mode transition on the robot (Offline Standalone vs Agentic Connected).
   */
  public async requestModeTransition(
    targetMode: RobotMode,
    reason = "User Companion UI toggle"
  ): Promise<boolean> {
    const payload = encodeControlPayload(ModeTransitionSchema, {
      targetMode,
      companionHost: "127.0.0.1",
      companionPort: DEFAULT_WS_PORT,
      transitionReason: reason,
    });
    const success = await this.sendRawFrame(FrameType.MODE_TRANSITION, payload, FLAG_ACK_REQUIRED);
    if (this.isSimulatorMode) {
      this.telemetry.mode = targetMode;
      this.notifyTelemetry();
    }
    return success;
  }

  /**
   * Syncs signed subscription entitlement to unlock real-time Voice AI and cloud personas.
   */
  public async syncSubscriptionEntitlement(
    tier: "FREE" | "PRO" | "ULTRA_AI",
    personas?: string[]
  ): Promise<boolean> {
    const entitlement: SubscriptionEntitlementSync = {
      jwtToken: `mock-petbot-${tier.toLowerCase()}-jwt-${Date.now()}`,
      tier,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
      enabledPersonas: personas ?? [
        "Nova - Cheerful Cyber Pet",
        "Atlas - Calm Deep-Work Coach",
        "Pixel - Playful Sidekick",
      ],
    };
    const payload = encodeControlPayload(SubscriptionEntitlementSyncSchema, entitlement);
    return await this.sendRawFrame(
      FrameType.SUBSCRIPTION_ENTITLEMENT_SYNC,
      payload,
      FLAG_ACK_REQUIRED | FLAG_PRIORITY_REALTIME
    );
  }

  /**
   * Streams 16kHz 16-bit mono PCM speech bytes back to ESP32-S3 PSRAM jitter buffer
   * in fast 50ms packets with RMS-synced mouth viseme animation.
   */
  public async streamAudioResponsePcm(
    pcm16Bytes: Uint8Array,
    emotionId: EmotionId = EmotionId.SPEAKING
  ): Promise<boolean> {
    if (pcm16Bytes.byteLength === 0) return false;
    const alignedLen = pcm16Bytes.byteLength - (pcm16Bytes.byteLength % 2);
    const packetBytes = 1600; // 50ms @ 16kHz PCM16 for fast transfer
    let allSent = true;

    for (let offset = 0; offset < alignedLen; offset += packetBytes) {
      const end = Math.min(offset + packetBytes, alignedLen);
      const slice = pcm16Bytes.subarray(offset, end);

      let sumSq = 0;
      const samplesCount = slice.byteLength >> 1;
      for (let s = 0; s < samplesCount; s++) {
        const lo = slice[s * 2]!;
        const hi = slice[s * 2 + 1]!;
        let val = (hi << 8) | lo;
        if (val >= 0x8000) val -= 0x10000;
        sumSq += val * val;
      }
      const rms = samplesCount > 0 ? Math.sqrt(sumSq / samplesCount) : 0;
      const mouthOpen = Math.min(255, Math.round(rms / 35));

      const downlink = encodeAudioDownlinkFrame({
        emotionId,
        visemeMouthOpen: mouthOpen,
        eyeGazeX: 0,
        eyeGazeY: 0,
        audioData: slice,
      });

      const ok = await this.sendRawFrame(
        FrameType.AUDIO_DOWNLINK_FRAME,
        downlink,
        FLAG_PRIORITY_REALTIME
      );
      if (!ok) {
        allSent = false;
        break;
      }
    }

    return allSent;
  }

  /**
   * Streams audio uplink frame with VAD and RMS energy.
   */
  public async streamAudioUplink(
    audioData: Uint8Array,
    rmsEnergy = 120,
    vadActive = true
  ): Promise<boolean> {
    const uplink = encodeAudioUplinkFrame({
      rmsEnergy,
      vadActive,
      audioData,
    });
    return await this.sendRawFrame(FrameType.AUDIO_UPLINK_FRAME, uplink, FLAG_PRIORITY_REALTIME);
  }

  /**
   * Requests SD card directory listing.
   */
  public async requestVaultList(directoryPath = "/sdcard"): Promise<void> {
    if (this.isSimulatorMode) {
      // Return simulated SD card files
      const mockList: SdVaultListRes = {
        directoryPath,
        entries: [
          { name: "cat_wallpaper.rgb565", isDirectory: false, sizeBytes: 40960, modifiedTimestamp: 1731667000 },
          { name: "voice_synth_v2.bin", isDirectory: false, sizeBytes: 1048576, modifiedTimestamp: 1731668000 },
          { name: "hydration_tracker.pbwg", isDirectory: false, sizeBytes: 1248, modifiedTimestamp: 1731669000 },
          { name: "photos", isDirectory: true, sizeBytes: 0, modifiedTimestamp: 1731660000 },
        ],
      };
      for (const listener of this.sdVaultListListeners) {
        listener(mockList);
      }
      return;
    }

    const payload = encodeControlPayload(SdVaultListReqSchema, { directoryPath });
    await this.sendRawFrame(FrameType.SD_VAULT_LIST_REQ, payload);
  }

  /**
   * Transfers a file to the robot in 16KB binary chunks with CRC checks.
   */
  public async uploadVaultFile(
    fileName: string,
    fileBytes: Uint8Array,
    onProgress?: (progressPct: number) => void
  ): Promise<void> {
    const totalBytes = fileBytes.byteLength;
    const chunkSize = SD_CHUNK_SIZE_BYTES;
    const totalChunks = Math.ceil(totalBytes / chunkSize);
    const transferId = Math.floor(Math.random() * 1000000) + 1;

    // Send SD_VAULT_START
    const startPayload = {
      fileId: `file-${Date.now()}`,
      path: `/sdcard/${fileName}`,
      totalBytes,
      totalChunks,
      sha256Hex: "0".repeat(64),
      direction: "PUSH_TO_ROBOT" as const,
    };
    const startBytes = encodeControlPayload(SdVaultStartSchema, startPayload);
    await this.sendRawFrame(FrameType.SD_VAULT_START, startBytes, FLAG_ACK_REQUIRED);

    // Stream 16KB chunks
    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const start = chunkIdx * chunkSize;
      const end = Math.min(start + chunkSize, totalBytes);
      const rawChunk = fileBytes.subarray(start, end);
      const chunkCrc = crc32(rawChunk);

      const packedChunk = encodeSdVaultChunk({
        transferId,
        chunkIndex: chunkIdx,
        chunkCrc32: chunkCrc,
        rawBytes: rawChunk,
      });

      const flags = chunkIdx === totalChunks - 1 ? FLAG_FINAL_CHUNK : 0;
      await this.sendRawFrame(FrameType.SD_VAULT_CHUNK, packedChunk, flags);

      if (onProgress) {
        const pct = Math.round(((chunkIdx + 1) / totalChunks) * 100);
        onProgress(pct);
      }

      // Small throttle for BLE MTU flow control
      if (!this.isSimulatorMode) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    if (this.isSimulatorMode) {
      this.telemetry.sdUsedBytes += totalBytes;
      this.notifyTelemetry();
    }
  }

  /**
   * Interactively wakes or pets the robot, triggering emotional audio/visual keyframe.
   */
  public async wakeOrPetRobot(): Promise<boolean> {
    const dummyAudio = new Uint8Array(640); // 20ms @ 16kHz
    const downlink = encodeAudioDownlinkFrame({
      emotionId: EmotionId.HAPPY,
      visemeMouthOpen: 240,
      eyeGazeX: 0,
      eyeGazeY: 10,
      audioData: dummyAudio,
    });

    const sent = await this.sendRawFrame(
      FrameType.AUDIO_DOWNLINK_FRAME,
      downlink,
      FLAG_PRIORITY_REALTIME
    );

    if (sent || this.isSimulatorMode) {
      this.telemetry.petMood = EmotionId.HAPPY;
      this.notifyTelemetry();
    }

    return sent;
  }

  /**
   * Dispatches a Harness RPC Request (e.g. TASK_PROGRESS_HUD to robot 1.8" TFT).
   */
  public async sendHarnessRpcRequest(req: HarnessRpcReq): Promise<boolean> {
    const payload = encodeControlPayload(HarnessRpcReqSchema, req);
    return this.sendRawFrame(FrameType.HARNESS_RPC_REQ, payload);
  }

  /**
   * Dispatches a Harness RPC Response back to the robot.
   */
  public async sendHarnessRpcResponse(res: HarnessRpcRes): Promise<boolean> {
    const payload = encodeControlPayload(HarnessRpcResSchema, res);
    return this.sendRawFrame(FrameType.HARNESS_RPC_RES, payload);
  }

  // --- Low-level Raw Frame Dispatch ---

  public async sendRawFrame(frameType: FrameType, payload: Uint8Array, flags = 0): Promise<boolean> {
    const seq = ++this.sequenceCounter & 0xffff;
    const frame = encodeFrame(frameType, payload, seq, flags);

    if (this.isSimulatorMode) {
      return true;
    }

    if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(frame);
      return true;
    }

    if (this.nativeBlePlugin) {
      const nextWrite = this.nativeWriteChain.then(async () => {
        if (!this.nativeBlePlugin) return false;
        try {
          const chunkSize = this.nativeBleMtuPayloadBytes;
          for (let i = 0; i < frame.byteLength; i += chunkSize) {
            const slice = frame.subarray(i, Math.min(i + chunkSize, frame.byteLength));
            let bin = "";
            for (let j = 0; j < slice.length; j++) {
              bin += String.fromCharCode(slice[j]!);
            }
            const res = await this.nativeBlePlugin.writeBleRx({ base64: btoa(bin) });
            if (!res?.success) return false;
          }
          return true;
        } catch {
          return false;
        }
      });
      this.nativeWriteChain = nextWrite;
      return nextWrite;
    }

    if (this.rxCharacteristic) {
      try {
        // BLE MTU safe fragmentation
        for (let i = 0; i < frame.byteLength; i += BLE_MTU_SAFE_BYTES) {
          const slice = frame.subarray(i, Math.min(i + BLE_MTU_SAFE_BYTES, frame.byteLength));
          await this.rxCharacteristic.writeValueWithoutResponse(new Uint8Array(slice));
        }
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      for (const listener of this.stateListeners) {
        listener(state);
      }
    }
  }

  private notifyTelemetry(): void {
    for (const listener of this.telemetryListeners) {
      listener({ ...this.telemetry });
    }
  }
}

// Global Singleton Instance
export const robotConnection = new RobotConnectionManager();
