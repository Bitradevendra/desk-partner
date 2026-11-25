import React, { useState, useEffect } from "react";
import {
  automationStudio,
  type AutomationDryRunResult,
} from "../../services/automation-studio.js";
import { RobotTftScreen } from "../simulator/RobotTftScreen.js";
import { webAudioSynth } from "../../services/web-audio-synth.js";
import { usePetBotStore } from "../../store/usePetBotStore.js";
import {
  compileAutomationToWidgetPackage,
  type HostedAutomationPackage,
  type WidgetPackage,
} from "@petbot/widget-schema";
import {
  Play,
  Upload,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Lock,
  ChevronDown,
  ChevronUp,
  ListChecks,
  SlidersHorizontal,
  Monitor,
  Wand2,
} from "lucide-react";

type AutomationDrawer = "STEPS" | "TWEAKS" | "PREVIEW" | null;
type PresetFilter = "ALL" | "MORNING" | "MESSAGES" | "FOCUS";

const PRESET_FILTERS: {
  id: string;
  filter: PresetFilter;
  shortTitle: string;
  prompt: string;
}[] = [
  {
    id: "tpl_morning_briefing",
    filter: "MORNING",
    shortTitle: "Morning Briefing",
    prompt: "Morning VIP briefing every weekday at 8:30 AM and display summary on robot",
  },
  {
    id: "tpl_whatsapp_reply",
    filter: "MESSAGES",
    shortTitle: "WhatsApp Reply",
    prompt: "Silent WhatsApp reply when urgent message arrives with tap approval",
  },
  {
    id: "tpl_night_guard",
    filter: "MORNING",
    shortTitle: "Night Guard",
    prompt: "Low power night battery guard below 20 percent alert on robot",
  },
  {
    id: "tpl_pomodoro_focus",
    filter: "FOCUS",
    shortTitle: "Break Timer",
    prompt: "Every 2 hours start a calm focus stretch break reminder on robot",
  },
];

const QUICK_TWEAKS = [
  "Make card curious",
  "Require tap approval",
  "Save to MicroSD",
  "Every hour",
];

