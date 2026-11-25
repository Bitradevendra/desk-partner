/**
 * PetBot Mobile Partner Bridge
 * 
 * TypeScript interface and runtime adapter connecting the companion app and ESP32-S3 Pet Robot
 * to native Android smartphone capabilities via Capacitor or deterministic mock fallback:
 * - Pillar 1: Intercept incoming notifications & trigger silent RemoteInput replies
 * - Pillar 2: Direct OS Intent dispatch (Calls, Alarms, Maps navigation, Torch, Ringer, Deep Links)
 * - Pillar 3: Headless semantic accessibility tree parsing and programmatic UI execution
 * - Pillar 4: Pocket Vault share receiver staging and MicroSD synchronization
 */

export interface MobileNotification {
  readonly id: string;
  readonly key: string;
  readonly packageName: string;
  readonly appName: string;
  readonly sender: string;
  readonly message: string;
  readonly postTime: number;
  readonly canReply: boolean;
  readonly category?: string | undefined;
}

export interface SemanticBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface SemanticNode {
  readonly nodeId: string;
  readonly className: string;
  readonly packageName: string;
  readonly text?: string | undefined;
  readonly contentDescription?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly isClickable: boolean;
  readonly isEditable: boolean;
  readonly isScrollable: boolean;
  readonly isVisible: boolean;
  readonly bounds: SemanticBounds;
  readonly children?: SemanticNode[] | undefined;
}

export type MobileIntentAction =
  | { readonly type: "CALL"; readonly phoneNumber: string; readonly directCall?: boolean | undefined }
  | { readonly type: "ALARM"; readonly hour: number; readonly minutes: number; readonly message?: string | undefined; readonly skipUi?: boolean | undefined }
  | { readonly type: "TIMER"; readonly seconds: number; readonly message?: string | undefined; readonly skipUi?: boolean | undefined }
  | { readonly type: "CALENDAR"; readonly title: string; readonly startTime: number; readonly endTime?: number | undefined; readonly description?: string | undefined }
  | { readonly type: "NAVIGATION"; readonly destination: string; readonly mode?: "driving" | "walking" | "bicycling" | undefined }
  | { readonly type: "MEDIA"; readonly command: "PLAY_PAUSE" | "PLAY" | "PAUSE" | "NEXT" | "PREVIOUS" }
  | { readonly type: "TORCH"; readonly enabled?: boolean | undefined }
  | { readonly type: "RINGER"; readonly mode: "NORMAL" | "VIBRATE" | "SILENT" }
  | { readonly type: "OPEN_APP"; readonly appName: string }
  | { readonly type: "SEARCH_WEB"; readonly query: string; readonly target?: "google" | "youtube" | undefined }
  | { readonly type: "DEEP_LINK"; readonly url: string };

export interface MobilePermissionState {
  readonly bluetooth: boolean;
  readonly notifications: boolean;
  readonly dndAccess: boolean;
  readonly standardApisReady: boolean;
  readonly notificationListener: boolean;
  readonly accessibilityService: boolean;
  readonly callPhone: boolean;
}

export interface MobileTelemetry {
  readonly batteryPct: number;
  readonly isCharging: boolean;
  readonly networkType: "WIFI" | "CELLULAR" | "OTHER" | "NONE";
  readonly ringerMode: "NORMAL" | "VIBRATE" | "SILENT";
  readonly torchEnabled: boolean;
  readonly permissions: MobilePermissionState;
}

export interface PendingVaultFile {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly filePath?: string | undefined;
  readonly base64Data?: string | undefined;
  readonly bytes?: Uint8Array | undefined;
  readonly stagedTimestamp: number;
}

export interface AccessibilityActionOptions {
  readonly nodeId?: string | undefined;
  readonly textMatch?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly actionType: "CLICK" | "SET_TEXT" | "SCROLL_FORWARD" | "SCROLL_BACKWARD";
  readonly actionArg?: string | undefined;
}

export class MobilePartnerBridge {
  private static instance: MobilePartnerBridge | null = null;

  // Mock engine state for web / test execution
  private mockNotifications = new Map<string, MobileNotification>();
  private mockRepliesSent: Array<{ key: string; text: string; timestamp: number }> = [];
  private mockIntentHistory: MobileIntentAction[] = [];
  private mockTorchState = false;
  private mockRingerState: "NORMAL" | "VIBRATE" | "SILENT" = "NORMAL";
  private mockStagedFiles = new Map<string, PendingVaultFile>();
  private mockSemanticTree: SemanticNode;
  private notificationListeners = new Set<(notif: MobileNotification) => void>();

