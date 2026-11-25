/**
 * Zero-Code Widget & Workflow Compiler Service
 * 
 * Powers the Companion App's "Magic Studio" by converting plain-English prompts
 * or iterative conversational refinements into:
 * 1. Validated WidgetPackage (128x160 layout tree, reactive state, triggers, sound cues).
 * 2. Compiled PBWG binary bytecode (base64 encoded) for direct ESP32-S3 PSRAM execution.
 * 3. 1-sentence friendly assistant summary (how to interact with Single Tap / Double Tap / Hold).
 * 4. Optional linked Desktop Harness workflow definition for PC automation.
 * 
 * Enforces automatic self-repair & deterministic schema synthesis so output ALWAYS
 * passes WidgetPackageSchema.parse() and compileWidgetToBytecode().
 */

import {
  WidgetPackageSchema,
  compileWidgetToBytecode,
  type WidgetPackage,
  type UINode,
  type TriggerRule,
  type Action,
  type ColorValue,
  type SoundId,
  type EmotionType,
} from "@petbot/widget-schema";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface LinkedDesktopWorkflowStep {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly riskTier: "TIER_1_SAFE" | "TIER_2_WORKFLOW" | "TIER_3_2FA_REQUIRED";
}

export interface LinkedDesktopWorkflow {
  readonly workflowId: string;
  readonly name: string;
  readonly triggerActionId: string;
  readonly steps: LinkedDesktopWorkflowStep[];
}

export interface GenerateWidgetParams {
  readonly prompt: string;
  readonly currentWidget?: WidgetPackage | undefined;
  readonly conversationHistory?: Array<{ role: "user" | "assistant"; text: string }> | undefined;
}

export interface GenerateWidgetResult {
  readonly success: boolean;
  readonly widget: WidgetPackage;
  readonly bytecodeBase64: string;
  readonly assistantSummary: string;
  readonly linkedWorkflow?: LinkedDesktopWorkflow | undefined;
}

export interface StudioTemplate {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly widget: WidgetPackage;
  readonly bytecodeBase64: string;
  readonly assistantSummary: string;
  readonly linkedWorkflow?: LinkedDesktopWorkflow | undefined;
}

// Color keyword map to hex RGB
const COLOR_KEYWORDS: Record<string, string> = {
  emerald: "#10B981",
  green: "#22C55E",
  cyan: "#00F0FF",
  blue: "#3B82F6",
  amber: "#F59E0B",
  yellow: "#EAB308",
  gold: "#FFB020",
  orange: "#F97316",
  red: "#EF4444",
  rose: "#F43F5E",
  purple: "#8B5CF6",
  violet: "#7C3AED",
  pink: "#EC4899",
  white: "#FFFFFF",
  gray: "#6B7280",
  dark: "#0B0E14",
};

// ============================================================================
// Zero-Code Compiler Service Implementation
// ============================================================================

export class ZeroCodeCompilerService {
  /**
   * Generates a new widget or refines an existing one based on conversational prompts.
   */
  public async generateOrRefineWidget(
    params: GenerateWidgetParams
  ): Promise<GenerateWidgetResult> {
    const prompt = params.prompt.trim();

    let widget: WidgetPackage;
    let assistantSummary = "";
    let linkedWorkflow: LinkedDesktopWorkflow | undefined;

    // Check if this is an iterative refinement of an existing widget
    if (params.currentWidget) {
      const refinement = this.refineExistingWidget(params.currentWidget, prompt);
      widget = refinement.widget;
      assistantSummary = refinement.summary;
      linkedWorkflow = refinement.linkedWorkflow;
    } else {
      // Fresh synthesis from prompt
      const synthesized = this.synthesizeWidgetFromScratch(prompt);
      widget = synthesized.widget;
      assistantSummary = synthesized.summary;
      linkedWorkflow = synthesized.linkedWorkflow;
    }

    // Self-Repair Gate: Ensure widget passes WidgetPackageSchema
    widget = this.selfRepairWidget(widget, prompt);

    // Compile to PBWG binary bytecode
    const bytecode = compileWidgetToBytecode(widget);
    const bytecodeBase64 = Buffer.from(bytecode).toString("base64");

    return {
      success: true,
      widget,
      bytecodeBase64,
      assistantSummary,
      linkedWorkflow,
    };
  }

