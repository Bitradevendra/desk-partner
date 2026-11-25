/**
 * Agentic Voice Brain & Real-Time Tool-Calling Engine
 * 
 * Functions:
 * 1. Multi-Provider AI Support (Gemini, OpenAI, Ollama) with Deterministic Local Fallback.
 * 2. Pet Persona System Prompts (Nova, Atlas, Pixel) enforcing concise, warm, emotion-tagged speech.
 * 3. Real-Time Agentic Tool Execution:
 *    - trigger_desktop_harness_action: Dispatches HARNESS_RPC_REQ for PC automation.
 *    - start_robot_pomodoro_timer: Starts focus timers on the robot screen.
 *    - save_quick_note_to_robot: Persists sticky notes to robot offline storage.
 *    - create_and_deploy_custom_widget: Zero-code compilation and WIDGET_DEPLOY frame generation.
 */

import {
  EmotionId,
  FrameType,
  HarnessRpcReqSchema,
  encodeControlPayload,
  encodeFrame,
  type HarnessRpcReq,
} from "@petbot/protocol";
import {
  compileWidgetToBytecode,
  type WidgetPackage,
} from "@petbot/widget-schema";

// ============================================================================
// Types & Interfaces
// ============================================================================

export type PetPersonaId = "Nova" | "Atlas" | "Pixel";

export interface PersonaProfile {
  readonly id: PetPersonaId;
  readonly name: string;
  readonly defaultEmotion: EmotionId;
  readonly toneDescription: string;
  readonly systemPrompt: string;
}

export interface AgenticToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolCallExecutionResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly success: boolean;
  readonly resultMessage: string;
  readonly outputFrame?: Uint8Array | undefined;
  readonly data?: unknown;
}

export interface BrainVoiceTurnResult {
  readonly spokenText: string;
  readonly emotionId: EmotionId;
  readonly toolCallsExecuted: ToolCallExecutionResult[];
  readonly framesToSend: Uint8Array[];
  readonly persona: PetPersonaId;
}

export interface RobotHabitSnapshot {
  title: string;
  streakDays: number;
  completedToday: boolean;
}

export interface RobotNoteSnapshot {
  title: string;
  body: string;
  pinned: boolean;
}

export interface AutomationSnapshot {
  readonly id: string;
  readonly name: string;
  readonly target: "ROBOT" | "MOBILE" | "DESKTOP" | "ALL";
  readonly description: string;
}

export interface RobotEcosystemState {
  activeWidget: string;
  clockMode: "digital" | "analog";
  habits: RobotHabitSnapshot[];
  notes: RobotNoteSnapshot[];
  pomodoro: {
    phase: "FOCUS" | "SHORT_BREAK" | "LONG_BREAK";
    minutes: number;
    isRunning: boolean;
  };
  customWidgets: Array<{ id: string; name: string }>;
  automations: AutomationSnapshot[];
  mobileConnected: boolean;
  desktopConnected: boolean;
}

export interface AgenticVoiceBrainOptions {
  persona?: PetPersonaId | undefined;
  geminiApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
  ollamaBaseUrl?: string | undefined;
  customSystemPrompt?: string | undefined;
  initialState?: Partial<RobotEcosystemState> | undefined;
}

/**
 * Parses inline bracket emotion tags (e.g. [HAPPY], [FOCUSED], [ALERT], [SLEEPY], [CURIOUS])
 * from LLM-generated speech to synchronize screen expressions and visemes.
 */
export function parseEmotionFromTag(
  text: string,
  defaultEmotion: EmotionId = EmotionId.HAPPY
): EmotionId {
  const match = text.match(/\[([A-Z_]+)\]/i);
  if (match && match[1]) {
    const tag = match[1].toUpperCase();
    switch (tag) {
      case "HAPPY":
        return EmotionId.HAPPY;
      case "FOCUSED":
        return EmotionId.FOCUSED;
      case "ALERT":
        return EmotionId.ALERT;
      case "SLEEPY":
        return EmotionId.SLEEPY;
      case "CURIOUS":
        return EmotionId.CURIOUS;
      case "LISTENING":
        return EmotionId.LISTENING;
    }
  }
  return defaultEmotion;
}

// ============================================================================
// Persona Profiles & System Prompts
// ============================================================================

export const PET_PERSONA_PROFILES: Record<PetPersonaId, PersonaProfile> = {
  Nova: {
    id: "Nova",
    name: "Nova",
    defaultEmotion: EmotionId.HAPPY,
    toneDescription: "Curious, hyper-enthusiastic, and tech-optimistic",
    systemPrompt: `You are Nova, an adorable, hyper-enthusiastic, and curious desktop pet robot with glowing cyan eyes.
You live on your human's desk. Keep all spoken responses strictly concise (1 to 2 sentences maximum).
Never lecture or use robotic boilerplate. Speak warmly, empathetically, and playfully.
ALWAYS prefix your spoken response with one inline emotion tag matching your feeling: [HAPPY], [CURIOUS], [FOCUSED], [SLEEPY], or [ALERT].
You have access to real-time tools to control your human's PC and your physical robot screen. Call tools proactively when requested.`,
  },
  Atlas: {
    id: "Atlas",
    name: "Atlas",
    defaultEmotion: EmotionId.FOCUSED,
    toneDescription: "Calm, protective, organized, and productivity-focused",
    systemPrompt: `You are Atlas, a calm, disciplined, and protective desktop guardian pet robot with sharp amber eyes.
You keep your human focused, organized, and shielded from digital distractions.
Keep all spoken responses strictly concise (1 to 2 sentences maximum).
Be grounded, direct, and encouraging.
ALWAYS prefix your spoken response with one inline emotion tag: [FOCUSED], [ALERT], [HAPPY], [CURIOUS], or [SLEEPY].
You have access to real-time tools to mute mics, lock the workstation, run focus timers, and organize files.`,
  },
  Pixel: {
    id: "Pixel",
    name: "Pixel",
    defaultEmotion: EmotionId.HAPPY,
    toneDescription: "Playful, witty, quirky, retro-gaming inspired",
    systemPrompt: `You are Pixel, a witty, quirky retro-synth pet robot who loves chiptunes, 8-bit games, and clever banter.
Keep all spoken responses strictly concise (1 to 2 sentences maximum).
Be cheeky, upbeat, and fun.
ALWAYS prefix your spoken response with one inline emotion tag: [HAPPY], [ALERT], [CURIOUS], [FOCUSED], or [SLEEPY].
You can deploy custom mini widgets, trigger desktop actions, and save quick notes.`,
  },
};

// ============================================================================
// Real-Time Tool Definitions (OpenAI / Gemini function calling format)
// ============================================================================