  public static getInstance(): MobilePartnerBridge {
    if (!MobilePartnerBridge.instance) {
      MobilePartnerBridge.instance = new MobilePartnerBridge();
    }
    return MobilePartnerBridge.instance;
  }

  constructor() {
    this.mockSemanticTree = this.createDefaultMockSemanticTree();
    this.seedDefaultMockNotifications();
  }

  /**
   * Returns true if running within a real native Capacitor Android container.
   */
  public isNative(): boolean {
    if (typeof window === "undefined") return false;
    const cap = (window as unknown as { Capacitor?: { isPluginAvailable?: (name: string) => boolean } }).Capacitor;
    return Boolean(cap?.isPluginAvailable?.("PetBotMobileHarness"));
  }

  private getNativePlugin(): any {
    if (!this.isNative()) return null;
    return (window as any).Capacitor.Plugins.PetBotMobileHarness;
  }

  // ==========================================================================
  // Pillar 1: Notification & Message Interception + Silent Reply
  // ==========================================================================

  public async getRecentNotifications(): Promise<MobileNotification[]> {
    const plugin = this.getNativePlugin();
    if (plugin) {
      const res = await plugin.getRecentNotifications();
      return res.notifications || [];
    }
    return Array.from(new Set(this.mockNotifications.values()));
  }

  public async sendNotificationReply(notificationKey: string, replyText: string): Promise<boolean> {
    const plugin = this.getNativePlugin();
    if (plugin) {
      const res = await plugin.sendNotificationReply({ notificationKey, replyText });
      return Boolean(res.success);
    }

    const notif =
      this.mockNotifications.get(notificationKey) ??
      Array.from(this.mockNotifications.values()).find(
        (n) => n.key === notificationKey || n.id === notificationKey
      );
    if (!notif || !notif.canReply) {
      return false;
    }

    this.mockRepliesSent.push({
      key: notif.key,
      text: replyText,
      timestamp: Date.now(),
    });

    // Remove or mark handled
    this.mockNotifications.delete(notif.key);
    this.mockNotifications.delete(notif.id);
    return true;
  }

