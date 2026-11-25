import {
  WidgetPackageSchema,
  compileWidgetToBytecode,
  type WidgetPackage,
  type UINode,
  type TextNode,
  type ContainerNode,
  type ProgressBarNode,
  type ColorValue,
  type FontSize,
  type EmotionType,
  type TriggerRule,
  type Action,
} from "@petbot/widget-schema";

import type { ChatMessage } from "../store/usePetBotStore.js";

export interface GenerateWidgetResult {
  widget: WidgetPackage;
  replyExplanation: string;
  bytecode: Uint8Array;
  compilationTimeMs: number;
  modeUsed: "cloud-llm" | "local-intent";
}

/**
 * System prompt schema instructions used when forwarding prompts to cloud LLMs
 */
export const STUDIO_AI_SYSTEM_PROMPT = `You are the PetBot Magic Studio AI Co-Designer.
Your role is to translate user natural language requests into valid PetBot WidgetPackage JSON objects.
Rules:
1. Target screen: 160x128 landscape pixels (x: 0..159, y: 0..127, w: 1..160, h: 1..128).
2. The user is a consumer who must never see code, node graphs, or technical JSON.
3. Use UI nodes: Container, Text, ProgressBar, Sparkline, Icon, PetExpression, List.
4. Triggers: ON_TOUCH_TAP, ON_TOUCH_DOUBLE_TAP, ON_TOUCH_LONG_PRESS, ON_TOUCH_PETTING, ON_TIMER_TICK, ON_LOAD.
5. Actions: MUTATE_STATE (SET, INCREMENT, DECREMENT, TOGGLE), PLAY_SOUND (CHIRP, PURR, SUCCESS, WARNING, TICK, BEEP), SET_EXPRESSION (IDLE, HAPPY, CURIOUS, SLEEPY, FOCUSED, SPEAKING, LISTENING, ALERT), EMIT_HARNESS_RPC.
Output ONLY valid JSON matching WidgetPackageSchema with no markdown backticks or explanation.`;

export class AiStudioCompiler {
  private static instance: AiStudioCompiler | null = null;
  private endpointUrl = "/api/v1/studio/generate";

  public static getInstance(): AiStudioCompiler {
    if (!AiStudioCompiler.instance) {
      AiStudioCompiler.instance = new AiStudioCompiler();
    }
    return AiStudioCompiler.instance;
  }

  public setEndpoint(url: string): void {
    this.endpointUrl = url;
  }

  /**
   * Main entrypoint: synthesizes or refines a widget from natural language.
   * Seamlessly tries the Cloud LLM endpoint first, falling back to the Instant Local Intent Engine.
   */
  public async generateOrRefine(
    prompt: string,
    currentWidget?: WidgetPackage,
    chatHistory?: ChatMessage[]
  ): Promise<GenerateWidgetResult> {
    const trimmed = prompt.trim();
    const startTime = performance.now();

    // 1. Attempt Cloud LLM Structured Generation if available
    if (typeof window !== "undefined" && window.location?.origin) {
      try {
        const cloudResult = await this.tryCloudGeneration(trimmed, currentWidget, chatHistory);
        if (cloudResult) {
          const validated = WidgetPackageSchema.parse(cloudResult.widget);
          const bytecode = compileWidgetToBytecode(validated);
          const duration = performance.now() - startTime;
          return {
            widget: validated,
            replyExplanation: cloudResult.explanation || this.summarizeWidgetForUser(validated),
            bytecode,
            compilationTimeMs: Math.round(duration * 10) / 10,
            modeUsed: "cloud-llm",
          };
        }
      } catch {
        // Fall back to instant local intent engine
      }
    }

    // 2. Instant Smart Local Intent Engine (Zero-Latency Offline Fallback)
    const localWidget = this.synthesizeLocalIntent(trimmed, currentWidget);
    const validated = WidgetPackageSchema.parse(localWidget);
    const compileStart = performance.now();
    const bytecode = compileWidgetToBytecode(validated);
    const duration = performance.now() - compileStart;

    const explanation = this.generateExplanation(trimmed, validated, Boolean(currentWidget));

    return {
      widget: validated,
      replyExplanation: explanation,
      bytecode,
      compilationTimeMs: Math.max(0.1, Math.round(duration * 10) / 10),
      modeUsed: "local-intent",
    };
  }