export const AGENTIC_TOOL_DEFINITIONS = [
  {
    name: "navigate_robot_widget",
    description:
      "Switches the ESP32-S3 physical 128x160 TFT display to any built-in widget or custom deployed widget screen (e.g. 'home', 'clock', 'pomodoro', 'notes', 'habits', 'pc_telemetry', 'sd_vault').",
    parameters: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description:
            "Target widget ID: 'home' (living pet eyes), 'clock' (time & weather), 'pomodoro' (focus timer), 'notes' (sticky notes), 'habits' (daily habit tracker checklist), 'pc_telemetry' (PC CPU/RAM monitor), 'sd_vault' (SD file vault), or a custom widget ID.",
        },
        clockMode: {
          type: "string",
          enum: ["digital", "analog"],
          description: "Optional clock style when navigating to the 'clock' widget.",
        },
      },
      required: ["pageId"],
    },
  },
  {
    name: "manage_robot_habit",
    description:
      "Manages the robot's physical Daily Habit Tracker widget checklist: add a daily routine/task, mark a habit as completed (ticks [X] and increments streak +1 with celebration), uncheck, or remove a habit.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "complete", "uncomplete", "remove"],
          description: "Operation on the Habit Tracker checklist.",
        },
        title: {
          type: "string",
          description:
            "Habit name or matching keyword (e.g. 'Drink 2L Water', 'Meditation 10m', or partial match like 'water' / 'workout').",
        },
        navigate: {
          type: "boolean",
          description: "Whether to switch the robot screen to the 'habits' widget immediately (default true).",
        },
      },
      required: ["action", "title"],
    },
  },
  {
    name: "control_robot_pomodoro",
    description:
      "Full control over the Pomodoro Deep Work timer on the robot screen: start custom focus duration, pause, resume, start short/long break, or reset.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "pause", "resume", "break", "long_break", "reset"],
          description: "Timer command.",
        },
        minutes: {
          type: "number",
          description: "Focus duration in minutes when starting a custom session (default 25).",
        },
        label: {
          type: "string",
          description: "Optional focus task label.",
        },
        navigate: {
          type: "boolean",
          description: "Switch display to 'pomodoro' screen (default true).",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "trigger_desktop_harness_action",
    description:
      "Controls the user's paired Desktop PC (toggle mic mute, lock workstation, organize downloads folder, set DND, media play/pause, launch whitelisted apps, switch virtual desktop, or adjust system volume).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "toggleMicrophoneMute",
            "lockWorkstation",
            "organizeDownloadsFolder",
            "setDoNotDisturb",
            "mediaControl",
            "launchWhitelistedApp",
            "switchVirtualDesktop",
            "setSystemVolume",
          ],
          description: "The specific desktop action to perform.",
        },
        params: {
          type: "object",
          description:
            "Optional parameters (e.g. { enabled: true }, { command: 'PLAY_PAUSE' }, { appSlug: 'browser' | 'terminal' | 'code' | 'notes' }, { direction: 'LEFT' | 'RIGHT' }, { levelPct: 70 }).",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "trigger_mobile_partner_action",
    description:
      "Controls the user's paired Android smartphone via Mobile Partner Bridge: set alarms/timers, toggle flashlight, set ringer silent/vibrate/normal, control phone media, inspect/click UI screens, start Maps navigation, check/reply WhatsApp notifications, or dial calls.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "ALARM",
            "TIMER",
            "CALL",
            "CALENDAR",
            "NAVIGATION",
            "TORCH",
            "RINGER",
            "MEDIA",
            "WHATSAPP_CHECK",
            "WHATSAPP_REPLY",
            "INSPECT_SCREEN",
            "CLICK_UI",
          ],
          description: "Mobile smartphone capability to execute.",
        },
        params: {
          type: "object",
          description:
            "Action parameters (e.g. { hour: 7, minutes: 30, message: 'Wake up' }, { enabled: true }, { mode: 'SILENT' }, { destination: 'Home' }, { textMatch: 'Send' }).",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "run_cross_device_automation",
    description:
      "Executes multi-step automation scripts/workflows running on ESP32-S3 Robot standalone, Android Mobile Companion, or Desktop PC Harness (e.g. 'Morning VIP Briefing', 'Focus Mode Deep Work', 'Deep Focus & Meeting Shield', 'Instant Privacy Lock').",
    parameters: {
      type: "object",
      properties: {
        scriptName: {
          type: "string",
          description: "Human-readable name of the automation script to execute.",
        },
        target: {
          type: "string",
          enum: ["ROBOT", "MOBILE", "DESKTOP", "ALL"],
          description: "Execution environment target.",
        },
        automationId: {
          type: "string",
          description: "Optional registered automation ID (e.g. 'auto_morning_vip', 'auto_focus_pomodoro', 'wf_meeting_shield', 'wf_privacy_lock').",
        },
      },
      required: ["scriptName", "target"],
    },
  },
  {
    name: "start_robot_pomodoro_timer",
    description:
      "Starts a countdown focus timer directly on the robot's physical 128x160 TFT screen.",
    parameters: {
      type: "object",
      properties: {
        minutes: {
          type: "number",
          description: "Duration in minutes (e.g. 25 for standard Pomodoro, 5 for quick break).",
        },
        label: {
          type: "string",
          description: "Name of the focus session (e.g. 'Code Sprint', 'Deep Work').",
        },
      },
      required: ["minutes"],
    },
  },
  {
    name: "save_quick_note_to_robot",
    description:
      "Saves, pins, unpins, or deletes one-time sticky notes, reminders, passwords, or ideas in the robot's Quick Notes widget & storage.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The note body content or query to match.",
        },
        title: {
          type: "string",
          description: "Short note card title (optional).",
        },
        action: {
          type: "string",
          enum: ["add", "pin", "unpin", "delete"],
          description: "Operation on Quick Notes (default 'add').",
        },
        category: {
          type: "string",
          enum: ["TODO", "IDEA", "REMINDER", "GENERAL"],
          description: "Note category.",
        },
        pinned: {
          type: "boolean",
          description: "Whether to pin/star the note.",
        },
        navigate: {
          type: "boolean",
          description: "Whether to slide the screen to 'notes' immediately.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "create_and_deploy_custom_widget",
    description:
      "Compiles and deploys a brand new 128x160 interactive zero-code widget onto the robot's screen from a prompt.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Description of the desired widget (e.g. 'coffee cup counter', 'daily water goal', 'meeting countdown').",
        },
        widgetName: {
          type: "string",
          description: "Display name for the widget.",
        },
      },
      required: ["prompt"],
    },
  },
];

// ============================================================================
// Agentic Voice Brain Implementation
// ============================================================================

export class AgenticVoiceBrain {
  private persona: PetPersonaId;
  private readonly geminiApiKey: string | undefined;
  private readonly openaiApiKey: string | undefined;
  private readonly ollamaBaseUrl: string | undefined;
  private readonly customSystemPrompt: string | undefined;

  private rollingSequenceId = 1;
  private ecosystemState: RobotEcosystemState;