export const ZeroCodeAutomationBuilder: React.FC = () => {
  const { connectionState, setProvisionModalOpen } = usePetBotStore();
  const [promptInput, setPromptInput] = useState("");
  const [tweakInput, setTweakInput] = useState("");
  const [isCompiling, setIsCompiling] = useState(false);
  const [isRunningDryRun, setIsRunningDryRun] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);

  const [activePresetId, setActivePresetId] = useState<string>("tpl_morning_briefing");
  const [currentPackage, setCurrentPackage] = useState<HostedAutomationPackage | null>(null);
  const [compiledWidget, setCompiledWidget] = useState<WidgetPackage | null>(null);
  const [dryRunResult, setDryRunResult] = useState<AutomationDryRunResult | null>(null);
  const [deployMessage, setDeployMessage] = useState<{ text: string; isError?: boolean } | null>(
    null
  );
  const [presetFilter, setPresetFilter] = useState<PresetFilter>("ALL");
  const [openDrawer, setOpenDrawer] = useState<AutomationDrawer>("STEPS");
  const [animatedStepIndex, setAnimatedStepIndex] = useState<number>(-1);

  const isHardwareConnected = connectionState === "AGENTIC_ONLINE";
  const isPreviewMode = connectionState === "OFFLINE_SIMULATOR";
  const canDeploy = isHardwareConnected || isPreviewMode;

  useEffect(() => {
    let active = true;
    if (!currentPackage) {
      const initialPreset = PRESET_FILTERS[0]!;
      void automationStudio.compilePromptToAutomation(initialPreset.prompt).then((pkg) => {
        if (!active) return;
        setCurrentPackage(pkg);
        setCompiledWidget(compileAutomationToWidgetPackage(pkg));
      });
    }
    return () => {
      active = false;
    };
  }, [currentPackage]);

  const handleLoadTemplate = async (preset: (typeof PRESET_FILTERS)[number]) => {
    webAudioSynth.play("TICK");
    setActivePresetId(preset.id);
    setIsCompiling(true);
    try {
      const pkg = await automationStudio.compilePromptToAutomation(preset.prompt);
      setCurrentPackage(pkg);
      setCompiledWidget(compileAutomationToWidgetPackage(pkg));
      setDryRunResult(null);
      setDeployMessage(null);
    } finally {
      setIsCompiling(false);
    }
  };

  const handleCompilePrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptInput.trim() || isCompiling) return;
    setIsCompiling(true);
    setActivePresetId("");
    webAudioSynth.play("CHIRP");
    try {
      const pkg = await automationStudio.compilePromptToAutomation(promptInput.trim());
      setCurrentPackage(pkg);
      setCompiledWidget(compileAutomationToWidgetPackage(pkg));
      setDryRunResult(null);
      setDeployMessage(null);
      setPromptInput("");
      webAudioSynth.play("SUCCESS");
    } finally {
      setIsCompiling(false);
    }
  };

  const handleApplyTweak = async (instruction: string) => {
    if (!currentPackage || !instruction.trim() || isCompiling) return;
    setIsCompiling(true);
    webAudioSynth.play("TICK");
    try {
      const tweaked = await automationStudio.refineAutomationConversationally(
        currentPackage,
        instruction
      );
      setCurrentPackage(tweaked);
      setCompiledWidget(compileAutomationToWidgetPackage(tweaked));
      setTweakInput("");
      setDryRunResult(null);
      webAudioSynth.play("CHIRP");
    } finally {
      setIsCompiling(false);
    }
  };

  const handleRunDryRun = async () => {
    if (!currentPackage || isRunningDryRun) return;
    setIsRunningDryRun(true);
    setOpenDrawer("STEPS");
    setDeployMessage(null);
    setAnimatedStepIndex(0);
    webAudioSynth.play("CHIRP");

    const res = await automationStudio.runDryRunDemo(currentPackage);
    setDryRunResult(res);

    for (let i = 0; i < currentPackage.steps.length; i++) {
      setAnimatedStepIndex(i);
      webAudioSynth.play("TICK");
      await new Promise((r) => setTimeout(r, 260));
    }

    setAnimatedStepIndex(-1);
    setIsRunningDryRun(false);
    webAudioSynth.play("SUCCESS");
  };

  const handleHostOnRobot = async () => {
    if (!currentPackage || isDeploying) return;
    if (!canDeploy) {
      webAudioSynth.play("WARNING");
      setDeployMessage({
        text: "Not connected to Lobo — pair over Wi-Fi or Bluetooth first.",
        isError: true,
      });
      setProvisionModalOpen(true);
      return;
    }

    setIsDeploying(true);
    webAudioSynth.play("TICK");
    try {
      const result = await automationStudio.deployAndHostOnRobot(currentPackage);
      setDeployMessage({ text: result.message, isError: !result.success });
      webAudioSynth.play(result.success ? "SUCCESS" : "WARNING");
    } finally {
      setIsDeploying(false);
    }
  };

  const triggerLabel = currentPackage?.triggers[0]?.type.replace(/_/g, " ") ?? "MANUAL";
  const runsOffline =
    currentPackage?.triggers.some(
      (t) => t.type === "ROBOT_TOUCH_GESTURE" || (t.type === "SCHEDULE_CRON" && t.runOfflineOnRtc)
    ) ?? false;

  const filteredPresets = PRESET_FILTERS.filter(
    (p) => presetFilter === "ALL" || p.filter === presetFilter
  );

  return (
    <div className="flex flex-col space-y-3">
      {/* Compact Prompt + Filter Preset Bar */}
      <div className="bg-white border border-zinc-200 rounded-2xl p-3.5 space-y-2.5">
        <form onSubmit={handleCompilePrompt} className="flex items-center space-x-2">
          <Wand2 className="w-4 h-4 text-zinc-500 shrink-0" />
          <input
            type="text"
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            placeholder="Describe an automation (e.g. Read Slack at 9 AM)..."
            className="flex-1 bg-zinc-50 border border-zinc-300 focus:border-zinc-950 rounded-xl px-3 py-2 text-xs text-zinc-950 outline-none"
          />
          <button
            type="submit"
            disabled={!promptInput.trim() || isCompiling}
            className="px-3.5 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium disabled:opacity-40"
          >
            {isCompiling ? "..." : "Create"}
          </button>
        </form>

        {/* Filter & Preset Chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(["ALL", "MORNING", "MESSAGES", "FOCUS"] as PresetFilter[]).map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setPresetFilter(cat)}
              className={`px-2 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wide ${
                presetFilter === cat
                  ? "bg-zinc-950 text-white"
                  : "bg-zinc-100 text-zinc-500 hover:text-zinc-900"
              }`}
            >
              {cat}
            </button>
          ))}
          <span className="text-zinc-300 text-xs">|</span>
          {filteredPresets.map((preset) => {
            const active = activePresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => void handleLoadTemplate(preset)}
                className={`px-2.5 py-1 rounded-lg border text-xs font-medium ${
                  active
                    ? "bg-zinc-950 border-zinc-950 text-white"
                    : "bg-zinc-50 border-zinc-200 text-zinc-800 hover:bg-zinc-100"
                }`}
              >
                {preset.shortTitle}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active Workflow Summary + Primary Actions */}
      {currentPackage && (
        <div className="bg-white border border-zinc-200 rounded-2xl p-3.5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-zinc-950 truncate">
                {currentPackage.name}
              </div>
              <div className="text-[11px] font-mono text-zinc-500">
                {triggerLabel} · {currentPackage.steps.length} steps ·{" "}
                {runsOffline ? "Offline Ready" : "Needs Companion"}
              </div>
            </div>

            <div className="flex items-center space-x-1.5">
              <button
                type="button"
                onClick={() => void handleRunDryRun()}
                disabled={isRunningDryRun}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-900 text-xs font-medium disabled:opacity-50"
              >
                {isRunningDryRun ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                <span>Test</span>
              </button>

              <button
                type="button"
                onClick={() => void handleHostOnRobot()}
                disabled={isDeploying}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{isDeploying ? "Saving..." : "Save to Lobo"}</span>
              </button>
            </div>
          </div>

          {deployMessage && (
            <div
              className={`px-3 py-2 rounded-xl border text-xs flex items-center space-x-2 ${
                deployMessage.isError
                  ? "bg-amber-50 border-amber-200 text-amber-900"
                  : "bg-zinc-50 border-zinc-200 text-zinc-800"
              }`}
            >
              {deployMessage.isError ? (
                <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              )}
              <span>{deployMessage.text}</span>
            </div>
          )}

          {/* Drawer Toggles */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-zinc-100">
            <button
              type="button"
              onClick={() => setOpenDrawer(openDrawer === "STEPS" ? null : "STEPS")}
              className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg border text-xs font-medium ${
                openDrawer === "STEPS"
                  ? "bg-zinc-950 border-zinc-950 text-white"
                  : "bg-zinc-50 border-zinc-200 text-zinc-700"
              }`}
            >
              <ListChecks className="w-3.5 h-3.5" />
              <span>Steps ({currentPackage.steps.length})</span>
              {openDrawer === "STEPS" ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setOpenDrawer(openDrawer === "TWEAKS" ? null : "TWEAKS")}
              className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg border text-xs font-medium ${
                openDrawer === "TWEAKS"
                  ? "bg-zinc-950 border-zinc-950 text-white"
                  : "bg-zinc-50 border-zinc-200 text-zinc-700"
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Tweaks</span>
            </button>

            <button
              type="button"
              onClick={() => setOpenDrawer(openDrawer === "PREVIEW" ? null : "PREVIEW")}
              className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg border text-xs font-medium ${
                openDrawer === "PREVIEW"
                  ? "bg-zinc-950 border-zinc-950 text-white"
                  : "bg-zinc-50 border-zinc-200 text-zinc-700"
              }`}
            >
              <Monitor className="w-3.5 h-3.5" />
              <span>Screen Preview</span>
            </button>
          </div>

          {/* Drawer Content */}
          {openDrawer === "STEPS" && (
            <div className="divide-y divide-zinc-100 border border-zinc-200 rounded-xl overflow-hidden">
              {currentPackage.steps.map((step, idx) => {
                const isActive = animatedStepIndex === idx;
                const dryPreview = dryRunResult?.stepPreviews.find((p) => p.stepId === step.stepId);
                return (
                  <div
                    key={step.stepId}
                    className={`px-3 py-2 text-xs ${isActive ? "bg-zinc-100" : "bg-white"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-zinc-950">
                        {idx + 1}. {step.title}
                      </span>
                      <span className="text-[10px] font-mono text-zinc-500 flex items-center space-x-1">
                        {step.requiresTouch2Fa && <Lock className="w-3 h-3 text-amber-600" />}
                        <span>{step.payload.type.replace("_", " ")}</span>
                      </span>
                    </div>
                    {dryPreview ? (
                      <div className="mt-1 text-[11px] font-mono text-zinc-600">
                        {dryPreview.simulatedOutput}
                      </div>
                    ) : (
                      <div className="text-[11px] text-zinc-500 mt-0.5">
                        {step.plainEnglishDescription}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {openDrawer === "TWEAKS" && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {QUICK_TWEAKS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => void handleApplyTweak(chip)}
                    className="px-2.5 py-1 rounded-lg bg-zinc-50 hover:bg-zinc-100 border border-zinc-200 text-xs text-zinc-800"
                  >
                    {chip}
                  </button>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleApplyTweak(tweakInput);
                }}
                className="flex items-center space-x-2"
              >
                <input
                  type="text"
                  value={tweakInput}
                  onChange={(e) => setTweakInput(e.target.value)}
                  placeholder="Custom change (e.g. Run on double-tap)..."
                  className="flex-1 bg-zinc-50 border border-zinc-300 focus:border-zinc-950 rounded-lg px-2.5 py-1.5 text-xs text-zinc-950 outline-none"
                />
                <button
                  type="submit"
                  disabled={!tweakInput.trim() || isCompiling}
                  className="px-3 py-1.5 rounded-lg bg-zinc-950 text-white text-xs font-medium disabled:opacity-40"
                >
                  Apply
                </button>
              </form>
            </div>
          )}

          {openDrawer === "PREVIEW" && (
            <div className="flex flex-col sm:flex-row items-center gap-3 p-3 rounded-xl bg-zinc-50 border border-zinc-200">
              {compiledWidget ? (
                <div className="rounded-lg overflow-hidden border border-zinc-300 bg-white">
                  <RobotTftScreen
                    widget={compiledWidget}
                    stateSlots={{}}
                    scale={1.1}
                    onScreenTap={() => void handleRunDryRun()}
                  />
                </div>
              ) : null}
              <div className="text-xs space-y-1">
                <div className="font-semibold text-zinc-950">
                  {currentPackage.robotCardPreview.title}
                </div>
                <div className="text-zinc-500">
                  Badge:{" "}
                  <span className="font-mono">{currentPackage.robotCardPreview.headerBadge}</span>
                </div>
                <div className="text-[11px] text-zinc-500">Tap screen above to test steps</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ZeroCodeAutomationBuilder;
