import { describe, it, expect } from "vitest";
import {
  HostedAutomationPackageSchema,
  generatePlainEnglishPipeline,
  compileAutomationToWidgetPackage,
  type HostedAutomationPackage,
} from "../src/automation-dsl.js";
import { compileWidgetToBytecode } from "../src/compiler.js";

describe("Zero-Code Automation DSL & Compiler", () => {
  const sampleAutomation: HostedAutomationPackage = {
    id: "auto-morning-vip-briefing",
    name: "VIP Morning Briefing",
    description: "Summarizes VIP Slack messages and displays meeting agenda on robot display",
    icon: "Sunrise",
    version: "1.0.0",
    createdAt: 1700000000000,
    hostingTarget: "HYBRID_MESH",
    plainEnglishSummary: "At 8:30 AM on weekdays, reads unread VIP messages, summarizes key action items, and alerts on robot display with happy chirp.",
    triggers: [
      {
        type: "SCHEDULE_CRON",
        cronExpression: "30 8 * * 1-5",
        humanReadableSchedule: "Weekdays at 8:30 AM",
        runOfflineOnRtc: true,
        timezone: "America/New_York",
      },
      {
        type: "ROBOT_TOUCH_GESTURE",
        gesture: "SINGLE_TAP",
        widgetId: "widget-auto-morning-briefing",
        label: "Tap Robot Screen",
      },
    ],
    steps: [
      {
        stepId: "step_1",
        title: "Fetch VIP Slack Messages",
        plainEnglishDescription: "Reads latest 5 unread messages from VIP stakeholders",
        payload: {
          type: "DESKTOP_TOOL",
          toolName: "desktop_read_file",
          parameters: { path: "D:/workspace/vip_notes.txt" },
          outputVariableKey: "vipMessages",
        },
        requiresTouch2Fa: false,
        failPolicy: "CONTINUE_WITH_DEFAULT",
      },
      {
        stepId: "step_2",
        title: "Summarize Action Items",
        plainEnglishDescription: "Distills messages into 3 actionable bullet points",
        payload: {
          type: "AI_TRANSFORM",
          transformType: "SUMMARIZE",
          instruction: "Summarize top 3 priority items in under 20 words each",
          inputVariableKey: "vipMessages",
          outputVariableKey: "briefingSummary",
        },
        requiresTouch2Fa: false,
        failPolicy: "ABORT",
      },
      {
        stepId: "step_3",
        title: "Display Alert Card on Robot",
        plainEnglishDescription: "Shows morning summary on 1.8\" TFT and plays cheerful chirp",
        payload: {
          type: "ROBOT_ACTION",
          actionType: "SHOW_ALERT_CARD",
          parameters: {
            alertTitle: "VIP BRIEFING",
            bodyText: "$briefingSummary",
            soundName: "CHIRP",
            emotion: "HAPPY",
          },
        },
        requiresTouch2Fa: false,
        failPolicy: "CONTINUE_WITH_DEFAULT",
      },
    ],
    robotCardPreview: {
      headerBadge: "MORNING",
      title: "VIP BRIEFING",
      subtitle: "8:30 AM Active",
      accentColorRgb565: 0x07e0, // Emerald
      emotion: "HAPPY",
      iconId: 10,
    },
    enabled: true,
  };

  it("validates valid HostedAutomationPackage schema with zero errors", () => {
    const parsed = HostedAutomationPackageSchema.parse(sampleAutomation);
    expect(parsed.id).toBe("auto-morning-vip-briefing");
    expect(parsed.triggers.length).toBe(2);
    expect(parsed.steps.length).toBe(3);
    expect(parsed.hostingTarget).toBe("HYBRID_MESH");
  });

  it("generates a clean plain-English execution pipeline description without code or YAML", () => {
    const summary = generatePlainEnglishPipeline(sampleAutomation);
    expect(summary).toContain("TRIGGER:");
    expect(summary).toContain("Weekdays at 8:30 AM");
    expect(summary).toContain("When you single tap on the robot");
    expect(summary).toContain("1. Fetch VIP Slack Messages: Reads latest 5 unread messages from VIP stakeholders");
    expect(summary).toContain("2. Summarize Action Items: Distills messages into 3 actionable bullet points");
    expect(summary).toContain("3. Display Alert Card on Robot: Shows morning summary on 1.8\" TFT and plays cheerful chirp");
  });

  it("compiles automation into valid 160x128 WidgetPackage and produces executable bytecode", () => {
    const widgetPkg = compileAutomationToWidgetPackage(sampleAutomation);
    expect(widgetPkg.manifest.id).toBe("widget-auto-auto-morning-vip-briefing");
    expect(widgetPkg.manifest.name).toBe("VIP Morning Briefing");
    expect(widgetPkg.state.status.initialValue).toBe("Active");
    expect(widgetPkg.state.headline.initialValue).toBe("VIP BRIEFING");
    expect(widgetPkg.ui.type).toBe("Container");
    expect(widgetPkg.triggers.length).toBe(1);
    expect(widgetPkg.triggers[0]?.event).toBe("ON_TOUCH_TAP");

    // Test bytecode compilation
    const bytecode = compileWidgetToBytecode(widgetPkg);
    expect(bytecode.byteLength).toBeGreaterThan(64);
    // Magic 'PBWG'
    const view = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
    expect(view.getUint32(0, true)).toBe(0x47574250);
  });
});
