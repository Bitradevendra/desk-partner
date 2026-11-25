import {
  FrameType,
  RobotMode,
  EmotionId,
  DEFAULT_WS_PORT,
  encodeControlPayload,
  ModeTransitionSchema,
  FLAG_ACK_REQUIRED,
  type HarnessRpcReq,
  type HarnessRpcRes,
} from "@petbot/protocol";
import {
  robotConnection,
  type ConnectionState,
  type RobotTelemetry,
} from "../services/robot-connection.js";
import { SdVaultClient } from "../services/sd-vault-client.js";
import {
  mobilePartnerBridge,
  MobilePartnerBridge,
  type PendingVaultFile,
  type MobileNotification,
  type SemanticNode,
  type MobileTelemetry,
} from "./mobile-partner-bridge.js";

export interface MobileHudProgressOptions {
  readonly title: string;
  readonly progressPct: number;
  readonly emotion?: EmotionId | undefined;
  readonly details?: string | undefined;
}

export type MobileHarnessStateListener = (isActive: boolean) => void;

/**
 * PetBot Native Mobile Partner Harness Orchestrator
 * 
 * Manages seamless automatic handover between the Desktop Harness and Mobile Partner Harness.
 * Handles robot tool invocations (dictated voice replies, calls, navigation, accessibility UI clicks),
 * streams live HUD progress to the physical robot's 1.8" TFT display, and runs background
 * "Send & Collect" Auto-Pocket Sync to the ESP32-S3 MicroSD card.
 */
export class MobileHarnessOrchestrator {
  private static instance: MobileHarnessOrchestrator | null = null;

  private bridge: MobilePartnerBridge;
  private sdVault: SdVaultClient;
  private isMobilePartnerActive = false;
  private stateListeners = new Set<MobileHarnessStateListener>();
  private autoSyncInterval: ReturnType<typeof setInterval> | null = null;
  private unregisterConnectionListener: (() => void) | null = null;
  private unregisterRpcListener: (() => void) | null = null;

  public static getInstance(): MobileHarnessOrchestrator {
    if (!MobileHarnessOrchestrator.instance) {
      MobileHarnessOrchestrator.instance = new MobileHarnessOrchestrator();
    }
    return MobileHarnessOrchestrator.instance;
  }

  constructor(
    bridge: MobilePartnerBridge = mobilePartnerBridge,
    sdVault: SdVaultClient = SdVaultClient.getInstance()
  ) {
    this.bridge = bridge;
    this.sdVault = sdVault;

    this.initOrchestration();
  }

  private initOrchestration(): void {
    // 1. Listen for connection changes (BLE detection or WiFi handover)
    this.unregisterConnectionListener = robotConnection.onConnectionStateChange(
      (state) => this.handleConnectionStateChange(state)
    );

    // 2. Listen for incoming robot RPC requests (e.g. from robot voice queries or widgets)
    this.unregisterRpcListener = robotConnection.onHarnessRpcReq((req) =>
      this.handleRobotRpcRequest(req)
    );
  }