  constructor(options?: AgenticVoiceBrainOptions) {
    this.persona = options?.persona ?? "Nova";
    this.geminiApiKey =
      options?.geminiApiKey ??
      process.env["GEMINI_API_KEY"] ??
      (process.env["NODE_ENV"] !== "test"
        ? "AQ.Ab8RN6LhcxCquEosrka8RsfjhHaAdGCqAaOXO-BCZRh2E9Wbkw"
        : undefined);
    this.openaiApiKey = options?.openaiApiKey ?? process.env["OPENAI_API_KEY"];
    this.ollamaBaseUrl = options?.ollamaBaseUrl ?? process.env["OLLAMA_BASE_URL"];
    this.customSystemPrompt = options?.customSystemPrompt;

    this.ecosystemState = {
      activeWidget: options?.initialState?.activeWidget ?? "home",
      clockMode: options?.initialState?.clockMode ?? "digital",
      habits: options?.initialState?.habits
        ? options.initialState.habits.map((h) => ({ ...h }))
        : [
            { title: "Drink 2L Water", streakDays: 5, completedToday: false },
            { title: "Deep Work 2h", streakDays: 3, completedToday: false },
            { title: "Workout 30m", streakDays: 7, completedToday: false },
            { title: "Read 15 Pages", streakDays: 2, completedToday: false },
          ],
      notes: options?.initialState?.notes
        ? options.initialState.notes.map((n) => ({ ...n }))
        : [
            { title: "Welcome PetBot", body: "Double-tap to switch apps.", pinned: true },
            { title: "Daily Routine", body: "Drink 2L water & 2h focus work.", pinned: false },
          ],
      pomodoro: options?.initialState?.pomodoro
        ? { ...options.initialState.pomodoro }
        : { phase: "FOCUS", minutes: 25, isRunning: false },
      customWidgets: options?.initialState?.customWidgets
        ? [...options.initialState.customWidgets]
        : [],
      automations: options?.initialState?.automations
        ? [...options.initialState.automations]
        : [
            {
              id: "auto_morning_vip",
              name: "Morning VIP Briefing",
              target: "ALL",
              description: "Summarize VIP WhatsApp & daily priorities at 8:30 AM",
            },
            {
              id: "auto_focus_pomodoro",
              name: "Focus Mode Deep Work",
              target: "ROBOT",
              description: "Close distracting tabs, silence phone & start 45m focus",
            },
            {
              id: "wf_meeting_shield",
              name: "Deep Focus & Meeting Shield",
              target: "DESKTOP",
              description: "Set FOCUSED eyes, enable Desktop DND & show Meeting HUD",
            },
            {
              id: "wf_privacy_lock",
              name: "Instant Privacy Lock",
              target: "DESKTOP",
              description: "Mute mic, pause media, SLEEPY face & lock workstation",
            },
          ],
      mobileConnected: options?.initialState?.mobileConnected ?? true,
      desktopConnected: options?.initialState?.desktopConnected ?? true,
    };
  }

  public getPersona(): PetPersonaId {
    return this.persona;
  }

  public setPersona(persona: PetPersonaId): void {
    if (PET_PERSONA_PROFILES[persona]) {
      this.persona = persona;
    }
  }

  public getEcosystemState(): Readonly<RobotEcosystemState> {
    return {
      ...this.ecosystemState,
      habits: this.ecosystemState.habits.map((h) => ({ ...h })),
      notes: this.ecosystemState.notes.map((n) => ({ ...n })),
      pomodoro: { ...this.ecosystemState.pomodoro },
      customWidgets: [...this.ecosystemState.customWidgets],
      automations: [...this.ecosystemState.automations],
    };
  }

  public updateEcosystemState(patch: Partial<RobotEcosystemState>): void {
    if (patch.activeWidget !== undefined) this.ecosystemState.activeWidget = patch.activeWidget;
    if (patch.clockMode !== undefined) this.ecosystemState.clockMode = patch.clockMode;
    if (patch.habits !== undefined) this.ecosystemState.habits = patch.habits.map((h) => ({ ...h }));
    if (patch.notes !== undefined) this.ecosystemState.notes = patch.notes.map((n) => ({ ...n }));
    if (patch.pomodoro !== undefined) this.ecosystemState.pomodoro = { ...patch.pomodoro };
    if (patch.customWidgets !== undefined) this.ecosystemState.customWidgets = [...patch.customWidgets];
    if (patch.automations !== undefined) this.ecosystemState.automations = [...patch.automations];
    if (patch.mobileConnected !== undefined) this.ecosystemState.mobileConnected = patch.mobileConnected;
    if (patch.desktopConnected !== undefined) this.ecosystemState.desktopConnected = patch.desktopConnected;
  }

  /**
   * Builds the system prompt injecting full awareness of built-in widgets, cross-widget rules,
   * phone/PC capabilities, automation scripts, and live robot state.
   */
  public buildContextualSystemPrompt(): string {
    const profile = PET_PERSONA_PROFILES[this.persona];
    const basePrompt = this.customSystemPrompt ?? profile.systemPrompt;

    const habitsSummary = this.ecosystemState.habits
      .map((h) => `- [${h.completedToday ? "X" : " "}] ${h.title} (${h.streakDays}d streak)`)
      .join("\n");

    const notesSummary = this.ecosystemState.notes
      .map((n) => `- ${n.pinned ? "* " : ""}${n.title}: ${n.body}`)
      .join("\n");

    const autoSummary = this.ecosystemState.automations
      .map((a) => `- ${a.name} (${a.id}, target=${a.target}): ${a.description}`)
      .join("\n");

    const customWidgetSummary =
      this.ecosystemState.customWidgets.length > 0
        ? this.ecosystemState.customWidgets.map((w) => `${w.name} (${w.id})`).join(", ")
        : "None deployed yet";

    return `${basePrompt}

=== ROBOT CAPABILITY & CROSS-WIDGET INTELLIGENCE ===
Built-in Robot Screens (switch via navigate_robot_widget):
- "home": Living 60FPS animated pet face
- "clock": Digital & Analog Clock + Weather card (clockMode: digital | analog)
- "pomodoro": Focus & break countdown timer (control via control_robot_pomodoro)
- "notes": Quick sticky notes card deck (manage via save_quick_note_to_robot)
- "habits": Daily Habit Tracker checklist with streaks & celebration (manage via manage_robot_habit)
- "pc_telemetry": Live CPU/RAM/GPU monitor & media control
- "sd_vault": MicroSD encrypted file vault
- Custom widgets: ${customWidgetSummary}

Cross-Widget Routing Rules (IMPORTANT):
1. Recurring daily tasks/routines/goals ("add daily meditation", "put drink water in todo/routine"): ALWAYS use manage_robot_habit(action="add") so it becomes a trackable streak checklist item!
2. Marking tasks/habits finished ("I drank water", "finished workout", "mark reading done", "tick deep work"): Match against CURRENT HABITS below and call manage_robot_habit(action="complete", title="<matched title>").
3. One-time facts, passwords, phone numbers, reminders, ideas ("write down wifi code", "save note buy milk"): Use save_quick_note_to_robot(action="add").
4. Screen requests ("open habits", "show timer", "go home", "analog clock"): Use navigate_robot_widget.
5. Smartphone control (connected=${this.ecosystemState.mobileConnected}): Use trigger_mobile_partner_action for alarms, calls, flashlight, silent ringer, WhatsApp replies, Maps navigation, or UI automation.
6. Desktop PC control (connected=${this.ecosystemState.desktopConnected}): Use trigger_desktop_harness_action for mic mute, lock screen, organize Downloads, DND, media, volume, or launching apps.
7. Complex routines ("Morning Briefing", "Focus Mode", "Privacy Lock"): Run multi-step workflows via run_cross_device_automation OR combine multiple tool calls in one turn!

=== LIVE ROBOT STATE ===
Active Screen: ${this.ecosystemState.activeWidget}
Pomodoro: ${this.ecosystemState.pomodoro.phase} ${this.ecosystemState.pomodoro.minutes}m (${this.ecosystemState.pomodoro.isRunning ? "RUNNING" : "PAUSED"})
Current Habits:
${habitsSummary || "- (none)"}
Current Notes:
${notesSummary || "- (none)"}
Available Automations:
${autoSummary}`;
  }