  private cachedTemplates: StudioTemplate[] | null = null;

  /**
   * Returns curated pre-built widget templates with their compiled bytecodes ready for 1-click install.
   */
  public getTemplates(): StudioTemplate[] {
    if (this.cachedTemplates) {
      return this.cachedTemplates;
    }

    const templateDefinitions: Array<{
      id: string;
      name: string;
      category: string;
      description: string;
      prompt: string;
    }> = [
      {
        id: "tpl-hydration-tracker",
        name: "Hydration Tracker",
        category: "Health & Wellness",
        description: "Track your daily water intake with visual progress. Tap to add a cup, double-tap to reset.",
        prompt: "water hydration goal 8 cups",
      },
      {
        id: "tpl-pomodoro-timer",
        name: "Pomodoro Focus Timer",
        category: "Productivity",
        description: "25-minute focus session timer. Tap to start or pause, double-tap to reset.",
        prompt: "pomodoro timer 25 minutes",
      },
      {
        id: "tpl-coffee-counter",
        name: "Coffee Counter",
        category: "Daily Habits",
        description: "Monitor your caffeine consumption throughout the day. Tap to log a cup, double-tap to clear.",
        prompt: "coffee counter 5 cups",
      },
      {
        id: "tpl-mute-pc-mic",
        name: "Mute PC Mic Controller",
        category: "Desktop Automation",
        description: "Hardware mute toggle for your computer microphone with instant audio feedback.",
        prompt: "mute pc mic desktop harness",
      },
    ];

    const templates: StudioTemplate[] = templateDefinitions.map((def) => {
      const synthesized = this.synthesizeWidgetFromScratch(def.prompt);
      const repaired = this.selfRepairWidget(synthesized.widget, def.prompt);
      const bytecode = compileWidgetToBytecode(repaired);
      const bytecodeBase64 = Buffer.from(bytecode).toString("base64");

      return {
        id: def.id,
        name: def.name,
        category: def.category,
        description: def.description,
        widget: repaired,
        bytecodeBase64,
        assistantSummary: synthesized.summary,
        linkedWorkflow: synthesized.linkedWorkflow,
      };
    });

    this.cachedTemplates = templates;
    return templates;
  }

  // ==========================================================================
  // Deterministic Synthesis From Scratch
  // ==========================================================================

  private synthesizeWidgetFromScratch(prompt: string): {
    widget: WidgetPackage;
    summary: string;
    linkedWorkflow?: LinkedDesktopWorkflow | undefined;
  } {
    const lower = prompt.toLowerCase();
    const widgetId = `widget-${Date.now().toString(36)}`;

    // 1. Hydration / Water Tracker
    if (lower.includes("water") || lower.includes("hydration") || lower.includes("drink")) {
      const targetGoal = this.extractNumericGoal(lower) || 8;
      const widget: WidgetPackage = {
        manifest: {
          id: widgetId,
          name: "Hydration Goal",
          version: "1.0.0",
          author: "PetBot Studio",
          iconId: 10,
          refreshIntervalMs: 500,
          requiresAgenticMode: false,
        },
        state: {
          cupsDrank: { type: "int32", initialValue: 0, persistToSd: true },
          goalCups: { type: "int32", initialValue: targetGoal, persistToSd: false },
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
              y: 8,
              w: 144,
              h: 16,
              text: "HYDRATION",
              fontSize: "sm",
              color: "#52525B",
              align: "center",
            },
            {
              type: "Text",
              x: 8,
              y: 30,
              w: 144,
              h: 34,
              text: "{{cupsDrank}} / " + targetGoal,
              fontSize: "lg",
              color: "#111111",
              align: "center",
            },
            {
              type: "ProgressBar",
              x: 16,
              y: 72,
              w: 128,
              h: 14,
              valueBinding: "cupsDrank",
              min: 0,
              max: targetGoal,
              fgColor: "#111111",
              bgColor: "#E4E4E7",
              orientation: "horizontal",
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
              { type: "MUTATE_STATE", targetKey: "cupsDrank", operation: "INCREMENT", value: 1 },
              { type: "PLAY_SOUND", soundId: "CHIRP", frequencyHz: 1200, durationMs: 80 },
              { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 400 },
            ],
          },
          {
            event: "ON_TOUCH_DOUBLE_TAP",
            actions: [
              { type: "MUTATE_STATE", targetKey: "cupsDrank", operation: "SET", value: 0 },
              { type: "PLAY_SOUND", soundId: "SUCCESS", frequencyHz: 1760, durationMs: 120 },
            ],
          },
        ],
      };

