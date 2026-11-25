import React, { useState } from "react";
import { usePetBotStore } from "../../store/usePetBotStore.js";
import { VirtualPetDeviceFrame } from "../simulator/VirtualPetDeviceFrame.js";
import { webAudioSynth } from "../../services/web-audio-synth.js";
import {
  Send,
  Undo2,
  Redo2,
  Upload,
  Check,
  AlertCircle,
  Loader2,
  SlidersHorizontal,
  History,
  LayoutGrid,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { ZeroCodeAutomationBuilder } from "./ZeroCodeAutomationBuilder.js";

type StudioDrawer = "TEMPLATES" | "TWEAKS" | "HISTORY" | "SLOTS" | null;
type TemplateFilter = "ALL" | "PRODUCTIVITY" | "WELLNESS" | "SYSTEM";

const STUDIO_TEMPLATES = [
  {
    id: "focus",
    name: "Focus Timer",
    category: "PRODUCTIVITY" as const,
    prompt: "Create a crisp monochrome 25 minute focus timer with start and reset buttons",
  },
  {
    id: "hydration",
    name: "Water Tracker",
    category: "WELLNESS" as const,
    prompt: "Create a clean black and white water tracker with quick +1 glass button",
  },
  {
    id: "weather",
    name: "Weather Desk",
    category: "SYSTEM" as const,
    prompt: "Create a clean minimalist weather widget with temp and wind speed",
  },
  {
    id: "tasks",
    name: "Daily Tasks",
    category: "PRODUCTIVITY" as const,
    prompt: "Build a crisp task counter card with Done button",
  },
];

const QUICK_REFINEMENTS = [
  "Make text larger",
  "Clean black & white",
  "Show battery",
  "Compact padding",
];

export const MagicStudioView: React.FC = () => {
  const {
    connectionState,
    setProvisionModalOpen,
    studioState,
    sendStudioPrompt,
    undoDraft,
    redoDraft,
    deployWidget,
    updateSimulatorSlot,
  } = usePetBotStore();

  const [studioTab, setStudioTab] = useState<"AUTOMATIONS" | "WIDGETS">("AUTOMATIONS");
  const [inputText, setInputText] = useState("");
  const [openDrawer, setOpenDrawer] = useState<StudioDrawer>("TEMPLATES");
  const [templateFilter, setTemplateFilter] = useState<TemplateFilter>("ALL");
  const [showPreviewCard, setShowPreviewCard] = useState(true);
  const [deployFeedback, setDeployFeedback] = useState<{ text: string; isError?: boolean } | null>(
    null
  );

  const isHardwareConnected = connectionState === "AGENTIC_ONLINE";
  const isPreviewMode = connectionState === "OFFLINE_SIMULATOR";
  const canDeploy = isHardwareConnected || isPreviewMode;

  const { draftWidget, chatHistory, isGenerating, undoStack, redoStack, simulatorSlots } =
    studioState;

  const byteEstimate = Math.max(240, Math.round(JSON.stringify(draftWidget).length * 0.65));

  const showStatus = (text: string, isError = false) => {
    setDeployFeedback({ text, isError });
    setTimeout(() => setDeployFeedback(null), 2600);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isGenerating) return;
    const prompt = inputText.trim();
    setInputText("");
    webAudioSynth.play("CHIRP");
    await sendStudioPrompt(prompt);
  };

  const handleDeploy = async () => {
    webAudioSynth.play("TICK");
    const delivered = await deployWidget(draftWidget);
    if (delivered) {
      webAudioSynth.play("SUCCESS");
      showStatus(`Saved "${draftWidget.manifest.name}" to Lobo`);
    } else {
      webAudioSynth.play("WARNING");
      showStatus("Saved on phone — connect Lobo to push to screen", true);
    }
  };

  const filteredTemplates = STUDIO_TEMPLATES.filter(
    (t) => templateFilter === "ALL" || t.category === templateFilter
  );

  const slotEntries = Object.entries(simulatorSlots);

  return (
    <div className="flex flex-col space-y-3">
      {deployFeedback && (
        <div className="fixed bottom-20 md:bottom-6 right-4 sm:right-6 z-50 flex items-center space-x-2 px-3.5 py-2 rounded-xl bg-zinc-950 text-white text-xs font-medium shadow-lg">
          {deployFeedback.isError ? (
            <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          ) : (
            <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          )}
          <span>{deployFeedback.text}</span>
        </div>
      )}

      {/* Compact Section Switcher + Honest Connection Status */}
      <div className="flex items-center justify-between gap-2 bg-white border border-zinc-200 rounded-2xl p-1.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setStudioTab("AUTOMATIONS")}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              studioTab === "AUTOMATIONS"
                ? "bg-zinc-950 text-white"
                : "text-zinc-600 hover:text-zinc-950"
            }`}
          >
            Automations
          </button>
          <button
            type="button"
            onClick={() => setStudioTab("WIDGETS")}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              studioTab === "WIDGETS"
                ? "bg-zinc-950 text-white"
                : "text-zinc-600 hover:text-zinc-950"
            }`}
          >
            Screen Builder
          </button>
        </div>

        <button
          type="button"
          onClick={() => setProvisionModalOpen(true)}
          className="px-2.5 py-1 rounded-lg bg-zinc-50 hover:bg-zinc-100 border border-zinc-200 text-[11px] font-medium text-zinc-700"
        >
          {isHardwareConnected
            ? "Connected"
            : isPreviewMode
              ? "Preview"
              : "Not Connected · Pair"}
        </button>
      </div>

      {studioTab === "AUTOMATIONS" ? (
        <ZeroCodeAutomationBuilder />
      ) : (
        <div className="flex flex-col space-y-3">
          {/* Compact Top Action & Preview Card */}
          <div className="bg-white border border-zinc-200 rounded-2xl p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-zinc-950 truncate">
                  {draftWidget.manifest.name}
                </div>
                <div className="text-[11px] font-mono text-zinc-500">
                  v{draftWidget.manifest.version} · {byteEstimate} B · 160x128
                </div>
              </div>

              <div className="flex items-center space-x-1.5">
                <button
                  type="button"
                  onClick={() => setShowPreviewCard(!showPreviewCard)}
                  className="px-2.5 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-[11px] font-medium text-zinc-800 flex items-center space-x-1"
                >
                  <span>Preview</span>
                  {showPreviewCard ? (
                    <ChevronUp className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={undoDraft}
                  disabled={undoStack.length === 0}
                  className="p-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 disabled:opacity-40"
                  title="Undo"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={redoDraft}
                  disabled={redoStack.length === 0}
                  className="p-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 disabled:opacity-40"
                  title="Redo"
                >
                  <Redo2 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeploy()}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>{canDeploy ? "Save to Lobo" : "Save"}</span>
                </button>
              </div>
            </div>

            {showPreviewCard && (
              <div className="flex justify-center pt-1">
                <VirtualPetDeviceFrame
                  widget={draftWidget}
                  stateSlots={simulatorSlots}
                  initialScale={1.08}
                />
              </div>
            )}

            {/* Single-line Widget Prompt Bar */}
            <form onSubmit={handleSubmit} className="flex items-center space-x-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Describe a screen or change (e.g. Pomodoro with battery)..."
                className="flex-1 bg-zinc-50 border border-zinc-300 focus:border-zinc-950 rounded-xl px-3 py-2 text-xs text-zinc-950 outline-none"
              />
              <button
                type="submit"
                disabled={!inputText.trim() || isGenerating}
                className="px-3.5 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium flex items-center space-x-1.5 disabled:opacity-40"
              >
                {isGenerating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                <span>Build</span>
              </button>
            </form>
          </div>

          {/* Toggle Pills for Compact Access */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: "TEMPLATES", label: "Templates", icon: LayoutGrid },
                { id: "TWEAKS", label: "Quick Tweaks", icon: SlidersHorizontal },
                { id: "HISTORY", label: `History (${chatHistory.length})`, icon: History },
                ...(slotEntries.length > 0
                  ? [{ id: "SLOTS", label: `Slots (${slotEntries.length})`, icon: SlidersHorizontal }]
                  : []),
              ] as { id: Exclude<StudioDrawer, null>; label: string; icon: React.ComponentType<{ className?: string }> }[]
            ).map((btn) => {
              const Icon = btn.icon;
              const active = openDrawer === btn.id;
              return (
                <button
                  key={btn.id}
                  type="button"
                  onClick={() => setOpenDrawer(active ? null : btn.id)}
                  className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium ${
                    active
                      ? "bg-zinc-950 border-zinc-950 text-white"
                      : "bg-white border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{btn.label}</span>
                </button>
              );
            })}
          </div>

          {/* Expandable Drawer Content (only one open at a time) */}
          {openDrawer === "TEMPLATES" && (
            <div className="bg-white border border-zinc-200 rounded-2xl p-3 space-y-2.5">
              <div className="flex flex-wrap items-center gap-1">
                {(["ALL", "PRODUCTIVITY", "WELLNESS", "SYSTEM"] as TemplateFilter[]).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setTemplateFilter(cat)}
                    className={`px-2 py-1 rounded-md text-[11px] font-medium ${
                      templateFilter === cat
                        ? "bg-zinc-950 text-white"
                        : "bg-zinc-100 text-zinc-600"
                    }`}
                  >
                    {cat === "ALL" ? "All" : cat.charAt(0) + cat.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {filteredTemplates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => void sendStudioPrompt(tpl.prompt)}
                    className="px-3 py-2 rounded-xl bg-zinc-50 hover:bg-zinc-100 border border-zinc-200 text-left"
                  >
                    <div className="text-xs font-semibold text-zinc-950 truncate">{tpl.name}</div>
                    <div className="text-[10px] text-zinc-500">Tap to load</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {openDrawer === "TWEAKS" && (
            <div className="bg-white border border-zinc-200 rounded-2xl p-3 flex flex-wrap gap-1.5">
              {QUICK_REFINEMENTS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => void sendStudioPrompt(chip)}
                  className="px-2.5 py-1.5 rounded-lg bg-zinc-50 hover:bg-zinc-100 border border-zinc-200 text-xs text-zinc-800"
                >
                  {chip}
                </button>
              ))}
            </div>
          )}

          {openDrawer === "HISTORY" && (
            <div className="bg-white border border-zinc-200 rounded-2xl p-3 space-y-2 max-h-56 overflow-y-auto">
              {chatHistory.slice(-6).map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] px-3 py-2 rounded-xl text-xs ${
                      msg.sender === "user"
                        ? "bg-zinc-950 text-white"
                        : "bg-zinc-100 text-zinc-800"
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
            </div>
          )}

          {openDrawer === "SLOTS" && slotEntries.length > 0 && (
            <div className="bg-white border border-zinc-200 rounded-2xl p-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
              {slotEntries.map(([key, val]) => (
                <div key={key} className="space-y-1">
                  <label className="text-[10px] font-mono text-zinc-500 block truncate">
                    {key}
                  </label>
                  <input
                    type="text"
                    value={String(val)}
                    onChange={(e) => updateSimulatorSlot(key, e.target.value)}
                    className="w-full px-2 py-1 rounded bg-zinc-50 border border-zinc-300 text-xs font-mono text-zinc-900"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MagicStudioView;