  /**
   * Validates and compiles any widget package to binary PBWG bytecode.
   */
  public compileToBytecode(widget: WidgetPackage): {
    bytecode: Uint8Array;
    compilationTimeMs: number;
  } {
    const start = performance.now();
    const validated = WidgetPackageSchema.parse(widget);
    const bytecode = compileWidgetToBytecode(validated);
    const duration = performance.now() - start;
    return {
      bytecode,
      compilationTimeMs: Math.max(0.1, Math.round(duration * 10) / 10),
    };
  }

  // ============================================================================
  // Cloud LLM Structured Output Pipeline
  // ============================================================================

  private async tryCloudGeneration(
    prompt: string,
    currentWidget?: WidgetPackage,
    chatHistory?: ChatMessage[]
  ): Promise<{ widget: unknown; explanation?: string } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500); // 3.5s fast timeout

    try {
      const response = await fetch(this.endpointUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          currentWidget,
          chatHistory: chatHistory?.slice(-4), // Send last 4 turns for context
          systemPrompt: STUDIO_AI_SYSTEM_PROMPT,
        }),
        signal: controller.signal,
      });

      if (!response.ok) return null;

      const data = await response.json();
      if (data && data.widget) {
        return {
          widget: data.widget,
          explanation: data.explanation,
        };
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ============================================================================
  // Instant Smart Local Intent Engine (Deterministic Offline Synthesizer)
  // ============================================================================

  private synthesizeLocalIntent(
    prompt: string,
    currentWidget?: WidgetPackage
  ): WidgetPackage {
    const lower = prompt.toLowerCase();

    // Check if this is an iterative refinement of an existing widget
    if (currentWidget && this.isRefinementIntent(lower)) {
      return this.refineExistingWidget(lower, currentWidget);
    }

    // Otherwise, generate a fresh specialized widget
    if (lower.includes("hydrat") || lower.includes("water") || lower.includes("drink") || lower.includes("cup")) {
      return this.buildHydrationWidget(prompt);
    }

    if (
      lower.includes("focus") ||
      lower.includes("pomodoro") ||
      lower.includes("timer") ||
      lower.includes("deep work") ||
      lower.includes("study")
    ) {
      return this.buildFocusTimerWidget(prompt);
    }

    if (
      lower.includes("mute") ||
      lower.includes("mic") ||
      lower.includes("meeting") ||
      lower.includes("lock") ||
      lower.includes("shortcut") ||
      lower.includes("pc")
    ) {
      return this.buildPcMeetingHarnessWidget(prompt);
    }

    if (
      lower.includes("habit") ||
      lower.includes("streak") ||
      lower.includes("read") ||
      lower.includes("task") ||
      lower.includes("check")
    ) {
      return this.buildHabitTrackerWidget(prompt);
    }

    if (
      lower.includes("cpu") ||
      lower.includes("ram") ||
      lower.includes("stock") ||
      lower.includes("crypto") ||
      lower.includes("bitcoin") ||
      lower.includes("monitor") ||
      lower.includes("hud")
    ) {
      return this.buildCyberMonitorWidget(prompt);
    }

    if (
      lower.includes("breath") ||
      lower.includes("relax") ||
      lower.includes("calm") ||
      lower.includes("zen") ||
      lower.includes("sleep")
    ) {
      return this.buildBreathingRelaxWidget(prompt);
    }

    if (
      lower.includes("score") ||
      lower.includes("game") ||
      lower.includes("counter") ||
      lower.includes("point")
    ) {
      return this.buildScoreboardWidget(prompt);
    }

    // Default intelligent companion widget
    return this.buildGeneralCompanionWidget(prompt);
  }

  private isRefinementIntent(lower: string): boolean {
    const refinementKeywords = [
      "bigger",
      "larger",
      "smaller",
      "color",
      "green",
      "cyan",
      "pink",
      "orange",
      "amber",
      "purple",
      "red",
      "blue",
      "emerald",
      "happy",
      "sleepy",
      "focused",
      "alert",
      "sound",
      "goal",
      "change",
      "make",
      "switch",
      "increase",
      "decrease",
    ];
    return refinementKeywords.some((kw) => lower.includes(kw));
  }

  /**
   * Refines an existing widget based on natural language edit commands
   */
  private refineExistingWidget(
    lower: string,
    existing: WidgetPackage
  ): WidgetPackage {
    // Deep clone
    const refined: WidgetPackage = JSON.parse(JSON.stringify(existing));

    // 1. Text size adjustments ("make text bigger", "larger numbers")
    if (lower.includes("bigger") || lower.includes("larger")) {
      this.transformNodes(refined.ui, (node) => {
        if (node.type === "Text") {
          const nextSizes: Record<FontSize, FontSize> = {
            sm: "md",
            md: "lg",
            lg: "xl",
            xl: "xl",
          };
          (node as TextNode).fontSize = nextSizes[(node as TextNode).fontSize] || "lg";
        }
      });
    } else if (lower.includes("smaller") || lower.includes("compact")) {
      this.transformNodes(refined.ui, (node) => {
        if (node.type === "Text") {
          const prevSizes: Record<FontSize, FontSize> = {
            xl: "lg",
            lg: "md",
            md: "sm",
            sm: "sm",
          };
          (node as TextNode).fontSize = prevSizes[(node as TextNode).fontSize] || "sm";
        }
      });
    }

    // 2. Color adjustments ("change color to pink / emerald / amber / cyan")
    let targetColor: string | null = null;
    if (lower.includes("pink") || lower.includes("rose") || lower.includes("magenta")) {
      targetColor = "#FF4B82";
    } else if (lower.includes("green") || lower.includes("emerald") || lower.includes("lime")) {
      targetColor = "#50FA7B";
    } else if (lower.includes("cyan") || lower.includes("blue") || lower.includes("ice")) {
      targetColor = "#00F0FF";
    } else if (lower.includes("orange") || lower.includes("amber") || lower.includes("fire")) {
      targetColor = "#FF4D2E";
    } else if (lower.includes("purple") || lower.includes("violet")) {
      targetColor = "#BD93F9";
    } else if (lower.includes("yellow") || lower.includes("gold")) {
      targetColor = "#F1FA8C";
    }

    if (targetColor) {
      this.transformNodes(refined.ui, (node) => {
        if (node.type === "ProgressBar") {
          (node as ProgressBarNode).fgColor = targetColor!;
        } else if (node.type === "Text" && (node as TextNode).color !== "#F4F5F8") {
          (node as TextNode).color = targetColor!;
        } else if (node.type === "Sparkline" || node.type === "Icon") {
          (node as any).color = targetColor!;
        }
      });
    }

    // 3. Goal adjustment ("increase goal to 12")
    const matchNumber = lower.match(/\b(\d+)\b/);
    if (matchNumber && (lower.includes("goal") || lower.includes("target") || lower.includes("to"))) {
      const newGoal = parseInt(matchNumber[1]!, 10);
      if (!isNaN(newGoal) && newGoal > 0) {
        if (refined.state["dailyGoal"]) {
          refined.state["dailyGoal"].initialValue = newGoal;
        }
        this.transformNodes(refined.ui, (node) => {
          if (node.type === "ProgressBar") {
            (node as ProgressBarNode).max = newGoal;
          }
        });
      }
    }

    // 4. Expression change ("make pet happy on tap", "look focused")
    let newEmotion: EmotionType | null = null;
    if (lower.includes("happy")) newEmotion = "HAPPY";
    else if (lower.includes("focused")) newEmotion = "FOCUSED";
    else if (lower.includes("sleepy")) newEmotion = "SLEEPY";
    else if (lower.includes("curious")) newEmotion = "CURIOUS";
    else if (lower.includes("alert")) newEmotion = "ALERT";

    if (newEmotion) {
      this.transformNodes(refined.ui, (node) => {
        if (node.type === "PetExpression") {
          (node as any).emotion = newEmotion!;
        }
      });

      // Update tap trigger to celebrate with this emotion
      const tapRule = refined.triggers.find((t) => t.event === "ON_TOUCH_TAP");
      if (tapRule) {
        const emoAct = tapRule.actions.find((a) => a.type === "SET_EXPRESSION");
        if (emoAct) {
          (emoAct as any).emotion = newEmotion;
        } else {
          tapRule.actions.push({
            type: "SET_EXPRESSION",
            emotion: newEmotion,
            durationMs: 1500,
          });
        }
      }
    }

    // 5. Sound refinement ("add happy sound on tap")
    if (lower.includes("sound") || lower.includes("chime") || lower.includes("chirp")) {
      const tapRule = refined.triggers.find((t) => t.event === "ON_TOUCH_TAP");
      if (tapRule && !tapRule.actions.some((a) => a.type === "PLAY_SOUND")) {
        tapRule.actions.push({
          type: "PLAY_SOUND",
          soundId: "CHIRP",
          frequencyHz: 1200,
          durationMs: 250,
        });
      }
    }

    refined.manifest.version = this.incrementPatchVersion(refined.manifest.version);
    return refined;
  }

  private transformNodes(node: UINode, visitor: (n: UINode) => void): void {
    visitor(node);
    if (node.type === "Container" && (node as ContainerNode).children) {
      for (const child of (node as ContainerNode).children!) {
        this.transformNodes(child, visitor);
      }
    }
  }

  private incrementPatchVersion(semver: string): string {
    const parts = semver.split(".").map((n) => parseInt(n, 10));
    if (parts.length === 3 && !parts.some(isNaN)) {
      return `${parts[0]}.${parts[1]}.${(parts[2] || 0) + 1}`;
    }
    return "1.0.1";
  }

  // ============================================================================
  // Template Generators
  // ============================================================================

  private buildHydrationWidget(prompt: string): WidgetPackage {
    const goalMatch = prompt.match(/\b(\d+)\s*(cups|glasses|water|oz)?/i);
    const goal = goalMatch && goalMatch[1] ? Math.max(4, parseInt(goalMatch[1], 10)) : 8;

    return {
      manifest: {
        id: `widget-hydration-${Date.now().toString(36)}`,
        name: "Hydration Dock",
        version: "1.0.0",
        author: "Magic Studio",
        iconId: 2, // Water drop
        refreshIntervalMs: 1000,
        requiresAgenticMode: false,
      },
      state: {
        cupsDrank: { type: "int32", initialValue: 0, persistToSd: true },
        dailyGoal: { type: "int32", initialValue: goal, persistToSd: true },
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
            y: 6,
            w: 144,
            h: 16,
            text: "HYDRATION DOCK",
            fontSize: "sm",
            color: "#52525B",
            align: "center",
          },
          {
            type: "PetExpression",
            x: 10,
            y: 26,
            w: 60,
            h: 56,
            emotion: "HAPPY",
            size: 50,
          },
          {
            type: "Text",
            x: 74,
            y: 38,
            w: 78,
            h: 22,
            text: "{{cupsDrank}} / " + goal + " CUPS",
            fontSize: "md",
            color: "#111111",
            align: "center",
          },
          {
            type: "ProgressBar",
            x: 16,
            y: 88,
            w: 128,
            h: 10,
            valueBinding: "cupsDrank",
            min: 0,
            max: goal,
            fgColor: "#111111",
            bgColor: "#E4E4E7",
            orientation: "horizontal",
          },
          {
            type: "Text",
            x: 8,
            y: 104,
            w: 144,
            h: 16,
            text: "Tap robot to drink",
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
            { type: "PLAY_SOUND", soundId: "CHIRP", frequencyHz: 1400, durationMs: 120 },
            { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 1800 },
          ],
        },
        {
          event: "ON_TOUCH_DOUBLE_TAP",
          actions: [
            { type: "MUTATE_STATE", targetKey: "cupsDrank", operation: "SET", value: 0 },
            { type: "PLAY_SOUND", soundId: "TICK", frequencyHz: 800, durationMs: 50 },
            { type: "SET_EXPRESSION", emotion: "CURIOUS", durationMs: 1200 },
          ],
        },
        {
          event: "ON_TOUCH_PETTING",
          actions: [
            { type: "PLAY_SOUND", soundId: "PURR", frequencyHz: 65, durationMs: 550 },
            { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 2500 },
          ],
        },
      ],
    };
  }

  private buildFocusTimerWidget(prompt: string): WidgetPackage {
    const timeMatch = prompt.match(/\b(\d+)\s*(min|minute|m)?/i);
    const duration = timeMatch && timeMatch[1] ? parseInt(timeMatch[1], 10) : 25;

    return {
      manifest: {
        id: `widget-focus-${Date.now().toString(36)}`,
        name: "Deep Work Dock",
        version: "1.0.0",
        author: "Magic Studio",
        iconId: 3, // Clock
        refreshIntervalMs: 1000,
        requiresAgenticMode: false,
      },
      state: {
        minutesLeft: { type: "int32", initialValue: duration, persistToSd: false },
        isActive: { type: "bool", initialValue: true, persistToSd: false },
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
            y: 6,
            w: 144,
            h: 16,
            text: "FOCUS SESSION",
            fontSize: "sm",
            color: "#52525B",
            align: "center",
          },
          {
            type: "PetExpression",
            x: 8,
            y: 26,
            w: 62,
            h: 56,
            emotion: "FOCUSED",
            size: 50,
          },
          {
            type: "Text",
            x: 74,
            y: 38,
            w: 78,
            h: 24,
            text: "{{minutesLeft}} MIN",
            fontSize: "lg",
            color: "#111111",
            align: "center",
          },
          {
            type: "ProgressBar",
            x: 16,
            y: 88,
            w: 128,
            h: 8,
            valueBinding: "minutesLeft",
            min: 0,
            max: duration,
            fgColor: "#111111",
            bgColor: "#E4E4E7",
            orientation: "horizontal",
          },
          {
            type: "Text",
            x: 8,
            y: 104,
            w: 144,
            h: 16,
            text: "Hold to reset",
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
            { type: "MUTATE_STATE", targetKey: "isActive", operation: "TOGGLE" },
            { type: "PLAY_SOUND", soundId: "TICK", frequencyHz: 1800, durationMs: 20 },
            { type: "SET_EXPRESSION", emotion: "FOCUSED", durationMs: 2000 },
          ],
        },
        {
          event: "ON_TOUCH_LONG_PRESS",
          actions: [
            { type: "MUTATE_STATE", targetKey: "minutesLeft", operation: "SET", value: duration },
            { type: "PLAY_SOUND", soundId: "SUCCESS", frequencyHz: 1000, durationMs: 300 },
            { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 2000 },
          ],
        },
      ],
    };
  }

  private buildPcMeetingHarnessWidget(_prompt: string): WidgetPackage {
    return {
      manifest: {
        id: `widget-meeting-${Date.now().toString(36)}`,
        name: "PC Control Dock",
        version: "1.0.0",
        author: "Magic Studio",
        iconId: 4, // Zap
        refreshIntervalMs: 500,
        requiresAgenticMode: true,
      },
      state: {
        micMuted: { type: "bool", initialValue: false, persistToSd: false },
        dndMode: { type: "bool", initialValue: true, persistToSd: false },
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
            y: 6,
            w: 144,
            h: 16,
            text: "DESKTOP SHORTCUTS",
            fontSize: "sm",
            color: "#52525B",
            align: "center",
          },
          {
            type: "PetExpression",
            x: 8,
            y: 26,
            w: 60,
            h: 72,
            emotion: "LISTENING",
            size: 52,
          },
          {
            type: "Text",
            x: 72,
            y: 32,
            w: 82,
            h: 18,
            text: "TAP: Mute Mic",
            fontSize: "sm",
            color: "#111111",
            align: "left",
          },
          {
            type: "Text",
            x: 72,
            y: 54,
            w: 82,
            h: 18,
            text: "2x: Play/Pause",
            fontSize: "sm",
            color: "#111111",
            align: "left",
          },
          {
            type: "Text",
            x: 72,
            y: 76,
            w: 82,
            h: 18,
            text: "Hold: Lock PC",
            fontSize: "sm",
            color: "#52525B",
            align: "left",
          },
        ],
      },
      triggers: [
        {
          event: "ON_TOUCH_TAP",
          actions: [
            { type: "MUTATE_STATE", targetKey: "micMuted", operation: "TOGGLE" },
            {
              type: "EMIT_HARNESS_RPC",
              actionId: "system_mute_mic",
              riskTier: "TIER_1_SAFE",
              payload: { device: "default_microphone" },
            },
            { type: "PLAY_SOUND", soundId: "CHIRP", frequencyHz: 1600, durationMs: 100 },
          ],
        },
        {
          event: "ON_TOUCH_DOUBLE_TAP",
          actions: [
            {
              type: "EMIT_HARNESS_RPC",
              actionId: "media_play_pause",
              riskTier: "TIER_1_SAFE",
              payload: {},
            },
            { type: "PLAY_SOUND", soundId: "CHIRP", frequencyHz: 1200, durationMs: 200 },
          ],
        },
        {
          event: "ON_TOUCH_LONG_PRESS",
          actions: [
            {
              type: "EMIT_HARNESS_RPC",
              actionId: "system_lock_screen",
              riskTier: "TIER_2_WORKFLOW",
              payload: {},
            },
            { type: "PLAY_SOUND", soundId: "WARNING", frequencyHz: 800, durationMs: 250 },
            { type: "SET_EXPRESSION", emotion: "ALERT", durationMs: 2000 },
          ],
        },
      ],
    };
  }

  private buildHabitTrackerWidget(prompt: string): WidgetPackage {
    const isReading = prompt.toLowerCase().includes("read") || prompt.toLowerCase().includes("book");
    const widgetName = isReading ? "Reading Habit" : "Habit Streak";
    const headerTitle = isReading ? "DAILY READING" : "DAILY HABIT";

    return {
      manifest: {
        id: `widget-habit-${Date.now().toString(36)}`,
        name: widgetName,
        version: "1.0.0",
        author: "Magic Studio",
        iconId: 7, // Checkmark
        refreshIntervalMs: 1000,
        requiresAgenticMode: false,
      },
      state: {
        streakDays: { type: "int32", initialValue: 5, persistToSd: true },
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
            y: 6,
            w: 144,
            h: 16,
            text: headerTitle,
            fontSize: "sm",
            color: "#52525B",
            align: "center",
          },
          {
            type: "PetExpression",
            x: 8,
            y: 26,
            w: 62,
            h: 56,
            emotion: "HAPPY",
            size: 50,
          },
          {
            type: "Text",
            x: 74,
            y: 38,
            w: 78,
            h: 24,
            text: "{{streakDays}} DAYS",
            fontSize: "lg",
            color: "#111111",
            align: "center",
          },
          {
            type: "ProgressBar",
            x: 16,
            y: 88,
            w: 128,
            h: 8,
            valueBinding: "streakDays",
            min: 0,
            max: 30,
            fgColor: "#111111",
            bgColor: "#E4E4E7",
            orientation: "horizontal",
          },
          {
            type: "Text",
            x: 8,
            y: 104,
            w: 144,
            h: 16,
            text: "Tap robot when done!",
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
            { type: "MUTATE_STATE", targetKey: "streakDays", operation: "INCREMENT", value: 1 },
            { type: "PLAY_SOUND", soundId: "SUCCESS", frequencyHz: 1200, durationMs: 300 },
            { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 2500 },
          ],
        },
      ],
    };
  }

  private buildCyberMonitorWidget(_prompt: string): WidgetPackage {
    return {
      manifest: {
        id: `widget-hud-${Date.now().toString(36)}`,
        name: "Cyber Monitor",
        version: "1.0.0",
        author: "Magic Studio",
        iconId: 4,
        refreshIntervalMs: 500,
        requiresAgenticMode: true,
      },
      state: {
        cpuUsage: { type: "int32", initialValue: 34, persistToSd: false },
        tempC: { type: "int32", initialValue: 48, persistToSd: false },
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
            y: 6,
            w: 144,
            h: 16,
            text: "SYSTEM MONITOR",
            fontSize: "sm",
            color: "#52525B",
            align: "center",
          },
          {
            type: "Sparkline",
            x: 12,
            y: 26,
            w: 84,
            h: 34,
            dataBinding: "cpuUsage",
            color: "#111111",
            lineWidth: 2,
            min: 0,
            max: 100,
          },
          {
            type: "PetExpression",
            x: 100,
            y: 24,
            w: 52,
            h: 44,
            emotion: "FOCUSED",
            size: 42,
          },
          {
            type: "Text",
            x: 12,
            y: 68,
            w: 136,
            h: 18,
            text: "CPU: {{cpuUsage}}%",
            fontSize: "md",
            color: "#111111",
            align: "left",
          },
          {
            type: "ProgressBar",
            x: 12,
            y: 88,
            w: 136,
            h: 7,
            valueBinding: "cpuUsage",
            min: 0,
            max: 100,
            fgColor: "#111111",
            bgColor: "#E4E4E7",
            orientation: "horizontal",
          },
          {
            type: "Text",
            x: 12,
            y: 102,
            w: 136,
            h: 16,
            text: "TEMP: {{tempC}}°C",
            fontSize: "sm",
            color: "#52525B",
            align: "left",
          },
        ],
      },
      triggers: [
        {
          event: "ON_TOUCH_TAP",
          actions: [
            { type: "PLAY_SOUND", soundId: "CHIRP", frequencyHz: 2000, durationMs: 80 },
            { type: "SET_EXPRESSION", emotion: "ALERT", durationMs: 1200 },
          ],
        },
      ],
    };
  }

  private buildBreathingRelaxWidget(_prompt: string): WidgetPackage {
    return {
      manifest: {
        id: `widget-zen-${Date.now().toString(36)}`,
        name: "Zen Rest",
        version: "1.0.0",
        author: "Magic Studio",
        iconId: 1, // Heart
        refreshIntervalMs: 1500,
        requiresAgenticMode: false,
      },
      state: {
        cycles: { type: "int32", initialValue: 0, persistToSd: false },
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
            y: 6,
            w: 144,
            h: 16,
            text: "BREATHE & REST",
            fontSize: "sm",
            color: "#52525B",
            align: "center",
          },
          {
            type: "PetExpression",
            x: 8,
            y: 26,
            w: 62,
            h: 60,
            emotion: "SLEEPY",
            size: 52,
          },
          {
            type: "Text",
            x: 74,
            y: 44,
            w: 78,
            h: 22,
            text: "Inhale · Exhale",
            fontSize: "sm",
            color: "#111111",
            align: "center",
          },
          {
            type: "Text",
            x: 8,
            y: 102,
            w: 144,
            h: 16,
            text: "Pet my head to purr",
            fontSize: "sm",
            color: "#71717A",
            align: "center",
          },
        ],
      },
      triggers: [
        {
          event: "ON_TOUCH_PETTING",
          actions: [
            { type: "MUTATE_STATE", targetKey: "cycles", operation: "INCREMENT", value: 1 },
            { type: "PLAY_SOUND", soundId: "PURR", frequencyHz: 65, durationMs: 600 },
            { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 2500 },
          ],
        },
        {
          event: "ON_TOUCH_TAP",
          actions: [
            { type: "PLAY_SOUND", soundId: "PURR", frequencyHz: 350, durationMs: 600 },
            { type: "SET_EXPRESSION", emotion: "SLEEPY", durationMs: 2000 },
          ],
        },
      ],
    };
  }

  private buildScoreboardWidget(_prompt: string): WidgetPackage {
    return {
      manifest: {
        id: `widget-score-${Date.now().toString(36)}`,
        name: "Scoreboard",
        version: "1.0.0",
        author: "Magic Studio",
        iconId: 4,
        refreshIntervalMs: 500,
        requiresAgenticMode: false,
      },
      state: {
        scoreA: { type: "int32", initialValue: 0, persistToSd: false },
        scoreB: { type: "int32", initialValue: 0, persistToSd: false },
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
            y: 6,
            w: 144,
            h: 16,
            text: "GAME SCORE",
            fontSize: "sm",
            color: "#52525B",
            align: "center",
          },
          {
            type: "Text",
            x: 8,
            y: 26,
            w: 144,
            h: 30,
            text: "{{scoreA}} - {{scoreB}}",
            fontSize: "xl",
            color: "#111111",
            align: "center",
          },
          {
            type: "PetExpression",
            x: 52,
            y: 56,
            w: 56,
            h: 36,
            emotion: "HAPPY",
            size: 36,
          },
          {
            type: "Text",
            x: 8,
            y: 94,
            w: 144,
            h: 14,
            text: "Tap: +P1 | 2x: +P2",
            fontSize: "sm",
            color: "#111111",
            align: "center",
          },
          {
            type: "Text",
            x: 8,
            y: 110,
            w: 144,
            h: 14,
            text: "Hold: Reset",
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
            { type: "MUTATE_STATE", targetKey: "scoreA", operation: "INCREMENT", value: 1 },
            { type: "PLAY_SOUND", soundId: "TICK", frequencyHz: 1600, durationMs: 25 },
            { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 1200 },
          ],
        },
        {
          event: "ON_TOUCH_DOUBLE_TAP",
          actions: [
            { type: "MUTATE_STATE", targetKey: "scoreB", operation: "INCREMENT", value: 1 },
            { type: "PLAY_SOUND", soundId: "CHIRP", frequencyHz: 1200, durationMs: 80 },
            { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 1200 },
          ],
        },
        {
          event: "ON_TOUCH_LONG_PRESS",
          actions: [
            { type: "MUTATE_STATE", targetKey: "scoreA", operation: "SET", value: 0 },
            { type: "MUTATE_STATE", targetKey: "scoreB", operation: "SET", value: 0 },
            { type: "PLAY_SOUND", soundId: "SUCCESS", frequencyHz: 900, durationMs: 200 },
            { type: "SET_EXPRESSION", emotion: "CURIOUS", durationMs: 1500 },
          ],
        },
      ],
    };
  }

  private buildGeneralCompanionWidget(prompt: string): WidgetPackage {
    const title = prompt.length > 16 ? prompt.slice(0, 16).trim() : prompt;
    return {
      manifest: {
        id: `widget-tool-${Date.now().toString(36)}`,
        name: title || "Smart Companion",
        version: "1.0.0",
        author: "Magic Studio",
        iconId: 4,
        refreshIntervalMs: 1000,
        requiresAgenticMode: false,
      },
      state: {
        counter: { type: "int32", initialValue: 1, persistToSd: false },
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
            y: 6,
            w: 144,
            h: 16,
            text: title.toUpperCase(),
            fontSize: "sm",
            color: "#52525B",
            align: "center",
          },
          {
            type: "PetExpression",
            x: 8,
            y: 26,
            w: 60,
            h: 56,
            emotion: "HAPPY",
            size: 48,
          },
          {
            type: "Text",
            x: 72,
            y: 38,
            w: 80,
            h: 22,
            text: "LEVEL: {{counter}}",
            fontSize: "md",
            color: "#111111",
            align: "center",
          },
          {
            type: "ProgressBar",
            x: 16,
            y: 88,
            w: 128,
            h: 8,
            valueBinding: "counter",
            min: 0,
            max: 20,
            fgColor: "#111111",
            bgColor: "#E4E4E7",
            orientation: "horizontal",
          },
          {
            type: "Text",
            x: 8,
            y: 104,
            w: 144,
            h: 16,
            text: "Tap robot to interact",
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
            { type: "MUTATE_STATE", targetKey: "counter", operation: "INCREMENT", value: 1 },
            { type: "PLAY_SOUND", soundId: "CHIRP", frequencyHz: 1500, durationMs: 120 },
            { type: "SET_EXPRESSION", emotion: "HAPPY", durationMs: 1500 },
          ],
        },
      ],
    };
  }

  // ============================================================================
  // Consumer-Friendly Explanation Generator (Zero-Code)
  // ============================================================================

  /**
   * Generates a plain-English explanation of how the widget works for non-technical users.
   */
  public summarizeWidgetForUser(widget: WidgetPackage): string {
    const bullets: string[] = [];
    const triggers = widget.triggers || [];

    for (const rule of triggers) {
      const actions = rule.actions;
      const descList: string[] = [];

      for (const a of actions) {
        if (a.type === "MUTATE_STATE") {
          if (a.operation === "INCREMENT") descList.push("advances your count");
          else if (a.operation === "DECREMENT") descList.push("decreases your count");
          else if (a.operation === "SET") descList.push("resets your progress");
          else if (a.operation === "TOGGLE") descList.push("toggles on/off");
        } else if (a.type === "PLAY_SOUND") {
          descList.push("plays a cheerful audio chime");
        } else if (a.type === "SET_EXPRESSION") {
          descList.push(`makes your pet smile with a ${a.emotion.toLowerCase()} face`);
        } else if (a.type === "EMIT_HARNESS_RPC") {
          descList.push(`triggers your desktop shortcut (${a.actionId.replace(/_/g, " ")})`);
        }
      }

      const eventNames: Record<string, string> = {
        ON_TOUCH_TAP: "Single Tap",
        ON_TOUCH_DOUBLE_TAP: "Double Tap",
        ON_TOUCH_LONG_PRESS: "Hold / Long Press",
        ON_TOUCH_PETTING: "Gentle Head Petting",
        ON_TIMER_TICK: "Automatic Interval",
        ON_LOAD: "When Screen Opens",
      };

      const eventLabel = eventNames[rule.event] || rule.event;
      if (descList.length > 0) {
        bullets.push(`• **${eventLabel}**: ${descList.join(", and ")}.`);
      }
    }

    if (bullets.length === 0) {
      return "Ready to view on your robot screen.";
    }

    return bullets.join("\n");
  }

  private generateExplanation(
    prompt: string,
    widget: WidgetPackage,
    isRefinement: boolean
  ): string {
    if (isRefinement) {
      return `I've updated your widget based on: "${prompt}". Check out the live demo on the virtual screen!`;
    }
    return `I created **${widget.manifest.name}** for you! Try tapping or petting the virtual robot on the right to test how it responds.`;
  }
}

export const aiStudioCompiler = AiStudioCompiler.getInstance();
