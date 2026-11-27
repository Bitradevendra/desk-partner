import React, { useState } from "react";
import {
  Volume2,
  Sun,
  Moon,
  Clock,
  Hand,
  Mic,
  Check,
  ChevronDown,
  ChevronUp,
  Smartphone,
  Laptop,
} from "lucide-react";
import {
  usePetBotStore,
  type SideDoubleTapAction,
  type AndroidMirrorSettings,
} from "../../store/usePetBotStore.js";
import { webAudioSynth } from "../../services/web-audio-synth.js";

interface HardwareAndMobilePanelsProps {
  showToast: (msg: string) => void;
}

type SettingsFilter = "SOUND" | "WAKE" | "TOUCH";

const SIDE_DOUBLE_TAP_OPTIONS: {
  value: SideDoubleTapAction;
  label: string;
}[] = [
  { value: "AI_BRIEFING", label: "Daily Summary" },
  { value: "MEDIA_PLAY_PAUSE", label: "Media Control" },
  { value: "NEXT_WIDGET", label: "Next Screen" },
];

const MIRROR_APPS: { key: keyof AndroidMirrorSettings; label: string }[] = [
  { key: "mirrorCalls", label: "Calls" },
  { key: "mirrorWhatsApp", label: "WhatsApp" },
  { key: "mirrorCalendar", label: "Calendar" },
  { key: "mirrorSlack", label: "Slack" },
];