  public onNotificationReceived(listener: (notif: MobileNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  public simulateIncomingNotification(notif: Partial<MobileNotification>): MobileNotification {
    const full: MobileNotification = {
      id: notif.id || `notif_${Date.now()}`,
      key: notif.key || `0|com.whatsapp|${Date.now()}|tag|10001`,
      packageName: notif.packageName || "com.whatsapp",
      appName: notif.appName || "WhatsApp",
      sender: notif.sender || "Alex Chen",
      message: notif.message || "Hey, are you free for a call?",
      postTime: notif.postTime || Date.now(),
      canReply: notif.canReply ?? true,
      category: notif.category || "msg",
    };
    this.mockNotifications.set(full.key, full);
    for (const listener of this.notificationListeners) {
      listener(full);
    }
    return full;
  }

  public getRepliesSent(): ReadonlyArray<{ key: string; text: string; timestamp: number }> {
    return [...this.mockRepliesSent];
  }

  // ==========================================================================
  // Pillar 2: Direct OS Intent Action Dispatcher (Zero GUI)
  // ==========================================================================

  public async dispatchIntent(action: MobileIntentAction): Promise<{ success: boolean; result?: unknown }> {
    const plugin = this.getNativePlugin();
    if (plugin) {
      const { type, ...params } = action;
      const res = await plugin.dispatchIntentAction({ actionType: type, params });
      return { success: Boolean(res.success), result: res };
    }

    // Mock Dispatcher Execution
    this.mockIntentHistory.push(action);

    switch (action.type) {
      case "TORCH": {
        this.mockTorchState = action.enabled ?? !this.mockTorchState;
        return { success: true, result: { torchEnabled: this.mockTorchState } };
      }
      case "RINGER": {
        this.mockRingerState = action.mode;
        return { success: true, result: { ringerMode: this.mockRingerState } };
      }
      case "CALL":
      case "ALARM":
      case "TIMER":
      case "CALENDAR":
      case "NAVIGATION":
      case "MEDIA":
      case "OPEN_APP":
      case "SEARCH_WEB":
      case "DEEP_LINK":
        return { success: true, result: { executed: true, action: action.type } };
    }
  }

  public async makePhoneCall(phoneNumber: string, directCall = false): Promise<boolean> {
    const res = await this.dispatchIntent({ type: "CALL", phoneNumber, directCall });
    return res.success;
  }

  public async setAlarm(hour: number, minutes: number, message = "PetBot Alarm", skipUi = true): Promise<boolean> {
    const res = await this.dispatchIntent({ type: "ALARM", hour, minutes, message, skipUi });
    return res.success;
  }

  public async setTimer(seconds: number, message = "PetBot Timer", skipUi = true): Promise<boolean> {
    const res = await this.dispatchIntent({ type: "TIMER", seconds, message, skipUi });
    return res.success;
  }

  public async createCalendarEvent(title: string, startTime: number, endTime?: number, description?: string): Promise<boolean> {
    const res = await this.dispatchIntent({ type: "CALENDAR", title, startTime, endTime, description });
    return res.success;
  }

  public async startNavigation(destination: string, mode?: "driving" | "walking" | "bicycling"): Promise<boolean> {
    const res = await this.dispatchIntent({ type: "NAVIGATION", destination, mode });
    return res.success;
  }

  public async controlMedia(command: "PLAY_PAUSE" | "PLAY" | "PAUSE" | "NEXT" | "PREVIOUS"): Promise<boolean> {
    const res = await this.dispatchIntent({ type: "MEDIA", command });
    return res.success;
  }

  public async toggleTorch(enabled?: boolean): Promise<boolean> {
    const res = await this.dispatchIntent({ type: "TORCH", enabled });
    return res.success;
  }

  public async setRingerMode(mode: "NORMAL" | "VIBRATE" | "SILENT"): Promise<boolean> {
    const res = await this.dispatchIntent({ type: "RINGER", mode });
    return res.success;
  }

  public async openDeepLink(url: string): Promise<boolean> {
    const res = await this.dispatchIntent({ type: "DEEP_LINK", url });
    return res.success;
  }

  public async openApp(
    appName: string
  ): Promise<{ success: boolean; appName?: string | undefined; error?: string | undefined }> {
    const res = await this.dispatchIntent({ type: "OPEN_APP", appName });
    const raw = (res.result as Record<string, any> | undefined) ?? {};
    return {
      success: res.success,
      appName: typeof raw.appName === "string" ? raw.appName : appName,
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    };
  }

  public async searchWeb(query: string, target: "google" | "youtube" = "google"): Promise<boolean> {
    const res = await this.dispatchIntent({ type: "SEARCH_WEB", query, target });
    return res.success;
  }

  public getIntentHistory(): ReadonlyArray<MobileIntentAction> {
    return [...this.mockIntentHistory];
  }

  // ==========================================================================
  // Pillar 3: Headless Semantic Accessibility UI Tree & Actions
  // ==========================================================================

  public async dumpAccessibilityTree(): Promise<{ root: SemanticNode; packageName: string; timestamp: number }> {
    const plugin = this.getNativePlugin();
    if (plugin) {
      const res = await plugin.dumpAccessibilityTree();
      return res.tree;
    }
    return {
      root: this.mockSemanticTree,
      packageName: this.mockSemanticTree.packageName,
      timestamp: Date.now(),
    };
  }

  public async findNode(predicate: (node: SemanticNode) => boolean): Promise<SemanticNode | null> {
    const tree = await this.dumpAccessibilityTree();
    const search = (node: SemanticNode): SemanticNode | null => {
      if (predicate(node)) return node;
      if (node.children) {
        for (const child of node.children) {
          const found = search(child);
          if (found) return found;
        }
      }
      return null;
    };
    return search(tree.root);
  }

  public async findNodeByText(text: string): Promise<SemanticNode | null> {
    const lower = text.toLowerCase();
    return this.findNode(
      (n) =>
        (n.text?.toLowerCase().includes(lower) || n.contentDescription?.toLowerCase().includes(lower)) ?? false
    );
  }

  public async findNodeByResourceId(resourceId: string): Promise<SemanticNode | null> {
    return this.findNode((n) => n.resourceId === resourceId);
  }

  public async performAccessibilityAction(options: AccessibilityActionOptions): Promise<boolean> {
    const plugin = this.getNativePlugin();
    if (plugin) {
      const res = await plugin.performAccessibilityAction(options);
      return Boolean(res.success);
    }

    // Mock Execution
    const target = options.resourceId
      ? await this.findNodeByResourceId(options.resourceId)
      : options.textMatch
      ? await this.findNodeByText(options.textMatch)
      : await this.findNode((n) => n.nodeId === options.nodeId);

    if (!target) return false;

    if (options.actionType === "CLICK" && (target.isClickable || true)) {
      return true;
    }
    if (options.actionType === "SET_TEXT" && target.isEditable) {
      return true;
    }
    if (options.actionType.startsWith("SCROLL") && target.isScrollable) {
      return true;
    }
    return true;
  }

  public async performGlobalAction(action: "BACK" | "HOME" | "RECENTS" | "NOTIFICATIONS"): Promise<boolean> {
    const plugin = this.getNativePlugin();
    if (plugin) {
      const res = await plugin.performGlobalAction({ action });
      return Boolean(res.success);
    }
    return true;
  }

  public setMockSemanticTree(root: SemanticNode): void {
    this.mockSemanticTree = root;
  }

  // ==========================================================================
  // Pillar 4: Pocket Vault Auto-Sync & Staging
  // ==========================================================================

  public async getPendingVaultFiles(): Promise<PendingVaultFile[]> {
    const plugin = this.getNativePlugin();
    if (plugin) {
      const res = await plugin.getPendingShareFiles();
      const files: PendingVaultFile[] = [];
      for (const f of res.files || []) {
        let bytes: Uint8Array | undefined;
        if (f.base64Data) {
          bytes = this.base64ToBytes(f.base64Data);
        }
        files.push({
          id: f.id,
          fileName: f.fileName,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          filePath: f.filePath,
          base64Data: f.base64Data,
          bytes,
          stagedTimestamp: f.stagedTimestamp,
        });
      }
      return files;
    }

    return Array.from(this.mockStagedFiles.values());
  }

  public async clearPendingVaultFiles(): Promise<boolean> {
    const plugin = this.getNativePlugin();
    if (plugin) {
      const res = await plugin.clearPendingShareFiles();
      return Boolean(res.cleared);
    }
    this.mockStagedFiles.clear();
    return true;
  }

  public stageMockFile(file: { fileName: string; mimeType: string; bytes: Uint8Array }): PendingVaultFile {
    const id = `vault_staged_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const base64 = this.bytesToBase64(file.bytes);
    const item: PendingVaultFile = {
      id,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.bytes.byteLength,
      bytes: file.bytes,
      base64Data: base64,
      stagedTimestamp: Date.now(),
    };
    this.mockStagedFiles.set(id, item);
    return item;
  }

  // ==========================================================================
  // Telemetry & Standard Runtime Permissions
  // ==========================================================================

  public async checkPermissions(): Promise<MobilePermissionState> {
    const plugin = this.getNativePlugin();
    if (plugin) {
      const raw = await plugin.checkPermissions();
      return {
        bluetooth: Boolean(raw.bluetooth),
        notifications: Boolean(raw.notifications),
        dndAccess: Boolean(raw.dndAccess),
        standardApisReady: raw.standardApisReady !== false,
        notificationListener: Boolean(raw.notificationListener),
        accessibilityService: Boolean(raw.accessibilityService),
        callPhone: Boolean(raw.callPhone),
      };
    }
    return {
      bluetooth: true,
      notifications: true,
      dndAccess: true,
      standardApisReady: true,
      notificationListener: false,
      accessibilityService: false,
      callPhone: false,
    };
  }

  public async requestPermission(
    type: "BLUETOOTH" | "NOTIFICATIONS" | "DND" | "ALL"
  ): Promise<boolean> {
    const plugin = this.getNativePlugin();
    if (plugin) {
      const res = await plugin.requestPermission({ permission: type });
      return Boolean(res.granted ?? res.opened);
    }
    return true;
  }

  public async postLocalNotification(
    title: string,
    body: string,
    id?: number
  ): Promise<boolean> {
    const plugin = this.getNativePlugin();
    if (plugin?.postLocalNotification) {
      const res = await plugin.postLocalNotification({ title, body, id });
      return Boolean(res.success);
    }
    return true;
  }

  public async getMobileTelemetry(): Promise<MobileTelemetry> {
    const plugin = this.getNativePlugin();
    if (plugin) {
      const res = await plugin.getMobileTelemetry();
      const perms = res.permissions ?? (await this.checkPermissions());
      return {
        batteryPct: res.batteryPct ?? 88,
        isCharging: Boolean(res.isCharging),
        networkType: res.networkType || "WIFI",
        ringerMode: res.ringerMode || "NORMAL",
        torchEnabled: Boolean(res.torchEnabled),
        permissions: {
          bluetooth: Boolean(perms.bluetooth),
          notifications: Boolean(perms.notifications),
          dndAccess: Boolean(perms.dndAccess),
          standardApisReady: perms.standardApisReady !== false,
          notificationListener: Boolean(perms.notificationListener),
          accessibilityService: Boolean(perms.accessibilityService),
          callPhone: Boolean(perms.callPhone),
        },
      };
    }

    return {
      batteryPct: 88,
      isCharging: false,
      networkType: "WIFI",
      ringerMode: this.mockRingerState,
      torchEnabled: this.mockTorchState,
      permissions: {
        bluetooth: true,
        notifications: true,
        dndAccess: true,
        standardApisReady: true,
        notificationListener: false,
        accessibilityService: false,
        callPhone: false,
      },
    };
  }

  // ==========================================================================
  // Utilities & Seed Data
  // ==========================================================================

  private seedDefaultMockNotifications(): void {
    const now = Date.now();
    const notifs: MobileNotification[] = [
      {
        id: "101",
        key: "0|com.whatsapp|101|null|10001",
        packageName: "com.whatsapp",
        appName: "WhatsApp",
        sender: "Maya Lin",
        message: "Hey! Did you finish the ESP32 circuit assembly?",
        postTime: now - 120000,
        canReply: true,
        category: "msg",
      },
      {
        id: "102",
        key: "0|org.telegram.messenger|102|null|10002",
        packageName: "org.telegram.messenger",
        appName: "Telegram",
        sender: "Robotics Club",
        message: "Live demo starts in 15 minutes in Lab B.",
        postTime: now - 300000,
        canReply: true,
        category: "msg",
      },
      {
        id: "103",
        key: "0|com.google.android.apps.messaging|103|null|10003",
        packageName: "com.google.android.apps.messaging",
        appName: "Messages",
        sender: "+1 (555) 019-2831",
        message: "Your verification code is 492018.",
        postTime: now - 600000,
        canReply: false,
        category: "msg",
      },
    ];

    for (const notif of notifs) {
      this.mockNotifications.set(notif.key, notif);
      this.mockNotifications.set(notif.id, notif);
    }
  }

  private createDefaultMockSemanticTree(): SemanticNode {
    return {
      nodeId: "window_root",
      className: "android.widget.FrameLayout",
      packageName: "com.whatsapp",
      isClickable: false,
      isEditable: false,
      isScrollable: false,
      isVisible: true,
      bounds: { left: 0, top: 0, right: 1080, bottom: 2400, width: 1080, height: 2400 },
      children: [
        {
          nodeId: "header_title",
          className: "android.widget.TextView",
          packageName: "com.whatsapp",
          text: "Maya Lin",
          isClickable: true,
          isEditable: false,
          isScrollable: false,
          isVisible: true,
          bounds: { left: 160, top: 120, right: 600, bottom: 200, width: 440, height: 80 },
        },
        {
          nodeId: "message_list",
          className: "androidx.recyclerview.widget.RecyclerView",
          packageName: "com.whatsapp",
          resourceId: "com.whatsapp:id/conversation_list",
          isClickable: false,
          isEditable: false,
          isScrollable: true,
          isVisible: true,
          bounds: { left: 0, top: 220, right: 1080, bottom: 2150, width: 1080, height: 1930 },
          children: [
            {
              nodeId: "bubble_1",
              className: "android.widget.TextView",
              packageName: "com.whatsapp",
              text: "Hey! Did you finish the ESP32 circuit assembly?",
              isClickable: true,
              isEditable: false,
              isScrollable: false,
              isVisible: true,
              bounds: { left: 40, top: 1800, right: 800, bottom: 1950, width: 760, height: 150 },
            },
          ],
        },
        {
          nodeId: "input_box",
          className: "android.widget.EditText",
          packageName: "com.whatsapp",
          resourceId: "com.whatsapp:id/entry",
          text: "",
          contentDescription: "Type a message",
          isClickable: true,
          isEditable: true,
          isScrollable: false,
          isVisible: true,
          bounds: { left: 40, top: 2180, right: 900, bottom: 2320, width: 860, height: 140 },
        },
        {
          nodeId: "send_button",
          className: "android.widget.ImageButton",
          packageName: "com.whatsapp",
          resourceId: "com.whatsapp:id/send",
          contentDescription: "Send",
          isClickable: true,
          isEditable: false,
          isScrollable: false,
          isVisible: true,
          bounds: { left: 920, top: 2180, right: 1040, bottom: 2320, width: 120, height: 140 },
        },
      ],
    };
  }

  private bytesToBase64(bytes: Uint8Array): string {
    const maybeBuffer = (globalThis as any).Buffer;
    if (typeof maybeBuffer !== "undefined") {
      return maybeBuffer.from(bytes).toString("base64");
    }
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  }

  private base64ToBytes(base64: string): Uint8Array {
    const maybeBuffer = (globalThis as any).Buffer;
    if (typeof maybeBuffer !== "undefined") {
      return new Uint8Array(maybeBuffer.from(base64, "base64"));
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}

export const mobilePartnerBridge = MobilePartnerBridge.getInstance();
