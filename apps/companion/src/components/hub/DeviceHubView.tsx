import React, { useState } from "react";
import {
  Heart,
  Wifi,
  Battery,
  BatteryCharging,
  Check,
  ArrowLeft,
  ArrowRight,
  Play,
  Pencil,
  Trash2,
  Plus,
  Send,
  Radio,
  Cpu,
  Download,
  FileText,
  X,
  Smile,
} from "lucide-react";
import { usePetBotStore } from "../../store/usePetBotStore.js";
import { VirtualPetDeviceFrame } from "../simulator/VirtualPetDeviceFrame.js";
import { RobotTftScreen } from "../simulator/RobotTftScreen.js";
import { webAudioSynth } from "../../services/web-audio-synth.js";
import { FirmwareUpdateModal } from "./FirmwareUpdateModal.js";
import { HardwareAndMobilePanels } from "./HardwareAndMobilePanels.js";
import { RobotMode } from "@petbot/protocol";
import type { WidgetPackage, EmotionType } from "@petbot/widget-schema";

type HomeSection = "SCREENS" | "HABITS" | "NOTES" | "SETTINGS";

const EXPRESSION_PRESETS: { id: EmotionType; label: string }[] = [
  { id: "IDLE", label: "Idle" },
  { id: "HAPPY", label: "Happy" },
  { id: "CURIOUS", label: "Curious" },
  { id: "SLEEPY", label: "Sleepy" },
  { id: "FOCUSED", label: "Focused" },
  { id: "SPEAKING", label: "Speaking" },
  { id: "LISTENING", label: "Listening" },
  { id: "ALERT", label: "Alert" },
];

