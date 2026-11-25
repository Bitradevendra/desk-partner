import React, { useState, useRef } from "react";
import {
  Mic,
  MicOff,
  Check,
  ShieldAlert,
  ShieldCheck,
  MessageSquare,
  Key,
  Send,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal,
} from "lucide-react";
import { usePetBotStore } from "../../store/usePetBotStore.js";
import { webAudioSynth } from "../../services/web-audio-synth.js";

type CommandFilter = "NONE" | "ALL" | "WIDGETS" | "HABITS" | "PHONE";
type LogFilter = "ALL" | "EXECUTED" | "PENDING";

const COMMAND_SAMPLES: { category: "WIDGETS" | "HABITS" | "PHONE"; label: string }[] = [
  { category: "HABITS", label: "Add Meditation 10m to habits" },
  { category: "HABITS", label: "Mark Drink Water complete" },
  { category: "HABITS", label: "Save a note: Call Alex at 5 PM" },
  { category: "WIDGETS", label: "Open Habits Tracker" },
  { category: "WIDGETS", label: "Open Quick Notes" },
  { category: "WIDGETS", label: "Start 25m focus timer" },
  { category: "PHONE", label: "Turn on phone flashlight" },
  { category: "PHONE", label: "Set alarm for 7:00 AM" },
];