export const HardwareAndMobilePanels: React.FC<HardwareAndMobilePanelsProps> = ({
  showToast,
}) => {
  const {
    hardwareSettings,
    updateHardwareSettings,
    isMobilePartnerActive,
    triggerMobileTakeover,
    yieldMobileToDesktop,
    androidMirrorSettings,
    setAndroidMirrorSetting,
  } = usePetBotStore();

  const [activeFilter, setActiveFilter] = useState<SettingsFilter>("SOUND");
  const [showAlertsDrawer, setShowAlertsDrawer] = useState(false);

  const handleToggleMobilePartner = async () => {
    webAudioSynth.play("TICK");
    if (isMobilePartnerActive) {
      await yieldMobileToDesktop();
      showToast("Switched host to Desktop");
    } else {
      await triggerMobileTakeover();
      showToast("Phone set as active host");
    }
  };

  return (
    <div className="p-4 sm:p-5 rounded-2xl bg-white border border-zinc-200 space-y-4">
      {/* Compact Header & Filter Pills */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-zinc-100 border border-zinc-200">
          {(
            [
              { id: "SOUND", label: "Sound & Display" },
              { id: "WAKE", label: "Wake Word" },
              { id: "TOUCH", label: "Touch & Sync" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveFilter(tab.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeFilter === tab.id
                  ? "bg-white text-zinc-950 shadow-sm"
                  : "text-zinc-600 hover:text-zinc-950"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => void handleToggleMobilePartner()}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
            isMobilePartnerActive
              ? "bg-zinc-950 border-zinc-950 text-white"
              : "bg-white border-zinc-300 text-zinc-800 hover:border-zinc-950"
          }`}
        >
          {isMobilePartnerActive ? (
            <>
              <Smartphone className="w-3.5 h-3.5" />
              <span>Host: Phone</span>
            </>
          ) : (
            <>
              <Laptop className="w-3.5 h-3.5" />
              <span>Host: Desktop</span>
            </>
          )}
        </button>
      </div>

      {/* Filter 1: Sound & Display */}
      {activeFilter === "SOUND" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center space-x-1.5 text-zinc-700 font-medium">
                <Volume2 className="w-3.5 h-3.5" />
                <span>Speaker Volume</span>
              </span>
              <span className="font-mono font-semibold text-zinc-950">Max (100%)</span>
            </div>
            <div className="w-full h-2 rounded-full bg-zinc-950" />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center space-x-1.5 text-zinc-700 font-medium">
                <Sun className="w-3.5 h-3.5" />
                <span>Screen Brightness</span>
              </span>
              <span className="font-mono font-semibold text-zinc-950">
                {hardwareSettings.brightnessPct}%
              </span>
            </div>
            <input
              type="range"
              min={10}
              max={100}
              value={hardwareSettings.brightnessPct}
              onChange={(e) => void updateHardwareSettings({ brightnessPct: Number(e.target.value) })}
              className="w-full accent-zinc-950 cursor-pointer"
            />
          </div>

          <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-zinc-100">
            <button
              type="button"
              onClick={() => {
                webAudioSynth.play("TICK");
                void updateHardwareSettings({
                  nightDimScheduleEnabled: !hardwareSettings.nightDimScheduleEnabled,
                });
              }}
              className="flex items-center space-x-2 text-xs text-zinc-800"
            >
              <Moon className="w-3.5 h-3.5 text-zinc-600" />
              <span className="font-medium">Night Dimmer:</span>
              <span
                className={`px-2.5 py-0.5 rounded border font-medium ${
                  hardwareSettings.nightDimScheduleEnabled
                    ? "bg-zinc-950 border-zinc-950 text-white"
                    : "bg-white border-zinc-300 text-zinc-600"
                }`}
              >
                {hardwareSettings.nightDimScheduleEnabled ? "On" : "Off"}
              </span>
            </button>

            <div className="flex items-center space-x-1.5 text-xs">
              <Clock className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-zinc-600">Idle Return:</span>
              {([10, 15, 30] as const).map((sec) => {
                const active = hardwareSettings.silenceReturnSec === sec;
                return (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => {
                      webAudioSynth.play("TICK");
                      void updateHardwareSettings({ silenceReturnSec: sec });
                      showToast(`Return set to ${sec}s`);
                    }}
                    className={`px-2.5 py-1 rounded-md border font-medium ${
                      active
                        ? "bg-zinc-950 border-zinc-950 text-white"
                        : "bg-zinc-50 border-zinc-200 text-zinc-700"
                    }`}
                  >
                    {sec}s
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Filter 2: Wake Word */}
      {activeFilter === "WAKE" && (
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between">
            <span className="flex items-center space-x-1.5 text-xs font-medium text-zinc-900">
              <Mic className="w-3.5 h-3.5" />
              <span>Built-in Hands-Free Wake Word</span>
            </span>
            <button
              type="button"
              onClick={() => {
                webAudioSynth.play("TICK");
                void updateHardwareSettings({
                  wakeWordEnabled: !hardwareSettings.wakeWordEnabled,
                });
                showToast(
                  hardwareSettings.wakeWordEnabled ? "Wake word off" : "Wake word on"
                );
              }}
              className={`px-3 py-1 rounded-md text-xs font-medium border ${
                hardwareSettings.wakeWordEnabled
                  ? "bg-zinc-950 border-zinc-950 text-white"
                  : "bg-white border-zinc-300 text-zinc-600"
              }`}
            >
              {hardwareSettings.wakeWordEnabled ? "Enabled" : "Off"}
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {(["Hi ESP", "Hey Lobo", "Hey PetBot"] as const).map((phrase) => {
              const active = hardwareSettings.wakeWordPhrase === phrase;
              return (
                <button
                  key={phrase}
                  type="button"
                  onClick={() => {
                    webAudioSynth.play("CHIRP");
                    void updateHardwareSettings({ wakeWordPhrase: phrase });
                    showToast(`Wake word: "${phrase}"`);
                  }}
                  className={`py-2 px-2 rounded-lg text-xs font-medium border text-center transition-colors ${
                    active
                      ? "bg-zinc-950 border-zinc-950 text-white"
                      : "bg-zinc-50 border-zinc-200 text-zinc-700 hover:border-zinc-400"
                  }`}
                >
                  {phrase}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Filter 3: Touch & Alert Mirroring */}
      {activeFilter === "TOUCH" && (
        <div className="space-y-3 pt-1">
          <div className="space-y-1.5">
            <div className="flex items-center space-x-1.5 text-xs font-medium text-zinc-900">
              <Hand className="w-3.5 h-3.5" />
              <span>Side Button Double-Tap Action</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {SIDE_DOUBLE_TAP_OPTIONS.map((opt) => {
                const active = hardwareSettings.sideDoubleTapAction === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      webAudioSynth.play("TICK");
                      void updateHardwareSettings({ sideDoubleTapAction: opt.value });
                      showToast(`Double-tap: ${opt.label}`);
                    }}
                    className={`py-2 px-2.5 rounded-lg border text-xs font-medium flex items-center justify-center space-x-1 ${
                      active
                        ? "bg-zinc-950 border-zinc-950 text-white"
                        : "bg-zinc-50 border-zinc-200 text-zinc-800 hover:border-zinc-400"
                    }`}
                  >
                    <span>{opt.label}</span>
                    {active && <Check className="w-3 h-3 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="pt-2 border-t border-zinc-100">
            <button
              type="button"
              onClick={() => setShowAlertsDrawer(!showAlertsDrawer)}
              className="w-full flex items-center justify-between text-xs font-medium text-zinc-700 hover:text-zinc-950 py-1"
            >
              <span>Phone Alert Mirror Filters</span>
              {showAlertsDrawer ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>

            {showAlertsDrawer && (
              <div className="flex flex-wrap gap-1.5 pt-2">
                {MIRROR_APPS.map(({ key, label }) => {
                  const enabled = androidMirrorSettings[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        webAudioSynth.play("TICK");
                        setAndroidMirrorSetting(key, !enabled);
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        enabled
                          ? "bg-zinc-950 border-zinc-950 text-white"
                          : "bg-white border-zinc-200 text-zinc-600"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default HardwareAndMobilePanels;
