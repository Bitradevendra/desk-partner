import { create } from "zustand";
import {
  EmotionId,
  RobotMode,
  type Touch2FaChallenge,
  type SdVaultEntry,
} from "@petbot/protocol";
import type { WidgetPackage, EmotionType } from "@petbot/widget-schema";
import {
  robotConnection,
  type ConnectionState,
  type RobotTelemetry,
} from "../services/robot-connection.js";
import { aiStudioCompiler } from "../services/ai-studio-compiler.js";
import { BUILTIN_WIDGETS } from "./builtin-widgets.js";
import type { VaultFileItem } from "../services/sd-vault-client.js";
import {
  mobileHarnessOrchestrator,
  mobilePartnerBridge,
  type MobileTelemetry,
} from "../mobile-harness/index.js";
import { webAudioSynth } from "../services/web-audio-synth.js";
import {
  getSavedGeminiApiKey,
  saveGeminiApiKey,
  processVoiceWavWithGemini,
  processTextWithGemini,
  synthesizeReplyToPcm16,
  type GeminiVoiceAction,
} from "../services/gemini-voice-client.js";

export type NavTab = "HUB" | "STUDIO" | "VAULT" | "PRO";
export type SideDoubleTapAction = "AI_BRIEFING" | "MEDIA_PLAY_PAUSE" | "NEXT_WIDGET";

export interface HardwareSettings {
  volumePct: number;
  brightnessPct: number;
  nightDimScheduleEnabled: boolean;
  vadSensitivity: number;
  silenceReturnSec: 10 | 15 | 30;
  wakeWordEnabled: boolean;
  wakeWordPhrase: "Hi ESP" | "Hey Lobo" | "Hey PetBot";
  sideDoubleTapAction: SideDoubleTapAction;
  diagnosticsOverlayEnabled: boolean;
}

export interface AndroidMirrorSettings {
  mirrorCalls: boolean;
  mirrorWhatsApp: boolean;
  mirrorCalendar: boolean;
  mirrorSlack: boolean;
}

export interface WifiProvisionConfig {
  ssid: string;
  harnessHost: string;
  harnessPort: number;
}

export interface ChatMessage {
  id: string;
  sender: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface StudioState {
  draftWidget: WidgetPackage;
  chatHistory: ChatMessage[];
  undoStack: WidgetPackage[];
  redoStack: WidgetPackage[];
  simulatorSlots: Record<string, string | number | boolean>;
  isGenerating: boolean;
}

export interface SubscriptionState {
  tier: "FREE" | "PRO";
  voicePersona: string;
  voiceAiEnabled: boolean;
  jwtToken: string | null;
}

export interface HabitItem {
  id: string;
  name: string;
  completed: boolean;
  streak: number;
}

export interface HarnessLogItem {
  id: string;
  timestamp: number;
  title: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  status: "APPROVED" | "DENIED" | "EXECUTED" | "PENDING";
  details?: string;
}

export interface PetBotStore {
  // Navigation
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;

  // Connection & Telemetry
  connectionState: ConnectionState;
  telemetry: RobotTelemetry;
  connect: (preferSimulator?: boolean) => Promise<void>;
  connectBle: () => Promise<boolean>;
  connectToHost: (host: string, port?: number) => Promise<boolean>;
  disconnect: () => void;
  wakeOrPetRobot: () => Promise<boolean>;
  setMode: (mode: RobotMode) => Promise<boolean>;

  // Installed Widgets & Screen Carousel
  installedWidgets: WidgetPackage[];
  activeWidgetId: string;
  previewEmotion: EmotionType;
  setPreviewEmotion: (emotion: EmotionType) => Promise<void>;
  setActiveWidget: (widgetId: string) => Promise<void>;
  deployWidget: (widget: WidgetPackage) => Promise<boolean>;
  removeWidget: (widgetId: string) => void;
  reorderWidgets: (fromIndex: number, toIndex: number) => void;

  // Quick Notes & Daily Habits
  quickNotes: string;
  setQuickNotes: (notes: string) => void;
  habits: HabitItem[];
  toggleHabit: (id: string) => void;
  addHabit: (name: string) => void;
  removeHabit: (id: string) => void;
  syncNotesAndHabits: () => Promise<void>;

  // Magic Studio
  studioState: StudioState;
  sendStudioPrompt: (promptText: string) => Promise<void>;
  setDraftWidget: (widget: WidgetPackage) => void;
  undoDraft: () => void;
  redoDraft: () => void;
  updateSimulatorSlot: (key: string, value: string | number | boolean) => void;

  // SD Pocket Vault
  vaultFiles: VaultFileItem[];
  isRefreshingVault: boolean;
  refreshVault: () => Promise<boolean>;
  uploadFileToVault: (file: File) => Promise<boolean>;
  deleteVaultFile: (fileId: string) => void;

  // Cloud Voice & Security
  subscription: SubscriptionState;
  wakeMode: "PUSH_TO_TALK" | "VOICE_ACTIVITY";
  setWakeMode: (mode: "PUSH_TO_TALK" | "VOICE_ACTIVITY") => void;
  setVoicePersona: (persona: string) => void;
  setVoiceAiEnabled: (enabled: boolean) => void;
  upgradeSubscription: (tier: "FREE" | "PRO") => Promise<void>;

  // Desktop Harness Security & Physical 2FA Feed
  harnessLogs: HarnessLogItem[];
  addHarnessLog: (log: HarnessLogItem) => void;
  active2FaChallenge: Touch2FaChallenge | null;
  respondTo2Fa: (approved: boolean) => Promise<void>;

  // Native Mobile Partner Harness
  isMobilePartnerActive: boolean;
  mobileTelemetry: MobileTelemetry | null;
  triggerMobileTakeover: () => Promise<void>;
  yieldMobileToDesktop: () => Promise<void>;
  syncMobilePocketVault: () => Promise<number>;
  refreshMobileTelemetry: () => Promise<void>;

