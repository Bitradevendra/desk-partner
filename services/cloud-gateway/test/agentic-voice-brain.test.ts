import { describe, it, expect, vi } from "vitest";
import {
  AgenticVoiceBrain,
  PET_PERSONA_PROFILES,
  parseEmotionFromTag,
} from "../src/voice/agentic-voice-brain.js";
import {
  EmotionId,
  FrameType,
  decodeFrame,
  decodeControlPayload,
  HarnessRpcReqSchema,
} from "@petbot/protocol";
import { BYTECODE_MAGIC } from "@petbot/widget-schema";

describe("AgenticVoiceBrain - Persona Management & System Prompts", () => {
  it("initializes with default Nova persona and allows switching to Atlas or Pixel", () => {
    const brain = new AgenticVoiceBrain();
    expect(brain.getPersona()).toBe("Nova");

    const novaProfile = PET_PERSONA_PROFILES.Nova;
    expect(novaProfile.name).toBe("Nova");
    expect(novaProfile.defaultEmotion).toBe(EmotionId.HAPPY);
    expect(novaProfile.systemPrompt).toContain("You are Nova");

    brain.setPersona("Atlas");
    expect(brain.getPersona()).toBe("Atlas");
    const atlasProfile = PET_PERSONA_PROFILES.Atlas;
    expect(atlasProfile.defaultEmotion).toBe(EmotionId.FOCUSED);

    brain.setPersona("Pixel");
    expect(brain.getPersona()).toBe("Pixel");
  });
});

describe("AgenticVoiceBrain - Real-Time Tool Execution", () => {
  const brain = new AgenticVoiceBrain({ persona: "Nova" });

  it("executes trigger_desktop_harness_action and emits valid HARNESS_RPC_REQ binary frame", () => {
    const toolCall = {
      id: "call_mute_1",
      name: "trigger_desktop_harness_action",
      arguments: { action: "toggleMicrophoneMute" },
    };

    const result = brain.executeTool(toolCall);
    expect(result.success).toBe(true);
    expect(result.toolName).toBe("trigger_desktop_harness_action");
    expect(result.outputFrame).toBeDefined();

    // Verify binary framing
    const decodedFrame = decodeFrame(result.outputFrame!);
    expect(decodedFrame.header.frameType).toBe(FrameType.HARNESS_RPC_REQ);
    expect(decodedFrame.header.magic).toBe(0x4250);

    // Verify payload schema
    const payload = decodeControlPayload(HarnessRpcReqSchema, decodedFrame.payload);
    expect(payload.method).toBe("toggleMicrophoneMute");
    expect(payload.callId).toContain("call_");
  });

  it("executes start_robot_pomodoro_timer and formats focus duration", () => {
    const toolCall = {
      id: "call_pomo_1",
      name: "start_robot_pomodoro_timer",
      arguments: { minutes: 25, label: "Deep Work" },
    };

    const result = brain.executeTool(toolCall);
    expect(result.success).toBe(true);
    expect(result.outputFrame).toBeDefined();

    const decoded = decodeFrame(result.outputFrame!);
    expect(decoded.header.frameType).toBe(FrameType.HARNESS_RPC_REQ);

    const payload = decodeControlPayload(HarnessRpcReqSchema, decoded.payload);
    expect(payload.method).toBe("start_timer");
    expect(payload.params.minutes).toBe(25);
    expect(payload.params.label).toBe("Deep Work");
  });

  it("executes save_quick_note_to_robot and packages sticky note payload", () => {
    const toolCall = {
      id: "call_note_1",
      name: "save_quick_note_to_robot",
      arguments: { text: "Review Phase 3 code", category: "TODO" },
    };

    const result = brain.executeTool(toolCall);
    expect(result.success).toBe(true);
    expect(result.outputFrame).toBeDefined();

    const decoded = decodeFrame(result.outputFrame!);
    const payload = decodeControlPayload(HarnessRpcReqSchema, decoded.payload);
    expect(payload.method).toBe("save_note");
    expect(payload.params.text).toBe("Review Phase 3 code");
    expect(payload.params.category).toBe("TODO");
  });

  it("compiles and deploys a custom 160x128 widget right from voice command", () => {
    const toolCall = {
      id: "call_widget_1",
      name: "create_and_deploy_custom_widget",
      arguments: {
        prompt: "Give me a coffee counter widget on your screen",
        widgetName: "Coffee Counter",
      },
    };

    const result = brain.executeTool(toolCall);
    expect(result.success).toBe(true);
    expect(result.outputFrame).toBeDefined();

    const decoded = decodeFrame(result.outputFrame!);
    expect(decoded.header.frameType).toBe(FrameType.WIDGET_DEPLOY);

    // Verify widget bytecode magic ('PBWG' = 0x50425747)
    const view = new DataView(
      decoded.payload.buffer,
      decoded.payload.byteOffset,
      decoded.payload.byteLength
    );
    expect(view.getUint32(0, false)).toBe(BYTECODE_MAGIC);
  });
});