export const DeviceHubView: React.FC = () => {
  const {
    installedWidgets,
    activeWidgetId,
    previewEmotion,
    setPreviewEmotion,
    setActiveWidget,
    removeWidget,
    reorderWidgets,
    wakeOrPetRobot,
    connectionState,
    setProvisionModalOpen,
    telemetry,
    studioState,
    setDraftWidget,
    setActiveTab,
    setMode,
    quickNotes,
    setQuickNotes,
    habits,
    toggleHabit,
    addHabit,
    removeHabit,
    syncNotesAndHabits,
  } = usePetBotStore();

  const [section, setSection] = useState<HomeSection>("SCREENS");
  const [showExpressions, setShowExpressions] = useState(false);
  const [feedbackToast, setFeedbackToast] = useState<string | null>(null);
  const [newHabitName, setNewHabitName] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOtaModalOpen, setIsOtaModalOpen] = useState(false);
  const [robotFirmwareVersion, setRobotFirmwareVersion] = useState("v2.0.0");

  const activeWidget =
    installedWidgets.find((w) => w.manifest.id === activeWidgetId) || installedWidgets[0]!;
  const isFaceWidget = activeWidget.manifest.id === "widget-pet-face-00";
  const isHardwareConnected = connectionState === "AGENTIC_ONLINE";
  const isPreviewMode = connectionState === "OFFLINE_SIMULATOR";
  const isAgenticMode =
    (isHardwareConnected || isPreviewMode) && telemetry.mode === RobotMode.AGENTIC_CONNECTED;
  const completedHabitsCount = habits.filter((h) => h.completed).length;

  const showToast = (msg: string) => {
    setFeedbackToast(msg);
    setTimeout(() => setFeedbackToast(null), 2400);
  };

  const handlePetLobo = async () => {
    webAudioSynth.play("PURR");
    const sent = await wakeOrPetRobot();
    showToast(sent ? "Sent pet chime to Lobo" : "Lobo is not connected");
  };

  const handleToggleMode = async () => {
    if (!isHardwareConnected && !isPreviewMode) {
      webAudioSynth.play("TICK");
      setProvisionModalOpen(true);
      showToast("Connect Lobo over Wi-Fi or Bluetooth first");
      return;
    }
    const nextMode = isAgenticMode ? RobotMode.NORMAL_OFFLINE : RobotMode.AGENTIC_CONNECTED;
    webAudioSynth.play("CHIRP");
    const ok = await setMode(nextMode);
    if (!ok) {
      showToast("Device did not respond to mode switch");
      return;
    }
    showToast(
      nextMode === RobotMode.AGENTIC_CONNECTED
        ? "Connected mode enabled"
        : "Offline standalone mode"
    );
  };

  const handleEditInStudio = (widget: WidgetPackage) => {
    setDraftWidget(widget);
    setActiveTab("STUDIO");
    webAudioSynth.play("TICK");
  };

  const handleSyncNotesAndHabits = async () => {
    setIsSyncing(true);
    webAudioSynth.play("TICK");
    try {
      await syncNotesAndHabits();
      showToast(
        isHardwareConnected || isPreviewMode
          ? "Notes & habits synced to Lobo"
          : "Saved on phone (connect Lobo to sync)"
      );
    } finally {
      setIsSyncing(false);
    }
  };

  const handleAddHabitSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newHabitName.trim()) return;
    addHabit(newHabitName.trim());
    setNewHabitName("");
    webAudioSynth.play("TICK");
    showToast("Habit added");
  };

  return (
    <div className="flex flex-col space-y-4">
      {feedbackToast && (
        <div className="fixed bottom-20 md:bottom-6 right-4 sm:right-6 z-50 flex items-center space-x-2 px-3.5 py-2 rounded-xl bg-zinc-950 text-white text-xs font-medium shadow-lg">
          <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" strokeWidth={2.25} />
          <span>{feedbackToast}</span>
        </div>
      )}

      {/* Compact Device Preview Card */}
      <section className="bg-white border border-zinc-200 rounded-2xl p-4 sm:p-5">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-center">
          <div className="md:col-span-5 flex flex-col items-center">
            <VirtualPetDeviceFrame
              widget={activeWidget}
              stateSlots={studioState.simulatorSlots}
              petEmotion={previewEmotion}
              initialScale={1.32}
            />
          </div>

          <div className="md:col-span-7 flex flex-col space-y-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-medium text-zinc-500">Active Display</div>
                <h1 className="text-xl font-semibold text-zinc-950 tracking-tight">
                  {activeWidget.manifest.name}
                </h1>
              </div>

              {/* Operating Mode Switch */}
              <button
                type="button"
                onClick={() => void handleToggleMode()}
                aria-label="Toggle operating mode"
                className="flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-zinc-50 border border-zinc-200 text-xs font-medium text-zinc-900"
              >
                <span>
                  {!isHardwareConnected && !isPreviewMode
                    ? "Offline"
                    : isAgenticMode
                      ? isPreviewMode
                        ? "Preview"
                        : "Connected"
                      : "Standalone"}
                </span>
                <span
                  className={`inline-flex h-4 w-8 items-center rounded-full p-0.5 transition-colors ${
                    isAgenticMode ? "bg-zinc-950" : "bg-zinc-300"
                  }`}
                >
                  <span
                    className={`h-3 w-3 rounded-full bg-white transition-transform ${
                      isAgenticMode ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </span>
              </button>
            </div>

            {/* Compact Quick Actions + Expression Toggle (only for Face) */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handlePetLobo()}
                className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium transition-colors"
              >
                <Heart className="w-3.5 h-3.5" strokeWidth={1.75} />
                <span>Pet Lobo</span>
              </button>

              {isFaceWidget ? (
                <button
                  type="button"
                  onClick={() => setShowExpressions(!showExpressions)}
                  className={`flex items-center space-x-1.5 px-3 py-2 rounded-xl border text-xs font-medium transition-colors ${
                    showExpressions
                      ? "bg-zinc-950 border-zinc-950 text-white"
                      : "bg-white border-zinc-300 text-zinc-800 hover:border-zinc-950"
                  }`}
                >
                  <Smile className="w-3.5 h-3.5" />
                  <span>Expression: {previewEmotion}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void setActiveWidget("widget-pet-face-00")}
                  className="flex items-center space-x-1.5 px-3 py-2 rounded-xl bg-white border border-zinc-300 hover:border-zinc-950 text-xs font-medium text-zinc-800 transition-colors"
                >
                  <Smile className="w-3.5 h-3.5" />
                  <span>Show Face</span>
                </button>
              )}

              <div className="flex items-center gap-2 ml-auto text-[11px] font-mono text-zinc-600">
                <span className="inline-flex items-center space-x-1 px-2 py-1 rounded bg-zinc-100">
                  {telemetry.isCharging ? (
                    <BatteryCharging className="w-3 h-3 text-emerald-700" />
                  ) : (
                    <Battery className="w-3 h-3" />
                  )}
                  <span>
                    {isHardwareConnected || isPreviewMode ? `${telemetry.batteryPct}%` : "--%"}
                  </span>
                </span>
                <span className="inline-flex items-center space-x-1 px-2 py-1 rounded bg-zinc-100">
                  <Wifi className="w-3 h-3" />
                  <span>
                    {isHardwareConnected || isPreviewMode ? `${telemetry.rssi}dBm` : "-- dBm"}
                  </span>
                </span>
                <span className="inline-flex items-center space-x-1 px-2 py-1 rounded bg-zinc-100">
                  <Radio className="w-3 h-3" />
                  <span>
                    {isHardwareConnected || isPreviewMode ? `${telemetry.pingMs}ms` : "--ms"}
                  </span>
                </span>
              </div>
            </div>

            {isFaceWidget && showExpressions && (
              <div className="flex flex-wrap gap-1.5 pt-2 border-t border-zinc-100">
                {EXPRESSION_PRESETS.map((expr) => {
                  const selected = previewEmotion === expr.id;
                  return (
                    <button
                      key={expr.id}
                      type="button"
                      onClick={() => {
                        webAudioSynth.play("TICK");
                        void setPreviewEmotion(expr.id);
                      }}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                        selected
                          ? "bg-zinc-950 text-white border-zinc-950"
                          : "bg-zinc-50 text-zinc-700 border-zinc-200 hover:border-zinc-400"
                      }`}
                    >
                      {expr.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Instant Section Filter Bar (Zero Long Scrolling!) */}
      <div className="flex items-center gap-1 p-1 bg-white border border-zinc-200 rounded-xl overflow-x-auto">
        {(
          [
            { id: "SCREENS", label: `Screens (${installedWidgets.length})` },
            { id: "HABITS", label: `Habits (${completedHabitsCount}/${habits.length})` },
            { id: "NOTES", label: "Notes" },
            { id: "SETTINGS", label: "Settings" },
          ] as const
        ).map((tab) => {
          const active = section === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSection(tab.id)}
              className={`flex-1 min-w-[76px] py-2 px-3 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                active
                  ? "bg-zinc-950 text-white"
                  : "text-zinc-600 hover:text-zinc-950 hover:bg-zinc-50"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Section Content */}
      {section === "SCREENS" && (
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {installedWidgets.map((widget, idx) => {
            const isActive = widget.manifest.id === activeWidgetId;
            return (
              <div
                key={widget.manifest.id}
                className={`relative flex flex-col justify-between p-2.5 rounded-xl bg-white transition-colors ${
                  isActive
                    ? "border-2 border-zinc-950"
                    : "border border-zinc-200 hover:border-zinc-400"
                }`}
              >
                {isActive && (
                  <span className="absolute top-2 right-2 z-10 px-1.5 py-0.5 rounded bg-zinc-950 text-white text-[10px] font-medium">
                    Active
                  </span>
                )}

                <button
                  type="button"
                  onClick={() => void setActiveWidget(widget.manifest.id)}
                  className="flex items-center justify-center p-1.5 rounded-lg bg-zinc-100 border border-zinc-200 aspect-[160/128] overflow-hidden w-full"
                >
                  <RobotTftScreen
                    widget={widget}
                    stateSlots={{
                      ...(widget.state
                        ? Object.fromEntries(
                            Object.entries(widget.state).map(([k, v]) => [k, v.initialValue])
                          )
                        : {}),
                      ...studioState.simulatorSlots,
                    }}
                    scale={0.68}
                  />
                </button>

                <div className="mt-2 text-center">
                  <div className="text-xs font-semibold text-zinc-950 truncate">
                    {widget.manifest.name}
                  </div>
                </div>

                <div className="mt-2 pt-1.5 border-t border-zinc-100 flex items-center justify-between gap-1">
                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={() => idx > 0 && reorderWidgets(idx, idx - 1)}
                      disabled={idx === 0}
                      className="p-1 rounded text-zinc-500 hover:text-zinc-950 disabled:opacity-30"
                      title="Move earlier"
                    >
                      <ArrowLeft className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        idx < installedWidgets.length - 1 && reorderWidgets(idx, idx + 1)
                      }
                      disabled={idx === installedWidgets.length - 1}
                      className="p-1 rounded text-zinc-500 hover:text-zinc-950 disabled:opacity-30"
                      title="Move later"
                    >
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>

                  <div className="flex items-center space-x-0.5">
                    {!isActive && (
                      <button
                        type="button"
                        onClick={() => void setActiveWidget(widget.manifest.id)}
                        className="p-1 rounded bg-zinc-950 text-white"
                        title="Show on Lobo"
                      >
                        <Play className="w-3 h-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleEditInStudio(widget)}
                      className="p-1 rounded text-zinc-600 hover:text-zinc-950"
                      title="Edit in Studio"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    {installedWidgets.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeWidget(widget.manifest.id)}
                        className="p-1 rounded text-zinc-500 hover:text-red-700"
                        title="Remove screen"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {section === "HABITS" && (
        <section className="p-4 sm:p-5 rounded-2xl bg-white border border-zinc-200 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Check className="w-4 h-4 text-zinc-900" />
              <h2 className="text-sm font-semibold text-zinc-950">Daily Habits</h2>
            </div>
            <span className="text-xs font-mono text-zinc-700 bg-zinc-100 px-2.5 py-1 rounded-md">
              {completedHabitsCount} / {habits.length} done
            </span>
          </div>

          <div className="space-y-2">
            {habits.map((habit) => (
              <div
                key={habit.id}
                onClick={() => {
                  toggleHabit(habit.id);
                  webAudioSynth.play(habit.completed ? "TICK" : "SUCCESS");
                }}
                className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                  habit.completed
                    ? "bg-zinc-50 border-zinc-300 text-zinc-500"
                    : "bg-white border-zinc-200 hover:border-zinc-400 text-zinc-950"
                }`}
              >
                <div className="flex items-center space-x-3 min-w-0">
                  <div
                    className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 ${
                      habit.completed
                        ? "bg-zinc-950 border-zinc-950 text-white"
                        : "border-zinc-400 bg-white"
                    }`}
                  >
                    {habit.completed && <Check className="w-3 h-3" strokeWidth={2.5} />}
                  </div>
                  <span
                    className={`text-sm font-medium truncate ${
                      habit.completed ? "line-through text-zinc-500" : "text-zinc-950"
                    }`}
                  >
                    {habit.name}
                  </span>
                </div>

                <div className="flex items-center space-x-2 shrink-0 ml-2">
                  <span className="text-xs font-mono text-zinc-500">{habit.streak}d</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeHabit(habit.id);
                      webAudioSynth.play("TICK");
                    }}
                    className="p-1 rounded text-zinc-400 hover:text-red-700"
                    title="Delete habit"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <form onSubmit={handleAddHabitSubmit} className="flex items-center space-x-2">
            <input
              type="text"
              value={newHabitName}
              onChange={(e) => setNewHabitName(e.target.value)}
              placeholder="Add daily task or habit..."
              className="flex-1 px-3.5 py-2 rounded-xl bg-zinc-50 border border-zinc-300 focus:border-zinc-950 text-sm text-zinc-950 outline-none"
            />
            <button
              type="submit"
              className="flex items-center space-x-1 px-3.5 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-semibold"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add</span>
            </button>
          </form>
        </section>
      )}

      {section === "NOTES" && (
        <section className="p-4 sm:p-5 rounded-2xl bg-white border border-zinc-200 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <FileText className="w-4 h-4 text-zinc-900" />
              <h2 className="text-sm font-semibold text-zinc-950">Quick Notes</h2>
            </div>
            <span className="text-xs font-mono text-zinc-500">{quickNotes.length} chars</span>
          </div>

          <textarea
            value={quickNotes}
            onChange={(e) => setQuickNotes(e.target.value)}
            rows={4}
            className="w-full p-3 rounded-xl bg-zinc-50 border border-zinc-300 focus:border-zinc-950 text-zinc-950 text-sm leading-relaxed outline-none resize-none"
            placeholder="Write a note or reminder for Lobo..."
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleSyncNotesAndHabits()}
              disabled={isSyncing}
              className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-xs font-semibold text-white disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{isSyncing ? "Syncing..." : "Sync to Lobo"}</span>
            </button>
          </div>
        </section>
      )}

      {section === "SETTINGS" && (
        <div className="space-y-4">
          <HardwareAndMobilePanels showToast={showToast} />

          <section className="p-4 rounded-2xl bg-white border border-zinc-200 flex items-center justify-between gap-3">
            <div className="flex items-center space-x-3">
              <Cpu className="w-4 h-4 text-zinc-800 shrink-0" />
              <div>
                <div className="flex items-center space-x-2">
                  <span className="text-xs font-semibold text-zinc-950">Device Firmware</span>
                  <span className="px-2 py-0.5 rounded bg-zinc-100 text-zinc-800 text-[11px] font-mono">
                    {robotFirmwareVersion}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500">Signed over-the-air updates</p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                webAudioSynth.play("TICK");
                setIsOtaModalOpen(true);
              }}
              className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-white hover:bg-zinc-50 border border-zinc-300 text-xs font-semibold text-zinc-950 shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Update</span>
            </button>
          </section>
        </div>
      )}

      <FirmwareUpdateModal
        isOpen={isOtaModalOpen}
        onClose={() => setIsOtaModalOpen(false)}
        currentVersion={robotFirmwareVersion}
        onUpdateCompleted={(newVer) => {
          setRobotFirmwareVersion(newVer);
          showToast(`Firmware updated to ${newVer}`);
        }}
      />
    </div>
  );
};

export default DeviceHubView;