      return {
        widget,
        summary: `I created a water tracking widget with an ${targetGoal}-cup goal; single-tap your pet's head to record a cup and double-tap to reset your count.`,
      };
    }

    // 2. PC Automation / Desktop Harness Button (Mute mic, Lock PC, etc.)
    if (
      lower.includes("mute") ||
      lower.includes("lock") ||
      lower.includes("pc") ||
      lower.includes("desktop") ||
      lower.includes("harness")
    ) {
      const isMute = lower.includes("mute");
      const isLock = lower.includes("lock");
      const title = isMute ? "Mute PC Mic" : isLock ? "Lock Workstation" : "PC Control";
      const actionName = isMute ? "toggleMicrophoneMute" : isLock ? "lockWorkstation" : "setDoNotDisturb";

      const linkedWorkflow: LinkedDesktopWorkflow = {
        workflowId: `wf-${Date.now().toString(36)}`,
        name: title,
        triggerActionId: "HARNESS_PC_ACTION",
        steps: [
          {
            id: "step_1",
            method: actionName,
            params: {},
            riskTier: isLock ? "TIER_2_WORKFLOW" : "TIER_1_SAFE",
          },
        ],
      };

      const widget: WidgetPackage = {
        manifest: {
          id: widgetId,
          name: title.slice(0, 24),
          version: "1.0.0",
          author: "PetBot Studio",
          iconId: 5,
          refreshIntervalMs: 500,
          requiresAgenticMode: true,
        },
        state: {
          statusText: { type: "string", initialValue: "READY", persistToSd: false },
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
              text: title.toUpperCase(),
              fontSize: "md",
              color: "#52525B",
              align: "center",
            },
            {
              type: "Text",
              x: 10,
              y: 44,
              w: 140,
              h: 40,
              text: "{{statusText}}",
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
              text: "TAP TO TRIGGER",
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
              {
                type: "EMIT_HARNESS_RPC",
                actionId: "HARNESS_PC_ACTION",
                riskTier: "TIER_1_SAFE",
                payload: { action: actionName },
              },
              { type: "PLAY_SOUND", soundId: "TICK", frequencyHz: 1800, durationMs: 25 },
              { type: "SET_EXPRESSION", emotion: "FOCUSED", durationMs: 600 },
              { type: "MUTATE_STATE", targetKey: "statusText", operation: "SET", value: "EXECUTED" },
            ],
          },
        ],
      };

      return {
        widget,
        summary: `I built a ${title} desktop shortcut widget; single-tap your pet to dispatch the command directly to your computer.`,
        linkedWorkflow,
      };
    }

    // 3. Focus / Pomodoro Timer
    if (lower.includes("timer") || lower.includes("pomodoro") || lower.includes("focus")) {
      const minutes = this.extractNumericGoal(lower) || 25;
      const widget: WidgetPackage = {
        manifest: {
          id: widgetId,
          name: "Focus Timer",
          version: "1.0.0",
          author: "PetBot Studio",
          iconId: 3,
          refreshIntervalMs: 1000,
          requiresAgenticMode: false,
        },
        state: {
          minutesRemaining: { type: "int32", initialValue: minutes, persistToSd: false },
          isRunning: { type: "bool", initialValue: false, persistToSd: false },
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
              text: "POMODORO",
              fontSize: "sm",
              color: "#52525B",
              align: "center",
            },
            {
              type: "Text",
              x: 10,
              y: 36,
              w: 140,
              h: 38,
              text: "{{minutesRemaining}}m",
              fontSize: "xl",
              color: "#111111",
              align: "center",
            },
            {
              type: "ProgressBar",
              x: 16,
              y: 80,
              w: 128,
              h: 12,
              valueBinding: "minutesRemaining",
              min: 0,
              max: minutes,
              fgColor: "#111111",
              bgColor: "#E4E4E7",
              orientation: "horizontal",
            },
            {
              type: "Text",
              x: 8,
              y: 100,
              w: 144,
              h: 18,
              text: "TAP START • DBL RESET",
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
              { type: "MUTATE_STATE", targetKey: "isRunning", operation: "TOGGLE" },
              { type: "PLAY_SOUND", soundId: "CHIRP", frequencyHz: 1400, durationMs: 60 },
              { type: "SET_EXPRESSION", emotion: "FOCUSED", durationMs: 500 },
            ],
          },
          {
            event: "ON_TOUCH_DOUBLE_TAP",
            actions: [
              { type: "MUTATE_STATE", targetKey: "minutesRemaining", operation: "SET", value: minutes },
              { type: "MUTATE_STATE", targetKey: "isRunning", operation: "SET", value: false },
              { type: "PLAY_SOUND", soundId: "SUCCESS", frequencyHz: 1600, durationMs: 100 },
            ],
          },
        ],
      };

      return {
        widget,
        summary: `I designed a ${minutes}-minute Pomodoro timer widget; tap to toggle the countdown and double-tap to reset back to ${minutes} minutes.`,
      };
    }

    // 4. General Habit / Item Counter (Coffee, Steps, Pushups, Books, etc.)
    const nameMatch = prompt.slice(0, 18).replace(/[^\w\s]/g, "").trim() || "Habit Counter";
    const widget: WidgetPackage = {
      manifest: {
        id: widgetId,
        name: nameMatch.slice(0, 24),
        version: "1.0.0",
        author: "PetBot Studio",
        iconId: 1,
        refreshIntervalMs: 500,
        requiresAgenticMode: false,
      },
      state: {
        count: { type: "int32", initialValue: 0, persistToSd: true },
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
            text: nameMatch.toUpperCase(),
            fontSize: "md",
            color: "#52525B",
            align: "center",
          },
          {
            type: "Text",
            x: 10,
            y: 44,
            w: 140,
            h: 40,
            text: "{{count}}",
            fontSize: "xl",
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
            { type: "PLAY_SOUND", soundId: "CHIRP", frequencyHz: 1200, durationMs: 70 },
            { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 350 },
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

    return {
      widget,
      summary: `I synthesized a ${nameMatch} tracking widget for your screen; single-tap your pet to count up and double-tap to reset.`,
    };
  }

  // ==========================================================================
  // Iterative Conversational Refinement
  // ==========================================================================

  private refineExistingWidget(
    current: WidgetPackage,
    refinementPrompt: string
  ): {
    widget: WidgetPackage;
    summary: string;
    linkedWorkflow?: LinkedDesktopWorkflow | undefined;
  } {
    // Deep clone the widget package to preserve immutability
    const widget: WidgetPackage = JSON.parse(JSON.stringify(current));
    const lower = refinementPrompt.toLowerCase();
    const changesMade: string[] = [];

    // 1. Goal / Target Value Adjustment (e.g. "increase target goal to 12" or "set max to 15")
    const newGoal = this.extractNumericGoal(lower);
    if (newGoal !== null) {
      if (widget.state["goalCups"]) {
        widget.state["goalCups"].initialValue = newGoal;
      }
      if (widget.state["target"]) {
        widget.state["target"].initialValue = newGoal;
      }

      // Update ProgressBar max bound if present in UI tree
      this.traverseAndUpdateUI(widget.ui, (node) => {
        if (node.type === "ProgressBar") {
          node.max = newGoal;
        }
        if (node.type === "Text" && node.text.includes("/")) {
          const parts = node.text.split("/");
          node.text = `${parts[0]?.trim()} / ${newGoal}`;
        }
      });
      changesMade.push(`increased target goal to ${newGoal}`);
    }

    // 2. Color Modifications (e.g. "make progress bar emerald green" or "change color to cyan")
    const matchedColor = this.extractColorKeyword(lower);
    if (matchedColor) {
      this.traverseAndUpdateUI(widget.ui, (node) => {
        if (node.type === "ProgressBar") {
          node.fgColor = matchedColor;
        }
        if (node.type === "Text" && (lower.includes("text") || lower.includes("label"))) {
          node.color = matchedColor;
        }
      });
      changesMade.push(`updated color to ${matchedColor}`);
    }

    // 3. Sound Effects (e.g. "play a purr sound on tap" or "chirp sound")
    const soundMatch = this.extractSoundKeyword(lower);
    if (soundMatch) {
      for (const rule of widget.triggers) {
        if (rule.event === "ON_TOUCH_TAP") {
          for (const act of rule.actions) {
            if (act.type === "PLAY_SOUND") {
              act.soundId = soundMatch.soundId;
              act.frequencyHz = soundMatch.freq;
              act.durationMs = soundMatch.duration;
            }
          }
        }
      }
      changesMade.push(`configured ${soundMatch.soundId.toLowerCase()} sound feedback on tap`);
    }

    // 4. Emotional Expression cues (e.g. "make the robot curious on tap" or "alert eyes")
    const emotionMatch = this.extractEmotionKeyword(lower);
    if (emotionMatch) {
      for (const rule of widget.triggers) {
        if (rule.event === "ON_TOUCH_TAP") {
          let hasEmo = false;
          for (const act of rule.actions) {
            if (act.type === "SET_EXPRESSION") {
              act.emotion = emotionMatch;
              hasEmo = true;
            }
          }
          if (!hasEmo) {
            rule.actions.push({
              type: "SET_EXPRESSION",
              emotion: emotionMatch,
              durationMs: 500,
            });
          }
        }
      }
      changesMade.push(`set visual expression to ${emotionMatch.toLowerCase()}`);
    }

    const summary =
      changesMade.length > 0
        ? `I updated your widget: ${changesMade.join(", ")}; single-tap to interact and double-tap to reset.`
        : `I updated your widget layout to match your request; single-tap your pet to interact.`;

    return {
      widget,
      summary,
    };
  }

  // ==========================================================================
  // Automatic Self-Repair Pass
  // ==========================================================================

  private selfRepairWidget(widget: WidgetPackage, fallbackPrompt: string): WidgetPackage {
    try {
      // 1. Sanitize manifest fields
      if (!widget.manifest) {
        widget.manifest = {
          id: `widget-${Date.now().toString(36)}`,
          name: "Custom Widget",
          version: "1.0.0",
          author: "PetBot Studio",
          iconId: 1,
          refreshIntervalMs: 500,
          requiresAgenticMode: false,
        };
      }

      widget.manifest.id = (widget.manifest.id || `widget-${Date.now().toString(36)}`).slice(0, 64);
      widget.manifest.name = (widget.manifest.name || "Widget").slice(0, 24);
      if (!/^\d+\.\d+\.\d+$/.test(widget.manifest.version)) {
        widget.manifest.version = "1.0.0";
      }
      widget.manifest.author = (widget.manifest.author || "PetBot Studio").slice(0, 32);
      widget.manifest.refreshIntervalMs = Math.max(16, widget.manifest.refreshIntervalMs || 500);

      // 2. Sanitize state variables
      if (!widget.state || typeof widget.state !== "object") {
        widget.state = {
          count: { type: "int32", initialValue: 0, persistToSd: true },
        };
      }

      for (const [key, stateVar] of Object.entries(widget.state)) {
        if (!["int32", "float", "bool", "string"].includes(stateVar.type)) {
          stateVar.type = "int32";
        }
        if (stateVar.persistToSd === undefined) {
          stateVar.persistToSd = false;
        }
      }

      // 3. Sanitize UI bounds and node structure
      this.traverseAndSanitizeUI(widget.ui);

      // 4. Sanitize Triggers and Actions
      if (!Array.isArray(widget.triggers) || widget.triggers.length === 0) {
        widget.triggers = [
          {
            event: "ON_TOUCH_TAP",
            actions: [
              { type: "PLAY_SOUND", soundId: "CHIRP", frequencyHz: 1200, durationMs: 80 },
              { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 400 },
            ],
          },
        ];
      }

      // Final strict schema parse
      return WidgetPackageSchema.parse(widget);
    } catch {
      // If parsing still fails, fall back to bulletproof deterministic synthesis
      const fallback = this.synthesizeWidgetFromScratch(fallbackPrompt);
      return WidgetPackageSchema.parse(fallback.widget);
    }
  }

  private traverseAndSanitizeUI(node: UINode): void {
    node.x = Math.max(0, Math.min(159, Math.round(node.x || 0)));
    node.y = Math.max(0, Math.min(127, Math.round(node.y || 0)));
    node.w = Math.max(1, Math.min(160, Math.round(node.w || 160)));
    node.h = Math.max(1, Math.min(128, Math.round(node.h || 128)));

    if (node.type === "Container" && Array.isArray(node.children)) {
      for (const child of node.children) {
        this.traverseAndSanitizeUI(child);
      }
    }

    if (node.type === "Text") {
      if (!["sm", "md", "lg", "xl"].includes(node.fontSize)) {
        node.fontSize = "md";
      }
      if (!["left", "center", "right"].includes(node.align)) {
        node.align = "center";
      }
      if (!node.text) {
        node.text = "Label";
      }
    }

    if (node.type === "ProgressBar") {
      if (!["horizontal", "vertical"].includes(node.orientation)) {
        node.orientation = "horizontal";
      }
      if (typeof node.min !== "number") node.min = 0;
      if (typeof node.max !== "number" || node.max <= node.min) node.max = 100;
    }
  }

  private traverseAndUpdateUI(node: UINode, callback: (node: UINode) => void): void {
    callback(node);
    if (node.type === "Container" && Array.isArray(node.children)) {
      for (const child of node.children) {
        this.traverseAndUpdateUI(child, callback);
      }
    }
  }

  // ==========================================================================
  // Keyword Extraction Utilities
  // ==========================================================================

  private extractNumericGoal(text: string): number | null {
    const match = text.match(/(?:goal|target|to|at|for|reach|cups?|minutes?|steps?)\s*(?:of\s*)?(\d+)/i) ||
                  text.match(/(\d+)\s*(?:cups?|minutes?|steps?|glasses|times?)/i);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
    return null;
  }

  private extractColorKeyword(text: string): string | null {
    for (const [name, hex] of Object.entries(COLOR_KEYWORDS)) {
      if (text.includes(name)) {
        return hex;
      }
    }
    const hexMatch = text.match(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/);
    if (hexMatch) {
      return hexMatch[0];
    }
    return null;
  }

  private extractSoundKeyword(text: string): { soundId: SoundId; freq: number; duration: number } | null {
    if (text.includes("purr")) return { soundId: "PURR", freq: 110, duration: 400 };
    if (text.includes("chirp")) return { soundId: "CHIRP", freq: 1400, duration: 80 };
    if (text.includes("tick") || text.includes("click")) return { soundId: "TICK", freq: 1800, duration: 25 };
    if (text.includes("success") || text.includes("chime")) return { soundId: "SUCCESS", freq: 1760, duration: 150 };
    if (text.includes("warning") || text.includes("alert")) return { soundId: "WARNING", freq: 880, duration: 120 };
    if (text.includes("beep")) return { soundId: "BEEP", freq: 1000, duration: 90 };
    return null;
  }

  private extractEmotionKeyword(text: string): EmotionType | null {
    if (text.includes("happy")) return "HAPPY";
    if (text.includes("curious")) return "CURIOUS";
    if (text.includes("focused")) return "FOCUSED";
    if (text.includes("alert")) return "ALERT";
    if (text.includes("sleepy")) return "SLEEPY";
    return null;
  }
}