describe("AgenticVoiceBrain - Conversational Intent Routing", () => {
  const brain = new AgenticVoiceBrain({ persona: "Nova" });

  it("routes 'mute my mic' to desktop harness action with focused emotion", async () => {
    const turn = await brain.processUserUtterance("Hey Nova, please mute my mic");

    expect(turn.spokenText).toContain("[FOCUSED]");
    expect(turn.spokenText).toContain("microphone mute");
    expect(turn.toolCallsExecuted).toHaveLength(1);
    expect(turn.toolCallsExecuted[0]?.toolName).toBe("trigger_desktop_harness_action");
    expect(turn.framesToSend).toHaveLength(1);
  });

  it("routes 'lock workstation' with alert emotion tag", async () => {
    const turn = await brain.processUserUtterance("Lock workstation now");

    expect(turn.spokenText).toContain("[ALERT]");
    expect(turn.spokenText).toContain("Workstation locked");
    expect(turn.framesToSend).toHaveLength(1);
  });

  it("routes 'start a 25-minute pomodoro timer' and returns timer frame", async () => {
    const turn = await brain.processUserUtterance("Can you start a 25-minute pomodoro timer?");

    expect(turn.spokenText).toContain("[FOCUSED]");
    expect(turn.spokenText).toContain("25-minute focus timer");
    expect(turn.toolCallsExecuted[0]?.toolName).toBe("start_robot_pomodoro_timer");
    expect(turn.framesToSend).toHaveLength(1);
  });

  it("routes 'create a water tracker widget' and returns WIDGET_DEPLOY frame", async () => {
    const turn = await brain.processUserUtterance("Create a water tracker widget on your screen");

    expect(turn.spokenText).toContain("[HAPPY]");
    expect(turn.spokenText).toContain("widget");
    expect(turn.toolCallsExecuted[0]?.toolName).toBe("create_and_deploy_custom_widget");
    expect(turn.framesToSend).toHaveLength(1);

    const frame = decodeFrame(turn.framesToSend[0]!);
    expect(frame.header.frameType).toBe(FrameType.WIDGET_DEPLOY);
  });

  it("handles general greeting with warm persona response", async () => {
    const turn = await brain.processUserUtterance("Hello robot!");

    expect(turn.spokenText).toContain("[HAPPY]");
    expect(turn.spokenText).toContain("Nova is online");
    expect(turn.toolCallsExecuted).toHaveLength(0);
  });
});