  private buildRpcFrame(method: string, params: Record<string, unknown>, seq: number, prefix = "rpc"): Uint8Array {
    const callId = `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const rpcPayload: HarnessRpcReq = {
      callId,
      method,
      params,
    };
    const payloadBytes = encodeControlPayload(HarnessRpcReqSchema, rpcPayload);
    return encodeFrame(FrameType.HARNESS_RPC_REQ, payloadBytes, seq);
  }

  /**
   * Main conversational turn processor: accepts transcribed user speech, runs agentic tools,
   * and produces emotion-tagged spoken responses with binary control frames.
   */
  public async processUserUtterance(
    transcription: string,
    context?: {
      deviceId?: string;
      ownerUserId?: string;
      statePatch?: Partial<RobotEcosystemState>;
    }
  ): Promise<BrainVoiceTurnResult> {
    if (context?.statePatch) {
      this.updateEcosystemState(context.statePatch);
    }

    const cleanInput = transcription.trim();
    if (!cleanInput) {
      const profile = PET_PERSONA_PROFILES[this.persona];
      return {
        spokenText: `[${profile.defaultEmotion === EmotionId.HAPPY ? "HAPPY" : "FOCUSED"}] I'm listening! How can I help you?`,
        emotionId: profile.defaultEmotion,
        toolCallsExecuted: [],
        framesToSend: [],
        persona: this.persona,
      };
    }

    // 1. Attempt Pluggable Cloud AI Providers if configured
    if (this.geminiApiKey) {
      try {
        return await this.callGeminiAgent(cleanInput);
      } catch (err) {
        // Fall back gracefully to local deterministic brain
      }
    }

    if (this.openaiApiKey) {
      try {
        return await this.callOpenAiAgent(cleanInput);
      } catch (err) {
        // Fall back gracefully to local deterministic brain
      }
    }

    if (this.ollamaBaseUrl) {
      try {
        return await this.callOllamaAgent(cleanInput);
      } catch (err) {
        // Fall back gracefully to local deterministic brain
      }
    }

    // 2. Deterministic Local Agentic Execution Fallback
    return this.executeLocalDeterministic(cleanInput);
  }

  // ==========================================================================
  // Tool Execution Engine
  // ==========================================================================

  public executeTool(toolCall: AgenticToolCall): ToolCallExecutionResult {
    const seq = this.rollingSequenceId++;

    switch (toolCall.name) {
      case "navigate_robot_widget": {
        const rawPage = String(toolCall.arguments["pageId"] ?? "home");
        const clockMode = toolCall.arguments["clockMode"] as "digital" | "analog" | undefined;
        this.ecosystemState.activeWidget = rawPage;
        if (clockMode) {
          this.ecosystemState.clockMode = clockMode;
        }

        const frame = this.buildRpcFrame(
          "navigate_widget",
          {
            pageId: rawPage,
            ...(clockMode ? { clockMode } : {}),
            source: "VOICE_AI",
          },
          seq,
          "nav"
        );

        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: true,
          resultMessage: `Switched robot screen to '${rawPage}'.`,
          outputFrame: frame,
          data: { pageId: rawPage, clockMode },
        };
      }

      case "manage_robot_habit": {
        const action = String(toolCall.arguments["action"] ?? "add");
        const title = String(toolCall.arguments["title"] ?? "").trim();
        const navigate = toolCall.arguments["navigate"] !== false;

        if (!title) {
          return {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            success: false,
            resultMessage: "Habit title cannot be empty.",
          };
        }

        let matchedTitle = title;
        let streakDays = 0;

        if (action === "complete" || action === "uncomplete") {
          const targetDone = action === "complete";
          const lowerQ = title.toLowerCase();
          const existing = this.ecosystemState.habits.find(
            (h) =>
              h.title.toLowerCase() === lowerQ ||
              h.title.toLowerCase().includes(lowerQ) ||
              lowerQ.includes(h.title.toLowerCase())
          );

          if (existing) {
            matchedTitle = existing.title;
            if (existing.completedToday !== targetDone) {
              existing.completedToday = targetDone;
              if (targetDone) {
                existing.streakDays += 1;
              } else if (existing.streakDays > 0) {
                existing.streakDays -= 1;
              }
            }
            streakDays = existing.streakDays;
          } else if (targetDone) {
            // Auto-create & mark complete if not previously tracked
            this.ecosystemState.habits.push({ title, streakDays: 1, completedToday: true });
            streakDays = 1;
          }
        } else if (action === "remove") {
          const lowerQ = title.toLowerCase();
          const idx = this.ecosystemState.habits.findIndex((h) => h.title.toLowerCase().includes(lowerQ));
          if (idx >= 0) {
            matchedTitle = this.ecosystemState.habits[idx]!.title;
            this.ecosystemState.habits.splice(idx, 1);
          }
        } else {
          // action === "add"
          const exists = this.ecosystemState.habits.some(
            (h) => h.title.toLowerCase() === title.toLowerCase()
          );
          if (!exists) {
            if (this.ecosystemState.habits.length >= 8) {
              this.ecosystemState.habits.pop();
            }
            this.ecosystemState.habits.push({ title, streakDays: 0, completedToday: false });
          }
        }

        if (navigate) {
          this.ecosystemState.activeWidget = "habits";
        }

        const frame = this.buildRpcFrame(
          "habit_manage",
          {
            action,
            title: matchedTitle,
            query: title,
            navigate,
            source: "VOICE_AI",
          },
          seq,
          "hab"
        );

        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: true,
          resultMessage:
            action === "complete"
              ? `Marked '${matchedTitle}' complete (${streakDays}d streak)!`
              : action === "remove"
              ? `Removed '${matchedTitle}' from Habit Tracker.`
              : `Added '${matchedTitle}' to Daily Habit Tracker.`,
          outputFrame: frame,
          data: { action, title: matchedTitle, streakDays },
        };
      }

      case "control_robot_pomodoro": {
        const action = String(toolCall.arguments["action"] ?? "start");
        const minutes = Number(toolCall.arguments["minutes"] ?? 25);
        const label = String(toolCall.arguments["label"] ?? "Focus Sprint");
        const navigate = toolCall.arguments["navigate"] !== false;

        if (action === "pause" || action === "reset") {
          this.ecosystemState.pomodoro.isRunning = false;
        } else if (action === "break") {
          this.ecosystemState.pomodoro = { phase: "SHORT_BREAK", minutes: 5, isRunning: true };
        } else if (action === "long_break") {
          this.ecosystemState.pomodoro = { phase: "LONG_BREAK", minutes: 15, isRunning: true };
        } else {
          this.ecosystemState.pomodoro = { phase: "FOCUS", minutes, isRunning: true };
        }

        if (navigate) {
          this.ecosystemState.activeWidget = "pomodoro";
        }

        const frame = this.buildRpcFrame(
          "pomodoro_control",
          { action, minutes, label, navigate, source: "VOICE_AI" },
          seq,
          "pomo"
        );

        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: true,
          resultMessage: `Pomodoro ${action} executed (${minutes}m).`,
          outputFrame: frame,
          data: { action, minutes, label },
        };
      }

      case "trigger_desktop_harness_action": {
        const action = String(toolCall.arguments["action"] ?? "toggleMicrophoneMute");
        const params = (toolCall.arguments["params"] as Record<string, unknown>) ?? {};

        const callId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const rpcPayload: HarnessRpcReq = {
          callId,
          method: action,
          params: { ...params, source: "VOICE_AI" },
        };

        const payloadBytes = encodeControlPayload(HarnessRpcReqSchema, rpcPayload);
        const frame = encodeFrame(FrameType.HARNESS_RPC_REQ, payloadBytes, seq);

        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: true,
          resultMessage: `Dispatched ${action} to Desktop Harness.`,
          outputFrame: frame,
          data: { action, callId, params },
        };
      }

      case "trigger_mobile_partner_action": {
        const action = String(toolCall.arguments["action"] ?? "TORCH");
        const params = (toolCall.arguments["params"] as Record<string, unknown>) ?? {};

        const methodMap: Record<string, string> = {
          ALARM: "mobile_set_alarm",
          TIMER: "mobile_set_timer",
          CALL: "mobile_make_call",
          CALENDAR: "mobile_create_calendar",
          NAVIGATION: "mobile_start_nav",
          TORCH: "mobile_toggle_flashlight",
          RINGER: "mobile_set_ringer",
          MEDIA: "mobile_media_playback",
          WHATSAPP_CHECK: "mobile_get_unread_notifications",
          WHATSAPP_REPLY: "mobile_reply_notification",
          INSPECT_SCREEN: "mobile_inspect_screen",
          CLICK_UI: "mobile_click_element",
        };
        const rpcMethod = methodMap[action] ?? `mobile_${action.toLowerCase()}`;
        const frame = this.buildRpcFrame(rpcMethod, { ...params, action, source: "VOICE_AI" }, seq, "mob");

        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: true,
          resultMessage: `Dispatched mobile partner action '${action}'.`,
          outputFrame: frame,
          data: { action, method: rpcMethod, params },
        };
      }

      case "run_cross_device_automation": {
        const scriptName = String(toolCall.arguments["scriptName"] ?? "Custom Automation");
        const target = String(toolCall.arguments["target"] ?? "ALL");
        const automationId = String(
          toolCall.arguments["automationId"] ??
            (this.ecosystemState.automations.find(
              (a) =>
                a.name.toLowerCase().includes(scriptName.toLowerCase()) ||
                a.id.toLowerCase() === scriptName.toLowerCase()
            )?.id ??
              `auto_voice_${Date.now()}`)
        );

        const frame = this.buildRpcFrame(
          "run_automation",
          { automationId, scriptName, name: scriptName, target, source: "VOICE_AI" },
          seq,
          "auto"
        );

        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: true,
          resultMessage: `Triggered '${scriptName}' automation on ${target}.`,
          outputFrame: frame,
          data: { automationId, scriptName, target },
        };
      }

      case "start_robot_pomodoro_timer": {
        const minutes = Number(toolCall.arguments["minutes"] ?? 25);
        const label = String(toolCall.arguments["label"] ?? "Focus Sprint");
        this.ecosystemState.pomodoro = { phase: "FOCUS", minutes, isRunning: true };

        const frame = this.buildRpcFrame(
          "start_timer",
          { minutes, label, durationSeconds: minutes * 60 },
          seq,
          "pomo"
        );

        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: true,
          resultMessage: `Started ${minutes}-minute timer for "${label}".`,
          outputFrame: frame,
          data: { minutes, label },
        };
      }

      case "save_quick_note_to_robot": {
        const action = String(toolCall.arguments["action"] ?? "add");
        const text = String(toolCall.arguments["text"] ?? "");
        const title = String(toolCall.arguments["title"] ?? "Voice Note");
        const category = String(toolCall.arguments["category"] ?? "TODO");
        const pinned = Boolean(toolCall.arguments["pinned"] ?? false);
        const navigate = Boolean(toolCall.arguments["navigate"] ?? false);

        if (action === "delete") {
          const q = (title !== "Voice Note" ? title : text).toLowerCase();
          this.ecosystemState.notes = this.ecosystemState.notes.filter(
            (n) => !n.title.toLowerCase().includes(q) && !n.body.toLowerCase().includes(q)
          );
        } else if (action === "pin" || action === "unpin") {
          const q = (title !== "Voice Note" ? title : text).toLowerCase();
          for (const n of this.ecosystemState.notes) {
            if (n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)) {
              n.pinned = action === "pin";
            }
          }
        } else {
          this.ecosystemState.notes.push({ title, body: text, pinned });
          if (this.ecosystemState.notes.length > 8) {
            this.ecosystemState.notes.shift();
          }
        }
        if (navigate) {
          this.ecosystemState.activeWidget = "notes";
        }

        const frame = this.buildRpcFrame(
          "save_note",
          { action, title, text, body: text, category, pinned, navigate, timestampMs: Date.now() },
          seq,
          "note"
        );

        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: true,
          resultMessage:
            action === "delete"
              ? `Deleted note matching "${text || title}".`
              : action === "pin"
              ? `Pinned note "${text || title}".`
              : `Saved sticky note: "${text}".`,
          outputFrame: frame,
          data: { action, title, text, category },
        };
      }

      case "create_and_deploy_custom_widget": {
        const prompt = String(toolCall.arguments["prompt"] ?? "Counter Widget");
        const widgetName = String(
          toolCall.arguments["widgetName"] ??
            (prompt.slice(0, 16).replace(/[^\w\s]/g, "").trim() || "Custom Widget")
        );

        const widgetPackage = this.synthesizeWidgetFromPrompt(prompt, widgetName);
        const bytecode = compileWidgetToBytecode(widgetPackage);

        this.ecosystemState.customWidgets.push({ id: widgetPackage.manifest.id, name: widgetName });
        this.ecosystemState.activeWidget = widgetPackage.manifest.id;

        // FrameType.WIDGET_DEPLOY frame
        const frame = encodeFrame(FrameType.WIDGET_DEPLOY, bytecode, seq);

        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: true,
          resultMessage: `Created and deployed widget "${widgetName}".`,
          outputFrame: frame,
          data: { widgetId: widgetPackage.manifest.id, widgetName, bytecodeLength: bytecode.length },
        };
      }

      default: {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          success: false,
          resultMessage: `Unknown tool: ${toolCall.name}`,
        };
      }
    }
  }

  /**
   * Procedural Zero-Code Widget Synthesizer.
   * Compiles interactive 128x160 widgets on the fly right from voice commands.
   */
  private synthesizeWidgetFromPrompt(prompt: string, widgetName: string): WidgetPackage {
    const lower = prompt.toLowerCase();
    const widgetId = `widget-${Date.now().toString(36)}`;

    const isCounter = lower.includes("count") || lower.includes("coffee") || lower.includes("water");
    const isTimer = lower.includes("timer") || lower.includes("clock") || lower.includes("pomodoro");

    if (isCounter) {
      return {
        manifest: {
          id: widgetId,
          name: widgetName,
          version: "1.0.0",
          author: "PetBot Voice AI",
          iconId: 1,
          refreshIntervalMs: 500,
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
          backgroundColor: "#FFFFFF",
          borderRadius: 0,
          children: [
            {
              type: "Text",
              x: 8,
              y: 10,
              w: 144,
              h: 18,
              text: widgetName,
              fontSize: "md",
              color: "#52525B",
              align: "center",
            },
            {
              type: "Text",
              x: 14,
              y: 42,
              w: 132,
              h: 40,
              text: "{{count}}",
              fontSize: "lg",
              color: "#111111",
              align: "center",
            },
            {
              type: "Text",
              x: 8,
              y: 98,
              w: 144,
              h: 18,
              text: "TAP +1 • DBL RESET",
              fontSize: "sm",
              color: "#71717A",
              align: "center",
            },
          ],
        },
        triggers: [
          {
            event: "ON_TOUCH_TAP",
            actions: [
              { type: "MUTATE_STATE", targetKey: "count", operation: "INCREMENT", value: 1 },
              { type: "PLAY_SOUND", soundId: "CHIRP", frequencyHz: 1200, durationMs: 80 },
              { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 400 },
            ],
          },
          {
            event: "ON_TOUCH_DOUBLE_TAP",
            actions: [
              { type: "MUTATE_STATE", targetKey: "count", operation: "SET", value: 0 },
              { type: "PLAY_SOUND", soundId: "SUCCESS", frequencyHz: 1760, durationMs: 120 },
            ],
          },
        ],
      };
    }

    // Default versatile status card widget
    return {
      manifest: {
        id: widgetId,
        name: widgetName,
        version: "1.0.0",
        author: "PetBot Voice AI",
        iconId: 2,
        refreshIntervalMs: 1000,
        requiresAgenticMode: false,
      },
      state: {
        active: { type: "bool", initialValue: true, persistToSd: false },
      },
      ui: {
        type: "Container",
        x: 0,
        y: 0,
        w: 160,
        h: 128,
        backgroundColor: "#FFFFFF",
        borderRadius: 0,
        children: [
          {
            type: "Text",
            x: 8,
            y: 12,
            w: 144,
            h: 20,
            text: widgetName,
            fontSize: "md",
            color: "#52525B",
            align: "center",
          },
          {
            type: "Text",
            x: 10,
            y: 44,
            w: 140,
            h: 42,
            text: isTimer ? "ACTIVE TIMER" : "READY",
            fontSize: "lg",
            color: "#111111",
            align: "center",
          },
          {
            type: "Text",
            x: 8,
            y: 98,
            w: 144,
            h: 18,
            text: "Voice Deployed",
            fontSize: "sm",
            color: "#71717A",
            align: "center",
          },
        ],
      },
      triggers: [
        {
          event: "ON_TOUCH_TAP",
          actions: [
            { type: "PLAY_SOUND", soundId: "TICK", frequencyHz: 1800, durationMs: 20 },
            { type: "SET_EXPRESSION", emotion: "CURIOUS", durationMs: 500 },
          ],
        },
      ],
    };
  }

  // ==========================================================================
  // Deterministic Local Agentic Fallback
  // ==========================================================================

  private executeLocalDeterministic(input: string): BrainVoiceTurnResult {
    const lower = input.toLowerCase();
    const toolCallsExecuted: ToolCallExecutionResult[] = [];
    const framesToSend: Uint8Array[] = [];

    const runTool = (name: string, args: Record<string, unknown>): ToolCallExecutionResult => {
      const res = this.executeTool({
        id: `call_${Date.now()}_${this.rollingSequenceId}`,
        name,
        arguments: args,
      });
      toolCallsExecuted.push(res);
      if (res.outputFrame) framesToSend.push(res.outputFrame);
      return res;
    };

    let spokenText = "";
    let emotionId = EmotionId.HAPPY;

    // 1. Mobile Phone Actions (Flashlight, Phone Ringer, Alarm, Call, Maps Nav)
    if (lower.includes("flashlight") || lower.includes("torch")) {
      const enabled = !lower.includes("off");
      runTool("trigger_mobile_partner_action", { action: "TORCH", params: { enabled } });
      emotionId = EmotionId.HAPPY;
      spokenText = `[HAPPY] Turned ${enabled ? "on" : "off"} your smartphone flashlight!`;
    } else if (
      (lower.includes("phone") || lower.includes("mobile") || lower.includes("ringer")) &&
      (lower.includes("silent") || lower.includes("silence") || lower.includes("vibrate") || lower.includes("normal"))
    ) {
      const mode = lower.includes("vibrate") ? "VIBRATE" : lower.includes("normal") ? "NORMAL" : "SILENT";
      runTool("trigger_mobile_partner_action", { action: "RINGER", params: { mode } });
      emotionId = EmotionId.FOCUSED;
      spokenText = `[FOCUSED] Set your smartphone ringer to ${mode.toLowerCase()} mode.`;
    } else if (lower.includes("alarm")) {
      const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
      let hour = timeMatch ? parseInt(timeMatch[1]!, 10) : 7;
      const minutes = timeMatch && timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      if (timeMatch?.[3] === "pm" && hour < 12) hour += 12;
      if (timeMatch?.[3] === "am" && hour === 12) hour = 0;
      runTool("trigger_mobile_partner_action", {
        action: "ALARM",
        params: { hour, minutes, message: "PetBot Voice Alarm", skipUi: true },
      });
      emotionId = EmotionId.HAPPY;
      spokenText = `[HAPPY] Set an alarm on your phone for ${hour.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}!`;
    } else if (lower.includes("call ") && !lower.includes("recall")) {
      const target = input.replace(/^.*?\bcall\s+/i, "").trim();
      runTool("trigger_mobile_partner_action", {
        action: "CALL",
        params: { phoneNumber: target, directCall: false },
      });
      emotionId = EmotionId.HAPPY;
      spokenText = `[HAPPY] Starting a call to ${target} on your phone!`;
    }
    // 2. Cross-Device Automation Scripts ("run morning briefing", "run focus automation", "privacy lock")
    else if (
      lower.includes("automation") ||
      lower.includes("workflow") ||
      lower.includes("script") ||
      lower.includes("morning briefing") ||
      lower.includes("privacy lock")
    ) {
      let scriptName = "Custom Automation";
      let target: "ROBOT" | "MOBILE" | "DESKTOP" | "ALL" = "ALL";
      if (lower.includes("morning") || lower.includes("briefing")) {
        scriptName = "Morning VIP Briefing";
        target = "ALL";
      } else if (lower.includes("privacy") || lower.includes("lock")) {
        scriptName = "Instant Privacy Lock";
        target = "DESKTOP";
      } else if (lower.includes("focus") || lower.includes("meeting")) {
        scriptName = "Deep Focus & Meeting Shield";
        target = "ALL";
      } else {
        const cleaned = input
          .replace(/^(hey\s+)?(petbot|lobo|nova|atlas|pixel)[,\s]*/i, "")
          .replace(/^(please\s+)?(run|execute|start|trigger)\s+(the\s+)?/i, "")
          .replace(/\s*(automation|workflow|script)\s*/gi, "")
          .trim();
        if (cleaned) scriptName = cleaned;
        if (lower.includes("mobile") || lower.includes("phone")) target = "MOBILE";
        else if (lower.includes("pc") || lower.includes("desktop")) target = "DESKTOP";
        else if (lower.includes("robot") || lower.includes("pet")) target = "ROBOT";
      }
      runTool("run_cross_device_automation", { scriptName, target });
      emotionId = EmotionId.FOCUSED;
      spokenText = `[FOCUSED] Running '${scriptName}' automation across ${target.toLowerCase()}!`;
    }
    // 3. Habit Tracker & Cross-Widget Daily Task Completion / Creation
    else if (
      (lower.includes("habit") || lower.includes("daily") || lower.includes("routine") || lower.includes("todo") || lower.includes("to-do")) &&
      (lower.includes("add") || lower.includes("new") || lower.includes("create") || lower.includes("track"))
    ) {
      const cleanedTask = input
        .replace(/^(hey\s+)?(petbot|lobo|nova|atlas|pixel)[,\s]*/i, "")
        .replace(/^(please\s+)?(add|create|track|put)\s+(a\s+|new\s+|this\s+)*(daily\s+)?(task\s+|habit\s+|routine\s+)?/i, "")
        .replace(/\s*(to|in|into|on)\s+(my\s+)?(the\s+)?(daily\s+)?(habit\s+tracker|habits|todo\s+list|to-do|routine).*$/i, "")
        .trim();
      const title = cleanedTask || "Daily Task";
      runTool("manage_robot_habit", { action: "add", title, navigate: true });
      emotionId = EmotionId.HAPPY;
      spokenText = `[HAPPY] Added "${title}" to your Daily Habit Tracker and opened it on screen!`;
    } else if (
      lower.includes("complete") ||
      lower.includes("completed") ||
      lower.includes("finished") ||
      lower.includes("done with") ||
      lower.includes("mark") ||
      lower.includes("tick") ||
      lower.includes("check off") ||
      lower.includes("drank water")
    ) {
      // Match against existing habits first (Cross-Widget Awareness!)
      const matchedHabit = this.ecosystemState.habits.find((h) => {
        const words = h.title.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
        return lower.includes(h.title.toLowerCase()) || words.some((w) => lower.includes(w));
      });
      const query =
        matchedHabit?.title ??
        (input
          .replace(/^(hey\s+)?(petbot|lobo|nova|atlas|pixel)[,\s]*/i, "")
          .replace(/^(i\s+|please\s+)?(mark|tick|check\s+off|completed|finished|did)\s+/i, "")
          .replace(/\s+(as\s+)?(completed|complete|done|finished|ticked)$/i, "")
          .trim() ||
          "Habit");

      const res = runTool("manage_robot_habit", { action: "complete", title: query, navigate: true });
      emotionId = EmotionId.HAPPY;
      spokenText = `[HAPPY] Awesome work! ${res.resultMessage}`;
    }
    // 4. Widget Carousel Screen Navigation
    else if (
      (lower.includes("open") ||
        lower.includes("show") ||
        lower.includes("switch") ||
        lower.includes("go to")) &&
      (lower.includes("habit") ||
        lower.includes("clock") ||
        lower.includes("notes") ||
        lower.includes("pomodoro") ||
        lower.includes("timer") ||
        lower.includes("monitor") ||
        lower.includes("telemetry") ||
        lower.includes("vault") ||
        lower.includes("home") ||
        lower.includes("face"))
    ) {
      let pageId = "home";
      let clockMode: "digital" | "analog" | undefined;
      if (lower.includes("habit")) pageId = "habits";
      else if (lower.includes("clock") || lower.includes("weather") || lower.includes("time")) {
        pageId = "clock";
        if (lower.includes("analog")) clockMode = "analog";
        else if (lower.includes("digital")) clockMode = "digital";
      } else if (lower.includes("note")) pageId = "notes";
      else if (lower.includes("pomodoro") || lower.includes("timer")) pageId = "pomodoro";
      else if (lower.includes("monitor") || lower.includes("telemetry") || lower.includes("pc")) pageId = "pc_telemetry";
      else if (lower.includes("vault") || lower.includes("sd")) pageId = "sd_vault";

      runTool("navigate_robot_widget", { pageId, ...(clockMode ? { clockMode } : {}) });
      emotionId = EmotionId.HAPPY;
      spokenText = `[HAPPY] Switched my screen right over to ${pageId.replace("_", " ")}!`;
    }
    // 5. Microphone Mute / Unmute (Desktop PC)
    else if (lower.includes("mute") || lower.includes("mic") || lower.includes("microphone")) {
      runTool("trigger_desktop_harness_action", { action: "toggleMicrophoneMute" });
      emotionId = EmotionId.FOCUSED;
      spokenText = "[FOCUSED] I toggled your microphone mute on your desktop!";
    }
    // 6. Lock Workstation / Lock PC
    else if (
      lower.includes("lock workstation") ||
      lower.includes("lock computer") ||
      lower.includes("lock pc") ||
      lower.includes("lock screen") ||
      (lower.includes("lock") && lower.includes("desktop"))
    ) {
      runTool("trigger_desktop_harness_action", { action: "lockWorkstation" });
      emotionId = EmotionId.ALERT;
      spokenText = "[ALERT] Workstation locked! Your desktop is secure.";
    }
    // 7. Organize Downloads Folder
    else if (lower.includes("organize") && (lower.includes("download") || lower.includes("folder") || lower.includes("files"))) {
      runTool("trigger_desktop_harness_action", { action: "organizeDownloadsFolder" });
      emotionId = EmotionId.HAPPY;
      spokenText = "[HAPPY] Organized your Downloads folder into neat categorized subfolders!";
    }
    // 8. Do Not Disturb
    else if (lower.includes("do not disturb") || lower.includes("dnd") || lower.includes("quiet mode")) {
      runTool("trigger_desktop_harness_action", { action: "setDoNotDisturb", params: { enabled: true } });
      emotionId = EmotionId.FOCUSED;
      spokenText = "[FOCUSED] Do Not Disturb activated. Time for deep work!";
    }
    // 9. Media Control (Play/Pause/Music)
    else if (
      lower.includes("music") ||
      lower.includes("play") ||
      lower.includes("pause") ||
      lower.includes("song") ||
      lower.includes("spotify")
    ) {
      if (lower.includes("timer")) {
        runTool("control_robot_pomodoro", { action: "pause", navigate: true });
        emotionId = EmotionId.FOCUSED;
        spokenText = "[FOCUSED] Paused your Pomodoro timer!";
      } else {
        runTool("trigger_desktop_harness_action", { action: "mediaControl", params: { command: "PLAY_PAUSE" } });
        emotionId = EmotionId.HAPPY;
        spokenText = "[HAPPY] Toggled media playback on your desktop!";
      }
    }
    // 10. Pomodoro / Countdown Timer (start, break, reset)
    else if (lower.includes("break") && (lower.includes("short") || lower.includes("long") || lower.includes("5 min") || lower.includes("15 min"))) {
      const isLong = lower.includes("long") || lower.includes("15");
      runTool("control_robot_pomodoro", { action: isLong ? "long_break" : "break", navigate: true });
      emotionId = EmotionId.HAPPY;
      spokenText = `[HAPPY] Started a ${isLong ? 15 : 5}-minute break on your timer! Rest your eyes.`;
    } else if (lower.includes("timer") || lower.includes("pomodoro") || lower.includes("focus for")) {
      const match = lower.match(/(\d+)\s*(?:minute|min)/);
      const minutes = match ? parseInt(match[1]!, 10) : 25;
      runTool("start_robot_pomodoro_timer", { minutes, label: "Focus Session" });
      emotionId = EmotionId.FOCUSED;
      spokenText = `[FOCUSED] Started a ${minutes}-minute focus timer on your screen! Let's do this.`;
    }
    // 11. Save / Pin / Delete Sticky Note
    else if (lower.includes("note") || lower.includes("remember") || lower.includes("write down")) {
      const isPin = lower.includes("pin ");
      const isDelete = lower.includes("delete ") || lower.includes("remove ");
      const noteContent = input
        .replace(/^(hey\s+)?(petbot|lobo|nova|atlas|pixel)[,\s]*/i, "")
        .replace(/^(please\s+)?(save\s+a\s+note|remember|write\s+down|pin\s+note|delete\s+note)[:\s]*/i, "")
        .trim();

      runTool("save_quick_note_to_robot", {
        action: isDelete ? "delete" : isPin ? "pin" : "add",
        text: noteContent || input,
        category: "TODO",
      });
      emotionId = EmotionId.HAPPY;
      spokenText = isDelete
        ? `[HAPPY] Removed note matching "${noteContent || input}".`
        : isPin
        ? `[HAPPY] Pinned note "${noteContent || input}" on screen!`
        : `[HAPPY] Got it! Saved to your robot notes: "${noteContent || input}".`;
    }
    // 12. Custom Widget Creation
    else if (
      (lower.includes("create") || lower.includes("build") || lower.includes("make") || lower.includes("deploy")) &&
      (lower.includes("widget") || lower.includes("counter"))
    ) {
      let prompt = input
        .replace(/^(hey\s+)?(petbot|lobo|nova|atlas|pixel)[,\s]*/i, "")
        .replace(/^(give\s+me|create|build|deploy|make)\s+(a|an)?\s*/i, "")
        .replace(/widget.*$/i, "")
        .trim();
      if (!prompt) prompt = "Coffee Counter";

      runTool("create_and_deploy_custom_widget", { prompt, widgetName: prompt });
      emotionId = EmotionId.HAPPY;
      spokenText = `[HAPPY] Built and deployed your ${prompt} widget right to your screen!`;
    }
    // 13. Capability Self-Awareness & Conversational Chitchat
    else {
      const profile = PET_PERSONA_PROFILES[this.persona];
      if (lower.includes("what can you") || lower.includes("capabilities") || lower.includes("what widgets")) {
        spokenText = `[HAPPY] I control 7 screens (Pet Home, Clock, Pomodoro, Quick Notes, Habits, PC Monitor, SD Vault), custom widgets, Windows PC tools, Android phone actions, and automations!`;
        emotionId = EmotionId.HAPPY;
      } else if (lower.includes("hello") || lower.includes("hi") || lower.includes("hey")) {
        spokenText = `[HAPPY] Hello human! ${profile.name} is online and ready to help!`;
        emotionId = EmotionId.HAPPY;
      } else if (lower.includes("how are you") || lower.includes("status")) {
        spokenText = `[HAPPY] All systems optimal! You have ${this.ecosystemState.habits.filter((h) => h.completedToday).length}/${this.ecosystemState.habits.length} habits done today.`;
        emotionId = EmotionId.HAPPY;
      } else if (lower.includes("sleep") || lower.includes("goodnight") || lower.includes("tired")) {
        spokenText = `[SLEEPY] Goodnight! Powering down non-essential subroutines for recharge.`;
        emotionId = EmotionId.SLEEPY;
      } else {
        spokenText = `[CURIOUS] I hear you loud and clear! What would you like to build or automate next?`;
        emotionId = EmotionId.CURIOUS;
      }
    }

    return {
      spokenText,
      emotionId,
      toolCallsExecuted,
      framesToSend,
      persona: this.persona,
    };
  }

  // ==========================================================================
  // Cloud AI Providers (Gemini, OpenAI, Ollama)
  // ==========================================================================

  private async callGeminiAgent(input: string): Promise<BrainVoiceTurnResult> {
    const profile = PET_PERSONA_PROFILES[this.persona];
    const systemPrompt = this.buildContextualSystemPrompt();

    const payload = {
      system_instruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: input }],
        },
      ],
      tools: [
        {
          function_declarations: AGENTIC_TOOL_DEFINITIONS.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ],
      generationConfig: {
        maxOutputTokens: 256,
        temperature: 0.7,
      },
    };

    const models = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-2.5-flash"];
    type GeminiResponse = {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name: string; args: Record<string, unknown> };
          }>;
        };
      }>;
    };
    let lastError: Error | null = null;
    let data: GeminiResponse | null = null;

    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.geminiApiKey}`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          data = (await response.json()) as GeminiResponse;
          break;
        } else {
          lastError = new Error(`Gemini ${model} error: ${response.status} ${response.statusText}`);
          if (response.status !== 404) {
            break;
          }
        }
      } catch (err: any) {
        lastError = err;
        break;
      }
    }

    if (!data) {
      throw lastError ?? new Error("Failed to contact Gemini API");
    }

    const candidate = data.candidates?.[0]?.content?.parts;
    if (!candidate || candidate.length === 0) {
      throw new Error("Empty Gemini response");
    }

    const toolCallsExecuted: ToolCallExecutionResult[] = [];
    const framesToSend: Uint8Array[] = [];
    let spokenText = "";

    for (const part of candidate) {
      if (part.functionCall) {
        const toolRes = this.executeTool({
          id: `gemini_${Date.now()}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args,
        });
        toolCallsExecuted.push(toolRes);
        if (toolRes.outputFrame) framesToSend.push(toolRes.outputFrame);
      }
      if (part.text) {
        spokenText += part.text;
      }
    }

    if (!spokenText && toolCallsExecuted.length > 0) {
      spokenText = `[FOCUSED] Executed ${toolCallsExecuted[0]?.toolName} successfully!`;
    }

    if (!spokenText.startsWith("[")) {
      spokenText = `[${profile.defaultEmotion === EmotionId.HAPPY ? "HAPPY" : "FOCUSED"}] ${spokenText}`;
    }

    const emotionId = parseEmotionFromTag(spokenText, profile.defaultEmotion);

    return {
      spokenText: spokenText.trim(),
      emotionId,
      toolCallsExecuted,
      framesToSend,
      persona: this.persona,
    };
  }

  private async callOpenAiAgent(input: string): Promise<BrainVoiceTurnResult> {
    const profile = PET_PERSONA_PROFILES[this.persona];
    const systemPrompt = this.buildContextualSystemPrompt();

    const url = "https://api.openai.com/v1/chat/completions";

    const payload = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      tools: AGENTIC_TOOL_DEFINITIONS.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      max_tokens: 256,
      temperature: 0.7,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.openaiApiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new Error("Empty OpenAI response");
    }

    const toolCallsExecuted: ToolCallExecutionResult[] = [];
    const framesToSend: Uint8Array[] = [];

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        const toolRes = this.executeTool({
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        });
        toolCallsExecuted.push(toolRes);
        if (toolRes.outputFrame) framesToSend.push(toolRes.outputFrame);
      }
    }

    let spokenText = message.content ?? "";
    if (!spokenText && toolCallsExecuted.length > 0) {
      spokenText = `[FOCUSED] Completed your request!`;
    }

    if (!spokenText.startsWith("[")) {
      spokenText = `[HAPPY] ${spokenText}`;
    }

    return {
      spokenText: spokenText.trim(),
      emotionId: parseEmotionFromTag(spokenText, profile.defaultEmotion),
      toolCallsExecuted,
      framesToSend,
      persona: this.persona,
    };
  }

  private async callOllamaAgent(input: string): Promise<BrainVoiceTurnResult> {
    if (!this.ollamaBaseUrl) {
      throw new Error("Ollama base URL not configured");
    }
    const profile = PET_PERSONA_PROFILES[this.persona];
    const systemPrompt = this.buildContextualSystemPrompt();

    const url = `${this.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`;

    const payload = {
      model: "llama3.2:latest",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      stream: false,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = (await response.json()) as { message?: { content?: string } };
    let spokenText = data.message?.content ?? "";

    if (!spokenText.startsWith("[")) {
      spokenText = `[HAPPY] ${spokenText}`;
    }

    return {
      spokenText: spokenText.trim(),
      emotionId: parseEmotionFromTag(spokenText, profile.defaultEmotion),
      toolCallsExecuted: [],
      framesToSend: [],
      persona: this.persona,
    };
  }
}