  // Hardware Ergonomics, Wi-Fi Setup, Android Mirroring & Developer Mode
  devMode: boolean;
  setDevMode: (enabled: boolean) => void;
  isProvisionModalOpen: boolean;
  setProvisionModalOpen: (open: boolean) => void;
  wifiProvisionConfig: WifiProvisionConfig;
  provisionRobotWifi: (
    ssid: string,
    password: string,
    harnessHost: string,
    harnessPort: number
  ) => Promise<boolean>;
  hardwareSettings: HardwareSettings;
  updateHardwareSettings: (patch: Partial<HardwareSettings>) => Promise<void>;
  toggleDiagnosticsOverlay: (enabled: boolean) => Promise<void>;
  remapPinOverride: (name: string, gpio: number) => Promise<void>;
  androidMirrorSettings: AndroidMirrorSettings;
  setAndroidMirrorSetting: (key: keyof AndroidMirrorSettings, value: boolean) => void;
  geminiApiKey: string;
  setGeminiApiKey: (key: string) => void;
  lastVoiceStatus: string | null;
  lastVoiceTranscript: string | null;
  executeVoiceCommand: (utterance: string) => Promise<{ spokenText: string; actions: string[] }>;
}

function computeSyncedWidgetSlots(
  habits: HabitItem[],
  quickNotes: string
): Record<string, string | number | boolean> {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const dateStr = now
    .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "2-digit" })
    .toUpperCase();
  const formatHabitRow = (h?: HabitItem) =>
    h ? `${h.completed ? "[x]" : "[ ]"} ${h.name}` : "";
  const noteLines = quickNotes
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return {
    timeStr,
    dateStr,
    clockLabel: "LOCAL TIME",
    moodScore: 98,
    habitsCompleted: habits.filter((h) => h.completed).length,
    habitsTotal: habits.length,
    habit1: formatHabitRow(habits[0]),
    habit2: formatHabitRow(habits[1]),
    habit3: formatHabitRow(habits[2]),
    note1: noteLines[0] ?? "• No notes yet",
    note2: noteLines[1] ?? "",
    note3: noteLines[2] ?? "",
    notesStr: quickNotes,
    minutesRemaining: 25,
    cupsDrank: 4,
  };
}