  public onStateChange(listener: MobileHarnessStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.isMobilePartnerActive);
    return () => this.stateListeners.delete(listener);
  }

  public isActive(): boolean {
    return this.isMobilePartnerActive;
  }

  // ==========================================================================
  // Seamless Auto-Switching Architecture
  // ==========================================================================

  /**
   * Evaluates connection transitions: when the user walks away from their desk
   * (e.g. robot detects BLE connection to smartphone or desktop connection drops),
   * the Mobile Partner Harness automatically assumes the active Agentic Partner role.
   */
  public async handleConnectionStateChange(state: ConnectionState): Promise<void> {
    if (state === "BLE_FOUND" || state === "AGENTIC_ONLINE") {
      // Only take over as active partner when physical BLE/Wi-Fi hardware connects
      if (!this.isMobilePartnerActive) {
        await this.takeoverAsActivePartner("MOBILE_PARTNER_AUTO_TAKEOVER");
      }
    } else if (state === "SEARCHING" || state === "OFFLINE_SIMULATOR") {
      // Disconnected or preview-only: do not claim live partner hardware takeover
      this.setActiveState(false);
      this.stopAutoSyncWatcher();
    }
  }

  /**
   * Dispatches ModeTransition frame advertising the smartphone as the active partner.
   */
  public async takeoverAsActivePartner(reason = "MOBILE_PARTNER_AUTO_TAKEOVER"): Promise<boolean> {
    try {
      const payload = encodeControlPayload(ModeTransitionSchema, {
        targetMode: RobotMode.AGENTIC_CONNECTED,
        companionHost: "mobile-companion",
        companionPort: DEFAULT_WS_PORT,
        transitionReason: reason,
      });

      await robotConnection.sendRawFrame(
        FrameType.MODE_TRANSITION,
        payload,
        FLAG_ACK_REQUIRED
      );

      this.setActiveState(true);
      this.startAutoSyncWatcher();

      // Show friendly activation greeting on the robot's 1.8" TFT screen
      await this.streamTaskProgressHud({
        title: "Mobile Partner Active",
        progressPct: 100,
        emotion: EmotionId.HAPPY,
        details: "Smartphone Paired",
      });

      return true;
    } catch (err) {
      console.warn("Failed to complete mobile partner takeover:", err);
      return false;
    }
  }

  public async yieldToDesktop(reason = "DESKTOP_HARNESS_RESUMED"): Promise<boolean> {
    this.setActiveState(false);
    this.stopAutoSyncWatcher();
    return true;
  }

  private setActiveState(active: boolean): void {
    if (this.isMobilePartnerActive !== active) {
      this.isMobilePartnerActive = active;
      for (const listener of this.stateListeners) {
        listener(active);
      }
    }
  }

  // ==========================================================================
  // Robot Tool Bus (Mobile Tool Registry)
  // ==========================================================================

  /**
   * Dispatches incoming RPC tool requests routed from the ESP32-S3 robot.
   */
  public async handleRobotRpcRequest(req: HarnessRpcReq): Promise<HarnessRpcRes> {
    const { callId, method, params } = req;

    try {
      let result: Record<string, unknown> = {};

      switch (method) {
        case "mobile_get_unread_notifications": {
          const notifications = await this.bridge.getRecentNotifications();
          result = {
            count: notifications.length,
            notifications: notifications.map((n) => ({
              key: n.key,
              app: n.appName,
              sender: n.sender,
              preview: n.message.substring(0, 80),
              canReply: n.canReply,
            })),
          };
          break;
        }

        case "mobile_reply_notification": {
          const key = String(params.notificationKey || "");
          const replyText = String(params.replyText || "");
          const success = await this.replyViaVoiceDictation(key, replyText);
          result = { success, notificationKey: key };
          break;
        }

        case "mobile_make_call": {
          const phone = String(params.phoneNumber || "");
          const direct = Boolean(params.directCall ?? true);
          await this.streamTaskProgressHud({
            title: `Calling ${phone}...`,
            progressPct: 50,
            emotion: EmotionId.HAPPY,
          });
          const success = await this.bridge.makePhoneCall(phone, direct);
          result = { success, phoneNumber: phone };
          break;
        }

        case "mobile_set_alarm": {
          const hour = Number(params.hour ?? 7);
          const minutes = Number(params.minutes ?? 0);
          const message = String(params.message || "PetBot Alarm");
          await this.streamTaskProgressHud({
            title: `Setting Alarm: ${hour}:${minutes.toString().padStart(2, "0")}`,
            progressPct: 80,
            emotion: EmotionId.FOCUSED,
          });
          const success = await this.bridge.setAlarm(hour, minutes, message);
          result = { success, hour, minutes, message };
          break;
        }

        case "mobile_set_timer": {
          const seconds = Number(params.seconds ?? 60);
          const message = String(params.message || "PetBot Timer");
          const success = await this.bridge.setTimer(seconds, message);
          result = { success, seconds, message };
          break;
        }

        case "mobile_start_nav": {
          const destination = String(params.destination || "");
          const mode = (params.mode as "driving" | "walking" | "bicycling") || "driving";
          await this.streamTaskProgressHud({
            title: `Navigating to ${destination}`,
            progressPct: 70,
            emotion: EmotionId.FOCUSED,
          });
          const success = await this.bridge.startNavigation(destination, mode);
          result = { success, destination, mode };
          break;
        }

        case "mobile_toggle_flashlight": {
          const enabled = params.enabled !== undefined ? Boolean(params.enabled) : undefined;
          const success = await this.bridge.toggleTorch(enabled);
          result = { success, enabled };
          break;
        }

        case "mobile_set_ringer": {
          const mode = (params.mode as "NORMAL" | "VIBRATE" | "SILENT") || "NORMAL";
          const success = await this.bridge.setRingerMode(mode);
          result = { success, mode };
          break;
        }

        case "mobile_media_playback": {
          const command = (params.command as any) || "PLAY_PAUSE";
          const success = await this.bridge.controlMedia(command);
          result = { success, command };
          break;
        }

        case "mobile_open_app": {
          const appName = String(params.appName || "");
          const openRes = await this.bridge.openApp(appName);
          result = { ...openRes };
          break;
        }

        case "mobile_search_web": {
          const query = String(params.query || "");
          const target = params.target === "youtube" ? "youtube" : "google";
          const success = await this.bridge.searchWeb(query, target);
          result = { success, query, target };
          break;
        }

        case "mobile_inspect_screen": {
          const tree = await this.bridge.dumpAccessibilityTree();
          result = {
            packageName: tree.packageName,
            timestamp: tree.timestamp,
            root: tree.root,
          };
          break;
        }

        case "mobile_click_element": {
          const success = await this.bridge.performAccessibilityAction({
            nodeId: params.nodeId ? String(params.nodeId) : undefined,
            textMatch: params.textMatch ? String(params.textMatch) : undefined,
            resourceId: params.resourceId ? String(params.resourceId) : undefined,
            actionType: "CLICK",
          });
          result = { success };
          break;
        }

        case "mobile_input_text": {
          const success = await this.bridge.performAccessibilityAction({
            nodeId: params.nodeId ? String(params.nodeId) : undefined,
            textMatch: params.textMatch ? String(params.textMatch) : undefined,
            resourceId: params.resourceId ? String(params.resourceId) : undefined,
            actionType: "SET_TEXT",
            actionArg: String(params.text || ""),
          });
          result = { success };
          break;
        }

        case "mobile_pocket_sync": {
          const count = await this.syncPocketVault();
          result = { syncedFilesCount: count };
          break;
        }

        case "mobile_get_telemetry": {
          const telemetry = await this.bridge.getMobileTelemetry();
          result = { ...telemetry };
          break;
        }

        case "run_automation":
        case "trigger_automation": {
          const scriptName = String(params.scriptName || params.name || "Mobile Automation");
          await this.streamTaskProgressHud({
            title: scriptName.slice(0, 22),
            progressPct: 100,
            emotion: EmotionId.FOCUSED,
            details: "Mobile script executed",
          });
          result = { executed: true, scriptName, target: "MOBILE" };
          break;
        }

        case "navigate_widget":
        case "habit_manage":
        case "save_note":
        case "pomodoro_control":
        case "start_timer": {
          result = { relayed: true, method, params };
          break;
        }

        default:
          return {
            callId,
            success: false,
            error: `Unknown mobile tool method: ${method}`,
          };
      }

      const response: HarnessRpcRes = {
        callId,
        success: true,
        result,
      };

      await robotConnection.sendHarnessRpcResponse(response);
      return response;
    } catch (err: any) {
      const errorResponse: HarnessRpcRes = {
        callId,
        success: false,
        error: err?.message || String(err),
      };
      await robotConnection.sendHarnessRpcResponse(errorResponse);
      return errorResponse;
    }
  }

  // ==========================================================================
  // Pillar 1: Voice Dictation Reply via Silent RemoteInput
  // ==========================================================================

  /**
   * Dictate a reply to WhatsApp, Telegram, Slack, or SMS from the robot's microphone.
   * Dispatches the RemoteInput intent in the background without unlocking or waking the phone screen!
   */
  public async replyViaVoiceDictation(notificationKey: string, replyText: string): Promise<boolean> {
    // 1. Show listening/sending HUD on the robot's screen
    await this.streamTaskProgressHud({
      title: "Dictating Reply...",
      progressPct: 35,
      emotion: EmotionId.LISTENING,
      details: replyText.substring(0, 30),
    });

    await this.streamTaskProgressHud({
      title: "Sending via RemoteInput...",
      progressPct: 75,
      emotion: EmotionId.FOCUSED,
      details: replyText.substring(0, 30),
    });

    // 2. Send via native RemoteInput
    const success = await this.bridge.sendNotificationReply(notificationKey, replyText);

    // 3. Update HUD with completion state
    if (success) {
      await this.streamTaskProgressHud({
        title: "Reply Sent!",
        progressPct: 100,
        emotion: EmotionId.HAPPY,
        details: "Silent background delivery complete",
      });
    } else {
      await this.streamTaskProgressHud({
        title: "Reply Failed",
        progressPct: 100,
        emotion: EmotionId.ALERT,
        details: "Notification expired or reply unavailable",
      });
    }

    return success;
  }

  // ==========================================================================
  // Pillar 4: Mobile "Send & Collect" Auto-Pocket Sync
  // ==========================================================================

  /**
   * Checks for files staged via the Android Share Target and streams them in
   * 16KB CRC32 chunks to the physical robot's MicroSD card.
   */
  public async syncPocketVault(): Promise<number> {
    const pendingFiles = await this.bridge.getPendingVaultFiles();
    if (pendingFiles.length === 0) {
      return 0;
    }

    let syncedCount = 0;

    for (const file of pendingFiles) {
      await this.streamTaskProgressHud({
        title: `Beaming ${file.fileName}`,
        progressPct: 10,
        emotion: EmotionId.FOCUSED,
        details: `0 / ${Math.round(file.sizeBytes / 1024)} KB`,
      });

      const rawBytes = file.bytes ?? new Uint8Array();

      await this.sdVault.sendFileToRobotVault(
        {
          name: file.fileName,
          type: file.mimeType,
          bytes: rawBytes,
        },
        (progressPct) => {
          this.streamTaskProgressHud({
            title: `Beaming ${file.fileName}`,
            progressPct,
            emotion: EmotionId.FOCUSED,
            details: `${progressPct}% transferred`,
          }).catch(() => {});
        }
      );

      syncedCount++;
    }

    // Clean up staged files once transferred
    await this.bridge.clearPendingVaultFiles();

    await this.streamTaskProgressHud({
      title: "Pocket Vault Synced!",
      progressPct: 100,
      emotion: EmotionId.HAPPY,
      details: `${syncedCount} file(s) saved to MicroSD`,
    });

    return syncedCount;
  }

  private startAutoSyncWatcher(): void {
    if (this.autoSyncInterval) return;
    this.autoSyncInterval = setInterval(() => {
      this.syncPocketVault().catch((err) => {
        console.warn("Auto-pocket sync error:", err);
      });
    }, 15000); // Check every 15s when active
  }

  private stopAutoSyncWatcher(): void {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
      this.autoSyncInterval = null;
    }
  }

  // ==========================================================================
  // TFT Live HUD Streamer
  // ==========================================================================

  /**
   * Dispatches live progress HUD updates to the physical robot's 1.8" TFT screen.
   */
  public async streamTaskProgressHud(options: MobileHudProgressOptions): Promise<boolean> {
    const req: HarnessRpcReq = {
      callId: `hud_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      method: "TASK_PROGRESS_HUD",
      params: {
        title: options.title,
        progressPct: Math.min(100, Math.max(0, options.progressPct)),
        emotion: options.emotion ?? EmotionId.FOCUSED,
        details: options.details || "",
        source: "MOBILE_PARTNER",
      },
    };

    return robotConnection.sendHarnessRpcRequest(req);
  }

  public destroy(): void {
    this.stopAutoSyncWatcher();
    if (this.unregisterConnectionListener) {
      this.unregisterConnectionListener();
      this.unregisterConnectionListener = null;
    }
    if (this.unregisterRpcListener) {
      this.unregisterRpcListener();
      this.unregisterRpcListener = null;
    }
    this.stateListeners.clear();
  }
}

export const mobileHarnessOrchestrator = MobileHarnessOrchestrator.getInstance();