export const VoiceAndProView: React.FC = () => {
  const {
    subscription,
    setVoicePersona,
    wakeMode,
    setWakeMode,
    harnessLogs,
    hardwareSettings,
    updateHardwareSettings,
    geminiApiKey,
    setGeminiApiKey,
    lastVoiceStatus,
    executeVoiceCommand,
  } = usePetBotStore();

  const [isRecording, setIsRecording] = useState(false);
  const [micFeedback, setMicFeedback] = useState<string | null>(null);
  const [replyText, setReplyText] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState("");
  const [isSendingCommand, setIsSendingCommand] = useState(false);
  const [executedActionTags, setExecutedActionTags] = useState<string[]>([]);
  const commandInputRef = useRef<HTMLInputElement>(null);

  // Compact Toggles & Filters
  const [commandFilter, setCommandFilter] = useState<CommandFilter>("NONE");
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [showMicSettings, setShowMicSettings] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [geminiDraft, setGeminiDraft] = useState(geminiApiKey);
  const [showActivityDrawer, setShowActivityDrawer] = useState(false);
  const [logFilter, setLogFilter] = useState<LogFilter>("ALL");

  const handleRunCommand = async (text: string) => {
    if (!text.trim() || isSendingCommand) return;
    setIsSendingCommand(true);
    setCommandInput("");
    setMicFeedback("Running...");
    webAudioSynth.play("CHIRP");

    try {
      const res = await executeVoiceCommand(text.trim());
      setReplyText(res.spokenText);
      setExecutedActionTags(res.actions);
      setMicFeedback(
        res.actions.length > 0 ? `Done (${res.actions.length} action)` : "Ready"
      );
      webAudioSynth.play("SUCCESS");
    } finally {
      setIsSendingCommand(false);
    }
  };

  const handleDictateCommand = () => {
    if (isRecording) {
      setIsRecording(false);
      return;
    }

    const SpeechRec =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRec) {
      setMicFeedback("Tap the text box and use your keyboard mic or type a command.");
      commandInputRef.current?.focus();
      return;
    }

    try {
      const recognition = new SpeechRec();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "en-US";

      recognition.onstart = () => {
        setIsRecording(true);
        setMicFeedback("Listening...");
        webAudioSynth.play("CHIRP");
      };

      recognition.onresult = (event: any) => {
        const transcript = event.results[0]?.[0]?.transcript;
        if (transcript) {
          setCommandInput(transcript);
          void handleRunCommand(transcript);
        }
      };

      recognition.onerror = () => {
        setIsRecording(false);
        setMicFeedback("Could not capture speech. Try typing a command.");
      };

      recognition.onend = () => {
        setIsRecording(false);
      };

      recognition.start();
    } catch {
      setIsRecording(false);
      commandInputRef.current?.focus();
    }
  };

  const personas = [
    {
      id: "Nova - Cheerful Cyber Pet",
      displayName: "Nova",
      tone: "Friendly",
      note: "Everyday assistant",
    },
    {
      id: "Atlas - Calm Deep-Work Coach",
      displayName: "Atlas",
      tone: "Calm",
      note: "Concise focus replies",
    },
    {
      id: "Pixel - Playful Sidekick",
      displayName: "Pixel",
      tone: "Playful",
      note: "Short upbeat replies",
    },
  ];

  const activePersonaObj =
    personas.find((p) => p.id === subscription.voicePersona) || personas[0]!;

  const filteredSamples =
    commandFilter === "NONE"
      ? []
      : commandFilter === "ALL"
      ? COMMAND_SAMPLES
      : COMMAND_SAMPLES.filter((c) => c.category === commandFilter);

  const filteredLogs = harnessLogs.filter((l) => {
    if (logFilter === "EXECUTED") return l.status === "EXECUTED" || l.status === "APPROVED";
    if (logFilter === "PENDING") return l.status === "PENDING";
    return true;
  });

  const formatDate = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col space-y-4">
      {/* 1. Compact Command Input & Filter Chips */}
      <section className="p-4 sm:p-5 rounded-2xl bg-white border border-zinc-200 space-y-3.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold text-zinc-950 tracking-tight">
              Voice &amp; Commands
            </h1>
            <p className="text-xs text-zinc-500">
              Speak or type commands for Lobo, widgets, or phone actions
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleDictateCommand()}
            className={`flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors shrink-0 ${
              isRecording
                ? "bg-red-600 border-red-600 text-white"
                : "bg-zinc-950 border-zinc-950 text-white hover:bg-zinc-800"
            }`}
          >
            {isRecording ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
            <span>{isRecording ? "Stop" : "Speak"}</span>
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleRunCommand(commandInput);
          }}
          className="flex items-center gap-2"
        >
          <input
            ref={commandInputRef}
            type="text"
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            placeholder='Try "Mark Water done", "Open Notes", "Start 25m timer"...'
            className="flex-1 px-3.5 py-2.5 rounded-xl bg-zinc-50 border border-zinc-300 focus:border-zinc-950 outline-none text-sm text-zinc-950 placeholder-zinc-400"
          />
          <button
            type="submit"
            disabled={isSendingCommand || !commandInput.trim()}
            className="flex items-center space-x-1 px-4 py-2.5 rounded-xl bg-zinc-950 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-semibold"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Run</span>
          </button>
        </form>

        {/* Quick Examples Filter Pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-zinc-500 mr-1">Examples:</span>
          {(
            [
              { id: "NONE", label: "Hidden" },
              { id: "WIDGETS", label: "Screens" },
              { id: "HABITS", label: "Habits & Notes" },
              { id: "PHONE", label: "Phone" },
              { id: "ALL", label: "All" },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setCommandFilter(f.id)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                commandFilter === f.id
                  ? "bg-zinc-950 text-white border-zinc-950"
                  : "bg-zinc-50 text-zinc-600 border-zinc-200 hover:border-zinc-400"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {filteredSamples.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {filteredSamples.map((sample) => (
              <button
                key={sample.label}
                type="button"
                onClick={() => void handleRunCommand(sample.label)}
                className="px-2.5 py-1 rounded-lg bg-white hover:bg-zinc-50 border border-zinc-200 hover:border-zinc-400 text-xs text-zinc-800"
              >
                {sample.label}
              </button>
            ))}
          </div>
        )}

        {(micFeedback || replyText) && (
          <div className="p-3 rounded-xl bg-zinc-50 border border-zinc-200 space-y-1.5">
            {replyText ? (
              <>
                <div className="flex items-center justify-between text-xs font-semibold text-zinc-950">
                  <span className="flex items-center space-x-1.5">
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>Lobo</span>
                  </span>
                  {micFeedback && <span className="font-normal text-zinc-500">{micFeedback}</span>}
                </div>
                <p className="text-sm text-zinc-900">{replyText}</p>
                {executedActionTags.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {executedActionTags.map((tag, i) => (
                      <span
                        key={i}
                        className="px-2 py-0.5 rounded bg-white border border-zinc-300 text-[11px] font-mono text-zinc-800"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-zinc-600">{micFeedback}</div>
            )}
          </div>
        )}
      </section>

      {/* 2. Compact Toggles for Voice Style, Wake Mode & Mic Settings */}
      <section className="p-4 rounded-2xl bg-white border border-zinc-200 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Voice Style Collapsible Selector */}
          <button
            type="button"
            onClick={() => setShowVoicePicker(!showVoicePicker)}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
              showVoicePicker
                ? "bg-zinc-950 border-zinc-950 text-white"
                : "bg-zinc-50 border-zinc-200 text-zinc-900 hover:border-zinc-400"
            }`}
          >
            <span>Voice: {activePersonaObj.displayName}</span>
            {showVoicePicker ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>

          {/* Wake Mode Toggle */}
          <div className="flex items-center p-0.5 rounded-lg bg-zinc-100 border border-zinc-200 text-xs font-medium">
            <button
              type="button"
              onClick={() => setWakeMode("PUSH_TO_TALK")}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                wakeMode === "PUSH_TO_TALK"
                  ? "bg-white text-zinc-950 shadow-sm"
                  : "text-zinc-600"
              }`}
            >
              Push-to-Talk
            </button>
            <button
              type="button"
              onClick={() => setWakeMode("VOICE_ACTIVITY")}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                wakeMode === "VOICE_ACTIVITY"
                  ? "bg-white text-zinc-950 shadow-sm"
                  : "text-zinc-600"
              }`}
            >
              Wake Word
            </button>
          </div>

          {/* Mic Options Collapsible Toggle */}
          <button
            type="button"
            onClick={() => setShowMicSettings(!showMicSettings)}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
              showMicSettings
                ? "bg-zinc-950 border-zinc-950 text-white"
                : "bg-white border-zinc-300 text-zinc-700 hover:text-zinc-950"
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Mic &amp; Wake</span>
          </button>

          {/* Gemini API Key Collapsible Toggle */}
          <button
            type="button"
            onClick={() => setShowGeminiKey(!showGeminiKey)}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
              showGeminiKey
                ? "bg-zinc-950 border-zinc-950 text-white"
                : "bg-white border-zinc-300 text-zinc-700 hover:text-zinc-950"
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span>{geminiApiKey ? "Gemini: Ready" : "Gemini Key"}</span>
          </button>
        </div>

        {lastVoiceStatus && (
          <div className="text-[11px] font-mono text-zinc-600 bg-zinc-50 border border-zinc-200 rounded-lg px-2.5 py-1.5">
            {lastVoiceStatus}
          </div>
        )}

        {showGeminiKey && (
          <div className="pt-2 border-t border-zinc-100 space-y-2">
            <div className="text-[11px] text-zinc-600">
              Used directly from your phone to understand Lobo&apos;s raw WAV audio and trigger actions.
            </div>
            <div className="flex items-center space-x-2">
              <input
                type="password"
                value={geminiDraft}
                onChange={(e) => setGeminiDraft(e.target.value)}
                placeholder="Paste AIza... Gemini API key"
                className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-50 border border-zinc-300 focus:border-zinc-950 text-xs font-mono text-zinc-950 outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  setGeminiApiKey(geminiDraft);
                  setShowGeminiKey(false);
                  webAudioSynth.play("SUCCESS");
                  setMicFeedback(geminiDraft.trim() ? "Gemini API key saved" : "Gemini API key cleared");
                }}
                className="px-3 py-1.5 rounded-lg bg-zinc-950 text-white text-xs font-medium"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {/* Expanded ONLY when user clicks Voice toggle */}
        {showVoicePicker && (
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-zinc-100">
            {personas.map((persona) => {
              const selected = subscription.voicePersona === persona.id;
              return (
                <button
                  key={persona.id}
                  type="button"
                  onClick={() => {
                    setVoicePersona(persona.id);
                    setShowVoicePicker(false);
                  }}
                  className={`p-2.5 rounded-xl border text-left transition-colors ${
                    selected
                      ? "bg-zinc-950 border-zinc-950 text-white"
                      : "bg-zinc-50 border-zinc-200 text-zinc-900 hover:border-zinc-400"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span>{persona.displayName}</span>
                    {selected && <Check className="w-3 h-3" />}
                  </div>
                  <div
                    className={`text-[11px] mt-0.5 ${
                      selected ? "text-zinc-300" : "text-zinc-500"
                    }`}
                  >
                    {persona.tone} · {persona.note}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Expanded ONLY when user clicks Mic & Wake toggle */}
        {showMicSettings && (
          <div className="pt-2 border-t border-zinc-100 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center space-x-1.5">
                {(["Hi ESP", "Hey Lobo", "Hey PetBot"] as const).map((phrase) => {
                  const active = hardwareSettings.wakeWordPhrase === phrase;
                  return (
                    <button
                      key={phrase}
                      type="button"
                      onClick={() => {
                        webAudioSynth.play("TICK");
                        void updateHardwareSettings({ wakeWordPhrase: phrase });
                      }}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium border ${
                        active
                          ? "bg-zinc-950 border-zinc-950 text-white"
                          : "bg-zinc-50 border-zinc-200 text-zinc-700"
                      }`}
                    >
                      {phrase}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => {
                  webAudioSynth.play("TICK");
                  void updateHardwareSettings({
                    wakeWordEnabled: !hardwareSettings.wakeWordEnabled,
                  });
                }}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border ${
                  hardwareSettings.wakeWordEnabled
                    ? "bg-zinc-950 border-zinc-950 text-white"
                    : "bg-white border-zinc-300 text-zinc-600"
                }`}
              >
                Hands-Free: {hardwareSettings.wakeWordEnabled ? "On" : "Off"}
              </button>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-600">Mic Sensitivity</span>
                <span className="font-mono font-semibold text-zinc-950">
                  {hardwareSettings.vadSensitivity} RMS
                </span>
              </div>
              <input
                type="range"
                min={200}
                max={1500}
                step={50}
                value={hardwareSettings.vadSensitivity}
                onChange={(e) =>
                  void updateHardwareSettings({ vadSensitivity: Number(e.target.value) })
                }
                className="w-full accent-zinc-950 cursor-pointer"
              />
            </div>
          </div>
        )}
      </section>

      {/* 3. Compact Collapsible Activity Drawer with Status Filter */}
      <section className="p-4 rounded-2xl bg-white border border-zinc-200">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setShowActivityDrawer(!showActivityDrawer)}
            className="flex items-center space-x-2 text-xs font-semibold text-zinc-950"
          >
            <span>Activity ({harnessLogs.length})</span>
            {showActivityDrawer ? (
              <ChevronUp className="w-3.5 h-3.5 text-zinc-500" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
            )}
          </button>

          {showActivityDrawer && (
            <div className="flex items-center space-x-1">
              {(["ALL", "EXECUTED", "PENDING"] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setLogFilter(st)}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                    logFilter === st
                      ? "bg-zinc-950 border-zinc-950 text-white"
                      : "bg-zinc-50 border-zinc-200 text-zinc-600"
                  }`}
                >
                  {st === "ALL" ? "All" : st === "EXECUTED" ? "Done" : "Pending"}
                </button>
              ))}
            </div>
          )}
        </div>

        {showActivityDrawer && (
          <div className="mt-3 space-y-2">
            {filteredLogs.map((log) => {
              const isApproved = log.status === "APPROVED" || log.status === "EXECUTED";
              const isPending = log.status === "PENDING";
              return (
                <div
                  key={log.id}
                  className="flex items-center justify-between gap-3 p-2.5 rounded-xl bg-zinc-50 border border-zinc-200"
                >
                  <div className="flex items-center space-x-2.5 min-w-0">
                    {isPending ? (
                      <Key className="w-3.5 h-3.5 text-zinc-700 shrink-0" />
                    ) : isApproved ? (
                      <ShieldCheck className="w-3.5 h-3.5 text-zinc-700 shrink-0" />
                    ) : (
                      <ShieldAlert className="w-3.5 h-3.5 text-zinc-700 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-zinc-950 truncate">{log.title}</div>
                      {log.details && (
                        <div className="text-[11px] text-zinc-500 truncate">{log.details}</div>
                      )}
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-zinc-500 shrink-0">
                    {formatDate(log.timestamp)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

export default VoiceAndProView;