export const usePetBotStore = create<PetBotStore>((set, get) => {
  // Bind connection manager events once
  robotConnection.onConnectionStateChange((state) => {
    set({ connectionState: state });
  });

  robotConnection.onTelemetry((telemetry) => {
    set({ telemetry });
  });

  robotConnection.onTouch2FaChallenge((challenge) => {
    set({ active2FaChallenge: challenge });
  });

  mobileHarnessOrchestrator.onStateChange((isActive) => {
    set({ isMobilePartnerActive: isActive });
  });

  robotConnection.onSdVaultList((list) => {
    const files: VaultFileItem[] = list.entries.map((e, idx) => {
      const ext = e.name.split(".").pop()?.toLowerCase() || "";
      let type: VaultFileItem["type"] = "other";
      if (["png", "jpg", "jpeg", "webp", "rgb565"].includes(ext)) type = "image";
      else if (["wav", "mp3", "opus"].includes(ext)) type = "audio";
      else if (["pdf", "txt", "md"].includes(ext)) type = "document";
      else if (["pbwg", "bin"].includes(ext)) type = "code";
      else if (["zip", "tar"].includes(ext)) type = "archive";

      return {
        id: `file-${idx}-${e.name}`,
        name: e.name,
        sizeBytes: e.sizeBytes,
        modifiedTimestamp: e.modifiedTimestamp,
        isDirectory: e.isDirectory,
        type,
      };
    });
    set({ vaultFiles: files, isRefreshingVault: false });
  });

  const dispatchGeminiAction = async (
    action: GeminiVoiceAction
  ): Promise<{ ok: boolean; logTag?: string }> => {
    const p = action.params || {};
    switch (action.type) {
      case "OPEN_APP": {
        const appName = String(p.appName || "");
        if (!appName) return { ok: false };
        const res = await mobilePartnerBridge.openApp(appName);
        return {
          ok: res.success,
          logTag: res.success ? `open_app: ${res.appName}` : `open_app_failed: ${appName}`,
        };
      }
      case "SEARCH_WEB": {
        const q = String(p.query || "");
        const tgt = p.target === "youtube" ? "youtube" : "google";
        const ok = await mobilePartnerBridge.searchWeb(q, tgt);
        return { ok, logTag: `search_${tgt}: ${q}` };
      }
      case "CALL": {
        const num = String(p.phoneNumber || "");
        const ok = await mobilePartnerBridge.makePhoneCall(num, false);
        return { ok, logTag: `mobile_call: ${num}` };
      }
      case "ALARM": {
        const ok = await mobilePartnerBridge.setAlarm(
          Number(p.hour ?? 7),
          Number(p.minutes ?? 0),
          String(p.message || "Lobo Alarm"),
          false
        );
        return { ok, logTag: "mobile_alarm" };
      }
      case "TIMER": {
        const ok = await mobilePartnerBridge.setTimer(
          Number(p.seconds ?? 60),
          String(p.message || "Lobo Timer"),
          false
        );
        return { ok, logTag: "mobile_timer" };
      }
      case "NAVIGATE": {
        const dest = String(p.destination || "");
        const ok = await mobilePartnerBridge.startNavigation(dest, "driving");
        return { ok, logTag: `mobile_nav: ${dest}` };
      }
      case "TORCH": {
        const ok = await mobilePartnerBridge.toggleTorch(Boolean(p.enabled ?? true));
        return { ok, logTag: "mobile_torch" };
      }
      case "RINGER": {
        const mode = String(p.mode || "NORMAL").toUpperCase() as "NORMAL" | "VIBRATE" | "SILENT";
        const ok = await mobilePartnerBridge.setRingerMode(mode);
        return { ok, logTag: `mobile_ringer: ${mode}` };
      }
      case "MEDIA": {
        const cmd = String(p.command || "PLAY_PAUSE").toUpperCase() as
          | "PLAY"
          | "PAUSE"
          | "PLAY_PAUSE"
          | "NEXT"
          | "PREVIOUS";
        const ok = await mobilePartnerBridge.controlMedia(cmd);
        return { ok, logTag: `mobile_media: ${cmd}` };
      }
      case "ADD_HABIT": {
        const title = String(p.title || "").trim();
        if (title) {
          get().addHabit(title);
          return { ok: true, logTag: `add_habit: ${title}` };
        }
        return { ok: false };
      }
      case "COMPLETE_HABIT": {
        const title = String(p.title || "").toLowerCase();
        const found = get().habits.find(
          (h) => h.name.toLowerCase().includes(title) || title.includes(h.name.toLowerCase())
        );
        if (found) {
          if (!found.completed) get().toggleHabit(found.id);
          return { ok: true, logTag: `complete_habit: ${found.name}` };
        }
        return { ok: false };
      }
      case "SAVE_NOTE": {
        const txt = String(p.text || "").trim();
        if (txt) {
          get().setQuickNotes(`• ${txt}\n${get().quickNotes}`.trim());
          return { ok: true, logTag: `save_note: ${txt}` };
        }
        return { ok: false };
      }
      case "WIDGET": {
        const name = String(p.name || "").toLowerCase();
        const w = get().installedWidgets.find((item) =>
          item.manifest.name.toLowerCase().includes(name)
        );
        if (w) {
          await get().setActiveWidget(w.manifest.id);
          return { ok: true, logTag: `switch_widget: ${w.manifest.name}` };
        }
        return { ok: false };
      }
      default:
        return { ok: true };
    }
  };

  robotConnection.onVoiceUtterance(async (wavBytes, pcmBytes) => {
    const durationSec = (pcmBytes.byteLength / 32000).toFixed(1);
    const sizeKb = Math.max(1, Math.round(wavBytes.byteLength / 1024));
    set({ lastVoiceStatus: `Received ${durationSec}s WAV (${sizeKb} KB) from Lobo...` });

    try {
      const turn = await processVoiceWavWithGemini(
        wavBytes,
        {
          habits: get().habits.map((h) => `${h.name}${h.completed ? " (done)" : ""}`),
          widgets: get().installedWidgets.map((w) => w.manifest.name),
          persona: get().subscription.voicePersona,
        },
        get().geminiApiKey
      );

      const foregroundSwitchAction =
        turn.action.type === "OPEN_APP" ||
        turn.action.type === "SEARCH_WEB" ||
        turn.action.type === "NAVIGATE" ||
        turn.action.type === "CALL" ||
        turn.action.type === "ALARM" ||
        turn.action.type === "TIMER";

      let finalReply = turn.spokenReply;
      let deferredActionOutcome: { ok: boolean; logTag?: string } | null = null;

      if (turn.action.type !== "NONE" && !foregroundSwitchAction) {
        const actionOutcome = await dispatchGeminiAction(turn.action);
        if (actionOutcome.logTag) {
          get().addHarnessLog({
            id: `log-hwvoice-${Date.now()}`,
            timestamp: Date.now(),
            title: actionOutcome.logTag,
            risk: "LOW",
            status: actionOutcome.ok ? "EXECUTED" : "DENIED",
            details: turn.transcript,
          });
        }
      }

      set({
        lastVoiceTranscript: turn.transcript,
        lastVoiceStatus: turn.modelUsed
          ? `[${turn.modelUsed}] "${finalReply}"`
          : `Lobo: "${finalReply}"`,
      });

      // Stream spoken TTS audio to robot BEFORE launching another Android app that backgrounds WebView
      const replyPcm = await synthesizeReplyToPcm16(finalReply);
      await robotConnection.streamAudioResponsePcm(replyPcm, turn.emotion);

      if (foregroundSwitchAction) {
        deferredActionOutcome = await dispatchGeminiAction(turn.action);
        if (!deferredActionOutcome.ok && turn.action.type === "OPEN_APP") {
          const fallbackMsg = `Could not find ${String(turn.action.params.appName || "that app")} on this phone.`;
          set({ lastVoiceStatus: fallbackMsg });
          const errPcm = await synthesizeReplyToPcm16(fallbackMsg);
          await robotConnection.streamAudioResponsePcm(errPcm, EmotionId.CURIOUS);
        }
        if (deferredActionOutcome.logTag) {
          get().addHarnessLog({
            id: `log-hwvoice-${Date.now()}`,
            timestamp: Date.now(),
            title: deferredActionOutcome.logTag,
            risk: "LOW",
            status: deferredActionOutcome.ok ? "EXECUTED" : "DENIED",
            details: turn.transcript,
          });
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Voice processing failed";
      set({ lastVoiceStatus: errMsg });
      if (robotConnection.isConnected()) {
        try {
          const shortErr = errMsg.includes("401") || errMsg.includes("403")
            ? "Please check your Gemini API key in Voice settings."
            : "Sorry, Gemini could not reach the server.";
          const errPcm = await synthesizeReplyToPcm16(shortErr);
          await robotConnection.streamAudioResponsePcm(errPcm, EmotionId.FOCUSED);
        } catch {
          // ignore secondary TTS failure
        }
      }
    }
  });

  const initialWidget = BUILTIN_WIDGETS[0]!;

  return {
    activeTab: "HUB",
    setActiveTab: (tab) => set({ activeTab: tab }),

    connectionState: robotConnection.getState(),
    telemetry: robotConnection.getTelemetry(),

    connect: async (preferSimulator = false) => {
      const { harnessHost, harnessPort } = get().wifiProvisionConfig;
      await robotConnection.connect(preferSimulator, harnessHost, harnessPort);
    },

    connectBle: async () => {
      return await robotConnection.connectBluetooth(true);
    },

    connectToHost: async (host: string, port = 8443) => {
      const cleanHost = host.trim() || "petbot.local";
      const ok = await robotConnection.connectWebSocket(cleanHost, port);
      if (ok) {
        set({
          wifiProvisionConfig: {
            ...get().wifiProvisionConfig,
            harnessHost: cleanHost,
            harnessPort: port,
          },
        });
      }
      return ok;
    },

    disconnect: () => {
      robotConnection.disconnect();
    },

    wakeOrPetRobot: async () => {
      return await robotConnection.wakeOrPetRobot();
    },

    setMode: async (mode: RobotMode) => {
      return await robotConnection.requestModeTransition(mode);
    },

    installedWidgets: [...BUILTIN_WIDGETS],
    activeWidgetId: initialWidget.manifest.id,
    previewEmotion: "IDLE",

    setPreviewEmotion: async (emotion: EmotionType) => {
      const emotionMap: Record<EmotionType, EmotionId> = {
        IDLE: EmotionId.IDLE,
        HAPPY: EmotionId.HAPPY,
        CURIOUS: EmotionId.CURIOUS,
        SLEEPY: EmotionId.SLEEPY,
        FOCUSED: EmotionId.FOCUSED,
        SPEAKING: EmotionId.SPEAKING,
        LISTENING: EmotionId.LISTENING,
        ALERT: EmotionId.ALERT,
      };
      const nextMood = emotionMap[emotion] ?? EmotionId.IDLE;
      set((state) => ({
        previewEmotion: emotion,
        activeWidgetId: "widget-pet-face-00",
        telemetry: {
          ...state.telemetry,
          petMood: nextMood,
          activeWidgetId: "widget-pet-face-00",
        },
      }));
      await robotConnection.sendHarnessRpcRequest({
        callId: `expr_${Date.now()}`,
        method: "set_expression",
        params: { emotion },
      });
    },

    setActiveWidget: async (widgetId: string) => {
      const target = get().installedWidgets.find((w) => w.manifest.id === widgetId);
      if (target) {
        set({ activeWidgetId: widgetId });
        await robotConnection.deployWidget(target);
      }
    },

    deployWidget: async (widget: WidgetPackage) => {
      const exists = get().installedWidgets.some((w) => w.manifest.id === widget.manifest.id);
      const updatedList = exists
        ? get().installedWidgets.map((w) => (w.manifest.id === widget.manifest.id ? widget : w))
        : [...get().installedWidgets, widget];

      set({
        installedWidgets: updatedList,
        activeWidgetId: widget.manifest.id,
      });

      return await robotConnection.deployWidget(widget);
    },

    removeWidget: (widgetId: string) => {
      const currentList = get().installedWidgets;
      if (currentList.length <= 1) return; // Retain at least one widget
      const filtered = currentList.filter((w) => w.manifest.id !== widgetId);
      set({
        installedWidgets: filtered,
        activeWidgetId: get().activeWidgetId === widgetId ? filtered[0]!.manifest.id : get().activeWidgetId,
      });
    },

    reorderWidgets: (fromIndex: number, toIndex: number) => {
      const list = [...get().installedWidgets];
      const [moved] = list.splice(fromIndex, 1);
      if (moved) {
        list.splice(toIndex, 0, moved);
        set({ installedWidgets: list });
      }
    },

    // Quick Notes & Daily Habits
    quickNotes: "• Review PR #42 for sub-millisecond protocol serialization\n• Stand up and stretch at 3:00 PM\n• Pet robot for 30s focus boost",
    setQuickNotes: (notes: string) =>
      set((state) => ({
        quickNotes: notes,
        studioState: {
          ...state.studioState,
          simulatorSlots: {
            ...state.studioState.simulatorSlots,
            ...computeSyncedWidgetSlots(state.habits, notes),
          },
        },
      })),

    habits: [
      { id: "h-1", name: "Drink 2.5L Water", completed: true, streak: 8 },
      { id: "h-2", name: "15min Screen Break", completed: true, streak: 5 },
      { id: "h-3", name: "Posture Check", completed: false, streak: 12 },
      { id: "h-4", name: "Deep Work Sprint (45m)", completed: false, streak: 3 },
    ],

    toggleHabit: (id: string) => {
      const target = get().habits.find((h) => h.id === id);
      const nextCompleted = target ? !target.completed : true;
      const nextHabits = get().habits.map((h) =>
        h.id === id
          ? {
              ...h,
              completed: !h.completed,
              streak: !h.completed ? h.streak + 1 : Math.max(0, h.streak - 1),
            }
          : h
      );
      set((state) => ({
        habits: nextHabits,
        studioState: {
          ...state.studioState,
          simulatorSlots: {
            ...state.studioState.simulatorSlots,
            ...computeSyncedWidgetSlots(nextHabits, state.quickNotes),
          },
        },
      }));
      if (target) {
        void robotConnection.sendHarnessRpcRequest({
          callId: `hab_tog_${Date.now()}`,
          method: "habit_manage",
          params: {
            action: nextCompleted ? "complete" : "uncomplete",
            title: target.name,
            navigate: false,
          },
        });
      }
    },

    addHabit: (name: string) => {
      if (!name.trim()) return;
      const cleanName = name.trim();
      const newHabit: HabitItem = {
        id: `h-${Date.now()}`,
        name: cleanName,
        completed: false,
        streak: 0,
      };
      const nextHabits = [...get().habits, newHabit];
      set((state) => ({
        habits: nextHabits,
        studioState: {
          ...state.studioState,
          simulatorSlots: {
            ...state.studioState.simulatorSlots,
            ...computeSyncedWidgetSlots(nextHabits, state.quickNotes),
          },
        },
      }));
      void robotConnection.sendHarnessRpcRequest({
        callId: `hab_add_${Date.now()}`,
        method: "habit_manage",
        params: { action: "add", title: cleanName, navigate: false },
      });
    },

    removeHabit: (id: string) => {
      const target = get().habits.find((h) => h.id === id);
      const nextHabits = get().habits.filter((h) => h.id !== id);
      set((state) => ({
        habits: nextHabits,
        studioState: {
          ...state.studioState,
          simulatorSlots: {
            ...state.studioState.simulatorSlots,
            ...computeSyncedWidgetSlots(nextHabits, state.quickNotes),
          },
        },
      }));
      if (target) {
        void robotConnection.sendHarnessRpcRequest({
          callId: `hab_del_${Date.now()}`,
          method: "habit_manage",
          params: { action: "remove", title: target.name, navigate: false },
        });
      }
    },

    syncNotesAndHabits: async () => {
      // Sync reactive state variables into active widget simulator slots
      const synced = computeSyncedWidgetSlots(get().habits, get().quickNotes);
      set((state) => ({
        studioState: {
          ...state.studioState,
          simulatorSlots: {
            ...state.studioState.simulatorSlots,
            ...synced,
          },
        },
      }));

      // Push real wall-clock time + latest note to hardware robot
      await robotConnection.sendHarnessRpcRequest({
        callId: `clk_sync_${Date.now()}`,
        method: "clock_sync",
        params: {
          unixSec: Math.floor(Date.now() / 1000),
          tzOffsetSec: -new Date().getTimezoneOffset() * 60,
          dateLabel: new Date().toLocaleDateString("en-US", { weekday: "short", day: "2-digit", month: "short" }).toUpperCase(),
        },
      });
      await robotConnection.sendHarnessRpcRequest({
        callId: `note_sync_${Date.now()}`,
        method: "save_note",
        params: {
          action: "add",
          title: "Companion Sync",
          text: get().quickNotes.slice(0, 150),
          pinned: true,
        },
      });

      // Trigger robot ping & chirp feedback
      await robotConnection.wakeOrPetRobot();
    },

    // Magic Studio
    studioState: {
      draftWidget: initialWidget,
      chatHistory: [
        {
          id: "m-welcome",
          sender: "assistant",
          text: "Hi! What would you like your robot to display or automate today? Try saying 'Create a habit tracker for reading' or 'Make an animated pet face that winks when I pet it'.",
          timestamp: Date.now(),
        },
      ],
      undoStack: [],
      redoStack: [],
      simulatorSlots: {
        timeStr: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
        dateStr: new Date()
          .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "2-digit" })
          .toUpperCase(),
        clockLabel: "LOCAL TIME",
        moodScore: 98,
        habitsCompleted: 2,
        habitsTotal: 4,
        habit1: "[x] Drink 2.5L Water",
        habit2: "[x] 15min Screen Break",
        habit3: "[ ] Posture Check",
        note1: "• Review PR #42 for sub-millisecond protocol serialization",
        note2: "• Stand up and stretch at 3:00 PM",
        note3: "• Pet robot for 30s focus boost",
        minutesRemaining: 25,
        cupsDrank: 4,
      },
      isGenerating: false,
    },

    sendStudioPrompt: async (promptText: string) => {
      const current = get().studioState;
      const userMessage: ChatMessage = {
        id: `m-u-${Date.now()}`,
        sender: "user",
        text: promptText,
        timestamp: Date.now(),
      };

      set({
        studioState: {
          ...current,
          chatHistory: [...current.chatHistory, userMessage],
          isGenerating: true,
        },
      });

      try {
        const result = await aiStudioCompiler.generateOrRefine(
          promptText,
          current.draftWidget,
          current.chatHistory
        );

        const botMessage: ChatMessage = {
          id: `m-a-${Date.now()}`,
          sender: "assistant",
          text: result.replyExplanation,
          timestamp: Date.now(),
        };

        const nextSlots: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(result.widget.state || {})) {
          nextSlots[k] = v.initialValue;
        }

        set({
          studioState: {
            ...get().studioState,
            draftWidget: result.widget,
            simulatorSlots: { ...get().studioState.simulatorSlots, ...nextSlots },
            undoStack: [...get().studioState.undoStack, get().studioState.draftWidget],
            redoStack: [],
            chatHistory: [...get().studioState.chatHistory, botMessage],
            isGenerating: false,
          },
        });
      } catch (err) {
        const errorMessage: ChatMessage = {
          id: `m-err-${Date.now()}`,
          sender: "assistant",
          text: "I couldn't complete that adjustment. Try describing what you'd like in another way!",
          timestamp: Date.now(),
        };
        set({
          studioState: {
            ...get().studioState,
            chatHistory: [...get().studioState.chatHistory, errorMessage],
            isGenerating: false,
          },
        });
      }
    },

    setDraftWidget: (widget: WidgetPackage) => {
      const current = get().studioState;
      set({
        studioState: {
          ...current,
          draftWidget: widget,
          undoStack: [...current.undoStack, current.draftWidget],
          redoStack: [],
        },
      });
    },

    undoDraft: () => {
      const current = get().studioState;
      if (current.undoStack.length === 0) return;
      const previous = current.undoStack[current.undoStack.length - 1]!;
      const remainingUndo = current.undoStack.slice(0, -1);
      set({
        studioState: {
          ...current,
          draftWidget: previous,
          undoStack: remainingUndo,
          redoStack: [current.draftWidget, ...current.redoStack],
        },
      });
    },

    redoDraft: () => {
      const current = get().studioState;
      if (current.redoStack.length === 0) return;
      const next = current.redoStack[0]!;
      const remainingRedo = current.redoStack.slice(1);
      set({
        studioState: {
          ...current,
          draftWidget: next,
          undoStack: [...current.undoStack, current.draftWidget],
          redoStack: remainingRedo,
        },
      });
    },

    updateSimulatorSlot: (key: string, value: string | number | boolean) => {
      set({
        studioState: {
          ...get().studioState,
          simulatorSlots: {
            ...get().studioState.simulatorSlots,
            [key]: value,
          },
        },
      });
    },

    // SD Pocket Vault (populated only from connected robot MicroSD or explicit local upload)
    vaultFiles: [],
    isRefreshingVault: false,

    refreshVault: async () => {
      if (!robotConnection.isConnected() && !robotConnection.isSimulatorActive()) {
        set({ isRefreshingVault: false });
        return false;
      }
      set({ isRefreshingVault: true });
      await robotConnection.requestVaultList("/sdcard");
      set({ isRefreshingVault: false });
      return true;
    },

    uploadFileToVault: async (file: File) => {
      if (!robotConnection.isConnected() && !robotConnection.isSimulatorActive()) {
        return false;
      }
      const fileId = `f-up-${Date.now()}`;
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      let detectedType: VaultFileItem["type"] = "other";
      if (["png", "jpg", "jpeg", "webp", "gif", "rgb565"].includes(ext)) detectedType = "image";
      else if (["wav", "mp3", "opus", "pcm", "m4a"].includes(ext)) detectedType = "audio";
      else if (["pdf", "txt", "md", "docx", "csv"].includes(ext)) detectedType = "document";
      else if (["pbwg", "bin", "json", "ts", "js", "cpp", "h"].includes(ext)) detectedType = "code";
      else if (["zip", "tar", "gz", "7z"].includes(ext)) detectedType = "archive";

      const newEntry: VaultFileItem = {
        id: fileId,
        name: file.name,
        sizeBytes: file.size,
        modifiedTimestamp: Math.round(Date.now() / 1000),
        isDirectory: false,
        type: detectedType,
        sha256Hex: "0000000000000000000000000000000000000000000000000000000000000000",
        isTransferring: true,
        transferProgress: 0,
      };

      set({ vaultFiles: [newEntry, ...get().vaultFiles] });

      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      await robotConnection.uploadVaultFile(file.name, bytes, (pct) => {
        set({
          vaultFiles: get().vaultFiles.map((item) =>
            item.id === fileId ? { ...item, transferProgress: pct } : item
          ),
        });
      });

      set({
        vaultFiles: get().vaultFiles.map((item) =>
          item.id === fileId ? { ...item, isTransferring: false, transferProgress: 100 } : item
        ),
      });
      return true;
    },

    deleteVaultFile: (fileId: string) => {
      set({ vaultFiles: get().vaultFiles.filter((item) => item.id !== fileId) });
    },

    // Subscription & Personas
    subscription: {
      tier: "PRO",
      voicePersona: "Nova - Cheerful Cyber Pet",
      voiceAiEnabled: true,
      jwtToken: "mock-pro-jwt-token-petbot",
    },
    wakeMode: "PUSH_TO_TALK",

    setWakeMode: (mode) => set({ wakeMode: mode }),

    setVoicePersona: (persona: string) => {
      set({
        subscription: {
          ...get().subscription,
          voicePersona: persona,
        },
      });
    },

    setVoiceAiEnabled: (enabled: boolean) => {
      set({
        subscription: {
          ...get().subscription,
          voiceAiEnabled: enabled,
        },
      });
    },

    upgradeSubscription: async (tier: "FREE" | "PRO") => {
      set({
        subscription: {
          ...get().subscription,
          tier,
        },
      });
      await robotConnection.syncSubscriptionEntitlement(tier);
    },

    // Desktop Harness Security & Physical 2FA Feed
    harnessLogs: [
      {
        id: "log-1",
        timestamp: Date.now() - 120000,
        title: "Workspace Build & Verification (Turbo)",
        risk: "LOW",
        status: "EXECUTED",
        details: "Clean build 24 packages, zero cache corruption",
      },
      {
        id: "log-2",
        timestamp: Date.now() - 600000,
        title: "Git Commit & Branch Switch",
        risk: "MEDIUM",
        status: "APPROVED",
        details: "Single touch tap verified on robot sensor",
      },
      {
        id: "log-3",
        timestamp: Date.now() - 3600000,
        title: "Docker Desktop Daemon Start",
        risk: "LOW",
        status: "EXECUTED",
        details: "Container daemon healthy on local socket",
      },
    ],

    addHarnessLog: (log: HarnessLogItem) => {
      set({ harnessLogs: [log, ...get().harnessLogs.slice(0, 49)] });
    },

    // Hardware Touch 2FA Modal
    active2FaChallenge: null,

    respondTo2Fa: async (approved: boolean) => {
      const challenge = get().active2FaChallenge;
      if (!challenge) return;
      await robotConnection.respondToTouch2Fa(challenge.challengeId, approved);

      // Log decision to harness feed
      get().addHarnessLog({
        id: `log-${Date.now()}`,
        timestamp: Date.now(),
        title: challenge.actionTitle,
        risk: "HIGH",
        status: approved ? "APPROVED" : "DENIED",
        details: approved
          ? "Hardware Touch 2FA confirmed via capacitive top sensor"
          : "User rejected hardware consent request",
      });

      set({ active2FaChallenge: null });
    },

    // Native Mobile Partner Harness State & Actions
    isMobilePartnerActive: mobileHarnessOrchestrator.isActive(),
    mobileTelemetry: null,

    triggerMobileTakeover: async () => {
      await mobileHarnessOrchestrator.takeoverAsActivePartner("USER_MANUAL_MOBILE_TAKEOVER");
      const telem = await mobilePartnerBridge.getMobileTelemetry();
      set({ isMobilePartnerActive: true, mobileTelemetry: telem });
    },

    yieldMobileToDesktop: async () => {
      await mobileHarnessOrchestrator.yieldToDesktop("USER_YIELD_TO_DESKTOP");
      set({ isMobilePartnerActive: false });
    },

    syncMobilePocketVault: async () => {
      const count = await mobileHarnessOrchestrator.syncPocketVault();
      await get().refreshVault();
      return count;
    },

    refreshMobileTelemetry: async () => {
      const telem = await mobilePartnerBridge.getMobileTelemetry();
      set({ mobileTelemetry: telem });
    },

    // Hardware Ergonomics, Wi-Fi Setup, Android Mirroring & Developer Mode
    devMode: false,
    setDevMode: (enabled: boolean) => set({ devMode: enabled }),

    isProvisionModalOpen: false,
    setProvisionModalOpen: (open: boolean) => set({ isProvisionModalOpen: open }),

    wifiProvisionConfig: {
      ssid: "lobo",
      harnessHost: "petbot.local",
      harnessPort: 8443,
    },

    provisionRobotWifi: async (
      ssid: string,
      password: string,
      harnessHost: string,
      harnessPort: number
    ) => {
      set({
        wifiProvisionConfig: {
          ssid,
          harnessHost,
          harnessPort,
        },
      });
      return robotConnection.sendHarnessRpcRequest({
        callId: `prov_${Date.now()}`,
        method: "robot.provisionWifi",
        params: { ssid, password, host: harnessHost, port: harnessPort },
      });
    },

    hardwareSettings: {
      volumePct: 100,
      brightnessPct: 100,
      nightDimScheduleEnabled: true,
      vadSensitivity: 650,
      silenceReturnSec: 15,
      wakeWordEnabled: true,
      wakeWordPhrase: "Hi ESP",
      sideDoubleTapAction: "AI_BRIEFING",
      diagnosticsOverlayEnabled: false,
    },

    updateHardwareSettings: async (patch: Partial<HardwareSettings>) => {
      const next: HardwareSettings = {
        ...get().hardwareSettings,
        ...patch,
      };
      set({ hardwareSettings: next });

      if (patch.volumePct !== undefined) {
        webAudioSynth.setVolume(Math.max(0, Math.min(1, patch.volumePct / 100)));
      }

      await robotConnection.sendHarnessRpcRequest({
        callId: `hw_${Date.now()}`,
        method: "robot.setHardwareSettings",
        params: {
          volumePct: next.volumePct,
          brightnessPct: next.brightnessPct,
          vadSensitivity: next.vadSensitivity,
          wakeWordEnabled: next.wakeWordEnabled,
          wakeWordPhrase: next.wakeWordPhrase,
          silenceReturnSec: next.silenceReturnSec,
          sideDoubleTapAction: next.sideDoubleTapAction,
        },
      });
    },

    toggleDiagnosticsOverlay: async (enabled: boolean) => {
      set({
        hardwareSettings: {
          ...get().hardwareSettings,
          diagnosticsOverlayEnabled: enabled,
        },
      });
      await robotConnection.sendHarnessRpcRequest({
        callId: `diag_${Date.now()}`,
        method: "robot.setTelemetryOverlay",
        params: { enabled },
      });
    },

    remapPinOverride: async (name: string, gpio: number) => {
      await robotConnection.sendHarnessRpcRequest({
        callId: `pin_${Date.now()}`,
        method: "robot.setPinOverride",
        params: { name, gpio },
      });
    },

    androidMirrorSettings: {
      mirrorCalls: true,
      mirrorWhatsApp: true,
      mirrorCalendar: true,
      mirrorSlack: false,
    },

    geminiApiKey: getSavedGeminiApiKey(),
    setGeminiApiKey: (key: string) => {
      saveGeminiApiKey(key);
      set({ geminiApiKey: key.trim() });
    },
    lastVoiceStatus: null,
    lastVoiceTranscript: null,

    setAndroidMirrorSetting: (key: keyof AndroidMirrorSettings, value: boolean) => {
      set({
        androidMirrorSettings: {
          ...get().androidMirrorSettings,
          [key]: value,
        },
      });
    },

    executeVoiceCommand: async (utterance: string) => {
      const clean = utterance.trim();
      if (!clean) {
        return { spokenText: "I'm listening! Say or type a command.", actions: [] };
      }

      const personaFull = get().subscription.voicePersona;
      const persona: "Nova" | "Atlas" | "Pixel" = personaFull.startsWith("Atlas")
        ? "Atlas"
        : personaFull.startsWith("Pixel")
        ? "Pixel"
        : "Nova";

      const statePatch = {
        activeWidget: get().activeWidgetId,
        habits: get().habits.map((h) => ({
          title: h.name,
          streakDays: h.streak,
          completedToday: h.completed,
        })),
        notes: get().quickNotes
          .split("\n")
          .filter(Boolean)
          .slice(0, 6)
          .map((line, i) => ({
            title: `Note ${i + 1}`,
            body: line.replace(/^•\s*/, ""),
            pinned: i === 0,
          })),
        mobileConnected: get().isMobilePartnerActive,
      };

      const executedActions: string[] = [];

      // 1. Attempt local Gateway Brain when available (500ms fast timeout on mobile)
      try {
        const controller = new AbortController();
        const timerId = setTimeout(() => controller.abort(), 500);
        const res = await fetch("http://127.0.0.1:8787/api/v1/voice/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: clean, persona, statePatch }),
          signal: controller.signal,
        });
        clearTimeout(timerId);

        if (res.ok) {
          const data = (await res.json()) as {
            spokenText: string;
            toolCalls?: Array<{ toolName: string; resultMessage: string; data?: Record<string, any> }>;
            ecosystemState?: {
              habits?: Array<{ title: string; streakDays: number; completedToday: boolean }>;
              notes?: Array<{ title: string; body: string }>;
              activeWidget?: string;
            };
          };

          if (data.ecosystemState?.habits) {
            set({
              habits: data.ecosystemState.habits.map((h, i) => ({
                id: `h-sync-${i}-${h.title.slice(0, 6)}`,
                name: h.title,
                completed: h.completedToday,
                streak: h.streakDays,
              })),
            });
          }

          for (const tc of data.toolCalls ?? []) {
            executedActions.push(`${tc.toolName}: ${tc.resultMessage}`);
            get().addHarnessLog({
              id: `log-voice-${Date.now()}-${executedActions.length}`,
              timestamp: Date.now(),
              title: tc.toolName.replace(/_/g, " "),
              risk: "LOW",
              status: "EXECUTED",
              details: tc.resultMessage,
            });

            // Mirror relevant RPC actions onto physical BLE/WS robot connection & simulator
            if (tc.toolName === "navigate_robot_widget" && tc.data?.["pageId"]) {
              const pageId = String(tc.data["pageId"]);
              await robotConnection.sendHarnessRpcRequest({
                callId: `vnav_${Date.now()}`,
                method: "navigate_widget",
                params: { pageId },
              });
            } else if (tc.toolName === "manage_robot_habit" && tc.data) {
              await robotConnection.sendHarnessRpcRequest({
                callId: `vhab_${Date.now()}`,
                method: "habit_manage",
                params: tc.data,
              });
            } else if (tc.toolName === "control_robot_pomodoro" || tc.toolName === "start_robot_pomodoro_timer") {
              await robotConnection.sendHarnessRpcRequest({
                callId: `vpomo_${Date.now()}`,
                method: "pomodoro_control",
                params: tc.data ?? { action: "start", minutes: 25 },
              });
            } else if (tc.toolName === "save_quick_note_to_robot" && tc.data) {
              const noteText = String(tc.data["text"] ?? "");
              if (noteText) {
                get().setQuickNotes(`• ${noteText}\n${get().quickNotes}`.trim());
              }
              await robotConnection.sendHarnessRpcRequest({
                callId: `vnote_${Date.now()}`,
                method: "save_note",
                params: tc.data,
              });
            } else if (tc.toolName === "trigger_mobile_partner_action" && tc.data) {
              await mobileHarnessOrchestrator.handleRobotRpcRequest({
                callId: `vmob_${Date.now()}`,
                method: String(tc.data["method"] ?? "mobile_toggle_flashlight"),
                params: (tc.data["params"] as Record<string, unknown>) ?? {},
              });
            } else if (tc.toolName === "run_cross_device_automation" && tc.data) {
              await robotConnection.sendHarnessRpcRequest({
                callId: `vauto_${Date.now()}`,
                method: "run_automation",
                params: tc.data,
              });
            }
          }

          return { spokenText: data.spokenText, actions: executedActions };
        }
      } catch {
        // Cloud Gateway unreachable — run seamless local cross-widget fallback below
      }

      // 2. Resilient Offline & Real-Time Cross-Widget + Mobile Execution Fallback
      const lower = clean.toLowerCase();

      // Switch active robot widget
      if (
        lower.includes("open ") ||
        lower.includes("show ") ||
        lower.includes("switch to ") ||
        lower.includes("go to ")
      ) {
        const widgets = get().installedWidgets;
        const target = widgets.find((w) => {
          const wName = w.manifest.name.toLowerCase();
          return (
            lower.includes(wName) ||
            (lower.includes("habit") && wName.includes("habit")) ||
            (lower.includes("clock") && wName.includes("clock")) ||
            (lower.includes("water") || lower.includes("hydrat") ? wName.includes("hydrat") : false) ||
            ((lower.includes("pomodoro") || lower.includes("focus") || lower.includes("timer")) &&
              wName.includes("focus")) ||
            (lower.includes("note") && wName.includes("note"))
          );
        });
        if (target) {
          await get().setActiveWidget(target.manifest.id);
          await robotConnection.sendHarnessRpcRequest({
            callId: `vnav_${Date.now()}`,
            method: "navigate_widget",
            params: { pageId: target.manifest.id },
          });
          executedActions.push(`navigate_robot_widget: ${target.manifest.name}`);
          return {
            spokenText: `Switched display to ${target.manifest.name}.`,
            actions: executedActions,
          };
        }
      }

      if (
        (lower.includes("habit") || lower.includes("daily") || lower.includes("routine") || lower.includes("todo")) &&
        (lower.includes("add") || lower.includes("new") || lower.includes("track"))
      ) {
        const title =
          clean
            .replace(/^(please\s+)?(add|create|track|put)\s+(a\s+|new\s+|this\s+)*(daily\s+)?(task\s+|habit\s+|routine\s+)?/i, "")
            .replace(/\s*(to|in|into|on)\s+(my\s+)?(the\s+)?(daily\s+)?(habit\s+tracker|habits|todo\s+list|to-do|routine).*$/i, "")
            .trim() || "Daily Habit";
        get().addHabit(title);
        executedActions.push(`manage_robot_habit: Added "${title}"`);
        return { spokenText: `Added "${title}" to your Habit Tracker.`, actions: executedActions };
      }

      if (
        lower.includes("complete") ||
        lower.includes("completed") ||
        lower.includes("finished") ||
        lower.includes("mark") ||
        lower.includes("tick")
      ) {
        const match = get().habits.find((h) => {
          const words = h.name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
          return lower.includes(h.name.toLowerCase()) || words.some((w) => lower.includes(w));
        });
        if (match) {
          if (!match.completed) get().toggleHabit(match.id);
          executedActions.push(`manage_robot_habit: Marked "${match.name}" complete`);
          return {
            spokenText: `Marked "${match.name}" complete in your Habit Tracker.`,
            actions: executedActions,
          };
        }
      }

      if (lower.includes("flashlight") || lower.includes("torch")) {
        const enabled = !lower.includes("off");
        await mobileHarnessOrchestrator.handleRobotRpcRequest({
          callId: `mob_fl_${Date.now()}`,
          method: "mobile_toggle_flashlight",
          params: { enabled },
        });
        executedActions.push(`mobile_toggle_flashlight: ${enabled ? "ON" : "OFF"}`);
        return {
          spokenText: `Turned phone flashlight ${enabled ? "on" : "off"}.`,
          actions: executedActions,
        };
      }

      if (lower.includes("alarm")) {
        const tm = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
        let hour = tm ? parseInt(tm[1]!, 10) : 7;
        const minutes = tm && tm[2] ? parseInt(tm[2]!, 10) : 0;
        if (tm?.[3] === "pm" && hour < 12) hour += 12;
        if (tm?.[3] === "am" && hour === 12) hour = 0;
        await mobileHarnessOrchestrator.handleRobotRpcRequest({
          callId: `mob_alm_${Date.now()}`,
          method: "mobile_set_alarm",
          params: { hour, minutes, message: "Lobo Alarm" },
        });
        executedActions.push(`mobile_set_alarm: ${hour}:${String(minutes).padStart(2, "0")}`);
        return {
          spokenText: `Opening clock to set alarm for ${hour}:${String(minutes).padStart(2, "0")}.`,
          actions: executedActions,
        };
      }

      if (lower.includes("silent") || lower.includes("vibrate") || lower.includes("ring")) {
        const mode = lower.includes("silent")
          ? "SILENT"
          : lower.includes("vibrate")
          ? "VIBRATE"
          : "NORMAL";
        await mobileHarnessOrchestrator.handleRobotRpcRequest({
          callId: `mob_ring_${Date.now()}`,
          method: "mobile_set_ringer",
          params: { mode },
        });
        executedActions.push(`mobile_set_ringer: ${mode}`);
        return {
          spokenText: `Updated phone ringer mode to ${mode.toLowerCase()}.`,
          actions: executedActions,
        };
      }

      if (lower.includes("navigate to ") || lower.includes("directions to ")) {
        const destination = clean.replace(/.*?(navigate to|directions to)\s+/i, "").trim();
        await mobileHarnessOrchestrator.handleRobotRpcRequest({
          callId: `mob_nav_${Date.now()}`,
          method: "mobile_start_nav",
          params: { destination, mode: "driving" },
        });
        executedActions.push(`mobile_start_nav: ${destination}`);
        return {
          spokenText: `Opening navigation to ${destination}.`,
          actions: executedActions,
        };
      }

      if (lower.includes("timer") || lower.includes("pomodoro") || lower.includes("focus")) {
        const m = lower.match(/(\d+)\s*(?:minute|min)/);
        const minutes = m ? parseInt(m[1]!, 10) : 25;
        const focusWidget = get().installedWidgets.find((w) =>
          w.manifest.name.toLowerCase().includes("focus")
        );
        if (focusWidget) {
          await get().setActiveWidget(focusWidget.manifest.id);
        }
        await robotConnection.sendHarnessRpcRequest({
          callId: `vpomo_${Date.now()}`,
          method: "pomodoro_control",
          params: { action: "start", minutes, navigate: true },
        });
        executedActions.push(`control_robot_pomodoro: Started ${minutes}m focus`);
        return {
          spokenText: `Started a ${minutes}-minute focus timer on Lobo.`,
          actions: executedActions,
        };
      }

      if (lower.includes("note") || lower.includes("remember")) {
        const txt = clean.replace(/^(please\s+)?(save\s+a\s+note|remember|write\s+down)[:\s]*/i, "").trim() || clean;
        const updatedNotes = `• ${txt}\n${get().quickNotes}`.trim();
        get().setQuickNotes(updatedNotes);
        await robotConnection.sendHarnessRpcRequest({
          callId: `vnote_${Date.now()}`,
          method: "save_note",
          params: { action: "add", title: "Voice Note", text: txt },
        });
        executedActions.push(`save_quick_note_to_robot: "${txt}"`);
        return { spokenText: `Saved note "${txt}" to your robot.`, actions: executedActions };
      }

      if (lower.includes("briefing") || lower.includes("run ")) {
        const scriptName = clean.replace(/^run\s+/i, "").trim();
        await robotConnection.sendHarnessRpcRequest({
          callId: `vauto_${Date.now()}`,
          method: "run_automation",
          params: { scriptName },
        });
        executedActions.push(`run_automation: ${scriptName}`);
        return {
          spokenText: `Triggered automation "${scriptName}".`,
          actions: executedActions,
        };
      }

      // Open any phone app ("open youtube", "launch whatsapp", "open settings", etc.)
      if (/^(please\s+)?(open|launch|start)\s+/i.test(lower)) {
        const appName = clean.replace(/^(please\s+)?(open|launch|start)\s+/i, "").trim();
        if (appName) {
          const openRes = await mobilePartnerBridge.openApp(appName);
          if (openRes.success) {
            executedActions.push(`open_app: ${openRes.appName ?? appName}`);
            return {
              spokenText: `Opening ${openRes.appName ?? appName} on your phone.`,
              actions: executedActions,
            };
          }
          return {
            spokenText: openRes.error ?? `Could not find app "${appName}" on your phone.`,
            actions: executedActions,
          };
        }
      }

      // Web or YouTube search
      if (/^(please\s+)?(search|google|look up|youtube|play)\s+/i.test(lower)) {
        const isYoutube = lower.includes("youtube") || lower.startsWith("play ");
        const query = clean
          .replace(/^(please\s+)?(search|google|look up|youtube|play)\s+/i, "")
          .replace(/\s+on\s+(youtube|google)$/i, "")
          .trim();
        if (query) {
          const ok = await mobilePartnerBridge.searchWeb(query, isYoutube ? "youtube" : "google");
          if (ok) {
            executedActions.push(`search_${isYoutube ? "youtube" : "google"}: ${query}`);
            return {
              spokenText: `Searching ${isYoutube ? "YouTube" : "Google"} for "${query}".`,
              actions: executedActions,
            };
          }
        }
      }

      // Direct phone call / dialer ("call +1..." or "dial ...")
      if (/^(please\s+)?(call|dial)\s+/i.test(lower)) {
        const targetNum = clean.replace(/^(please\s+)?(call|dial)\s+/i, "").trim();
        if (targetNum) {
          const ok = await mobilePartnerBridge.makePhoneCall(targetNum, false);
          if (ok) {
            executedActions.push(`mobile_call: ${targetNum}`);
            return {
              spokenText: `Opening dialer for ${targetNum}.`,
              actions: executedActions,
            };
          }
        }
      }

      // Direct Gemini API Intelligence when API key is configured
      const apiKey = get().geminiApiKey;
      if (apiKey) {
        try {
          const gemTurn = await processTextWithGemini(
            clean,
            {
              habits: get().habits.map((h) => `${h.name}${h.completed ? " (done)" : ""}`),
              widgets: get().installedWidgets.map((w) => w.manifest.name),
              persona: get().subscription.voicePersona,
            },
            apiKey
          );
          if (gemTurn) {
            if (gemTurn.action.type !== "NONE") {
              const resAction = await dispatchGeminiAction(gemTurn.action);
              if (resAction.logTag) executedActions.push(resAction.logTag);
              if (!resAction.ok && gemTurn.action.type === "OPEN_APP") {
                return {
                  spokenText: `Could not open ${String(gemTurn.action.params.appName || "that app")}.`,
                  actions: executedActions,
                };
              }
            }
            if (robotConnection.isConnected()) {
              const pcm = await synthesizeReplyToPcm16(gemTurn.spokenReply);
              void robotConnection.streamAudioResponsePcm(pcm, gemTurn.emotion);
            }
            return {
              spokenText: gemTurn.spokenReply,
              actions: executedActions,
            };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Gemini request failed";
          return {
            spokenText: `Gemini error: ${msg}`,
            actions: executedActions,
          };
        }
      }

      return {
        spokenText: `Could not match "${clean}" to a phone app or built-in action. Add your Gemini API key in Voice settings for full AI answers.`,
        actions: executedActions,
      };
    },
  };
});