describe("AgenticVoiceBrain - Emotion Tag Parsing & Gemini Integration", () => {
  it("correctly parses inline emotion tags into EmotionId enum values", () => {
    expect(parseEmotionFromTag("[HAPPY] Hello human!")).toBe(EmotionId.HAPPY);
    expect(parseEmotionFromTag("[FOCUSED] Time for deep work.")).toBe(EmotionId.FOCUSED);
    expect(parseEmotionFromTag("[ALERT] Intruder detected!")).toBe(EmotionId.ALERT);
    expect(parseEmotionFromTag("[SLEEPY] Goodnight...")).toBe(EmotionId.SLEEPY);
    expect(parseEmotionFromTag("[CURIOUS] What is that?")).toBe(EmotionId.CURIOUS);
    expect(parseEmotionFromTag("Plain text without tag", EmotionId.FOCUSED)).toBe(EmotionId.FOCUSED);
  });

  it("calls Gemini API and handles responses, extracting emotion and executing tool calls", async () => {
    const geminiMockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "start_robot_pomodoro_timer",
                  args: { minutes: 15, label: "Sprint" },
                },
              },
              {
                text: "[FOCUSED] Started a 15-minute sprint timer on your screen!",
              },
            ],
          },
        },
      ],
    };

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => geminiMockResponse,
    }) as any;

    try {
      const geminiBrain = new AgenticVoiceBrain({
        persona: "Atlas",
        geminiApiKey: "AQ.Ab8RN6LhcxCquEosrka8RsfjhHaAdGCqAaOXO-BCZRh2E9Wbkw",
      });

      const turn = await geminiBrain.processUserUtterance("Start a 15 min sprint");

      expect(turn.spokenText).toBe("[FOCUSED] Started a 15-minute sprint timer on your screen!");
      expect(turn.emotionId).toBe(EmotionId.FOCUSED);
      expect(turn.toolCallsExecuted).toHaveLength(1);
      expect(turn.toolCallsExecuted[0]?.toolName).toBe("start_robot_pomodoro_timer");
      expect(turn.framesToSend).toHaveLength(1);

      const frame = decodeFrame(turn.framesToSend[0]!);
      expect(frame.header.frameType).toBe(FrameType.HARNESS_RPC_REQ);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("AgenticVoiceBrain - Cross-Widget Awareness, Habits, Mobile & Automations", () => {
  it("routes daily tasks into Habit Tracker, ticks completion with streak +1, and syncs live context", async () => {
    const brain = new AgenticVoiceBrain({ persona: "Nova" });

    // 1. Add a new daily task -> routed to Habit Tracker
    const addTurn = await brain.processUserUtterance("Add Meditation 10m to my daily todo list");
    expect(addTurn.toolCallsExecuted[0]?.toolName).toBe("manage_robot_habit");
    expect(brain.getEcosystemState().habits.some((h) => h.title.includes("Meditation"))).toBe(true);

    const addFrame = decodeFrame(addTurn.framesToSend[0]!);
    const addRpc = decodeControlPayload(HarnessRpcReqSchema, addFrame.payload);
    expect(addRpc.method).toBe("habit_manage");
    expect(addRpc.params["action"]).toBe("add");

    // 2. Mark completed -> fuzzy matches existing habit and ticks checkmark + increments streak
    const doneTurn = await brain.processUserUtterance("Mark meditation completed");
    expect(doneTurn.toolCallsExecuted[0]?.toolName).toBe("manage_robot_habit");
    const medHabit = brain.getEcosystemState().habits.find((h) => h.title.includes("Meditation"));
    expect(medHabit?.completedToday).toBe(true);
    expect(medHabit?.streakDays).toBe(1);

    const doneFrame = decodeFrame(doneTurn.framesToSend[0]!);
    const doneRpc = decodeControlPayload(HarnessRpcReqSchema, doneFrame.payload);
    expect(doneRpc.method).toBe("habit_manage");
    expect(doneRpc.params["action"]).toBe("complete");

    // 3. System prompt reflects live checked state and all robot capabilities
    const ctxPrompt = brain.buildContextualSystemPrompt();
    expect(ctxPrompt).toContain("[X] Meditation");
    expect(ctxPrompt).toContain("habits");
    expect(ctxPrompt).toContain("pomodoro");
    expect(ctxPrompt).toContain("trigger_mobile_partner_action");
  });

  it("navigates robot widgets cleanly (clock analog, habits, monitor)", async () => {
    const brain = new AgenticVoiceBrain({ persona: "Nova" });

    const clockTurn = await brain.processUserUtterance("Show my analog clock");
    expect(clockTurn.toolCallsExecuted[0]?.toolName).toBe("navigate_robot_widget");
    const navRpc = decodeControlPayload(HarnessRpcReqSchema, decodeFrame(clockTurn.framesToSend[0]!).payload);
    expect(navRpc.method).toBe("navigate_widget");
    expect(navRpc.params["pageId"]).toBe("clock");
    expect(navRpc.params["clockMode"]).toBe("analog");
    expect(brain.getEcosystemState().activeWidget).toBe("clock");
  });

  it("dispatches Android mobile actions and cross-device automations cleanly", async () => {
    const brain = new AgenticVoiceBrain({ persona: "Atlas" });

    const torchTurn = await brain.processUserUtterance("Turn on phone flashlight");
    expect(torchTurn.toolCallsExecuted[0]?.toolName).toBe("trigger_mobile_partner_action");
    const torchRpc = decodeControlPayload(HarnessRpcReqSchema, decodeFrame(torchTurn.framesToSend[0]!).payload);
    expect(torchRpc.method).toBe("mobile_toggle_flashlight");
    expect(torchRpc.params["enabled"]).toBe(true);

    const autoTurn = await brain.processUserUtterance("Run morning briefing automation");
    expect(autoTurn.toolCallsExecuted[0]?.toolName).toBe("run_cross_device_automation");
    const autoRpc = decodeControlPayload(HarnessRpcReqSchema, decodeFrame(autoTurn.framesToSend[0]!).payload);
    expect(autoRpc.method).toBe("run_automation");
    expect(autoRpc.params["scriptName"]).toBe("Morning VIP Briefing");
  });
});
