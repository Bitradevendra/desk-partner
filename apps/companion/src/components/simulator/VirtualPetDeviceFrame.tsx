import React, { useState, useRef, useCallback } from "react";
import type { WidgetPackage, EventType } from "@petbot/widget-schema";
import {
  WidgetRuntimeSimulator,
  type WidgetRuntimeSimulatorRef,
} from "./WidgetRuntimeSimulator.js";
import { webAudioSynth } from "../../services/web-audio-synth.js";
import {
  Volume2,
  VolumeX,
  Monitor,
  Maximize2,
  Hand,
  Clock,
  Heart,
} from "lucide-react";

export interface VirtualPetDeviceFrameProps {
  widget: WidgetPackage;
  stateSlots?: Record<string, string | number | boolean> | undefined;
  petEmotion?: import("@petbot/widget-schema").EmotionType | undefined;
  onStateChange?: ((slots: Record<string, string | number | boolean>) => void) | undefined;
  initialScale?: number | undefined;
  className?: string | undefined;
  showDevControls?: boolean | undefined;
}

export const VirtualPetDeviceFrame: React.FC<VirtualPetDeviceFrameProps> = ({
  widget,
  stateSlots,
  petEmotion,
  onStateChange,
  initialScale = 1.45,
  className = "",
  showDevControls = false,
}) => {
  const simulatorRef = useRef<WidgetRuntimeSimulatorRef | null>(null);

  const [scale, setScale] = useState<number>(initialScale);
  const [showScanlines, setShowScanlines] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(() => webAudioSynth.isMuted());

  const [gestureFeedback, setGestureFeedback] = useState<string | null>(null);
  const [touchActive, setTouchActive] = useState<boolean>(false);

  const showFeedback = (text: string) => {
    setGestureFeedback(text);
    setTouchActive(true);
    setTimeout(() => {
      setGestureFeedback((curr) => (curr === text ? null : curr));
      setTouchActive(false);
    }, 1400);
  };

  const dispatchEvent = useCallback((event: EventType, label: string) => {
    simulatorRef.current?.dispatchTouchEvent(event);
    showFeedback(label);
  }, []);

  const handleLeftTap = () => {
    webAudioSynth.play("TICK");
    dispatchEvent("ON_TOUCH_LEFT_TAP", "Left Ear Tap");
  };

  const handleRightTap = () => {
    webAudioSynth.play("TICK");
    dispatchEvent("ON_TOUCH_RIGHT_TAP", "Right Ear Tap");
  };

  const handleLeftDoubleTap = () => {
    webAudioSynth.play("CHIRP");
    dispatchEvent("ON_TOUCH_LEFT_DOUBLE_TAP", "Left 2x (Home)");
  };

  const handleRightDoubleTap = () => {
    webAudioSynth.play("HAPPY_TRILL");
    dispatchEvent("ON_TOUCH_RIGHT_DOUBLE_TAP", "Right 2x (Next Screen)");
  };

  const handleLeftLongPress = () => {
    webAudioSynth.play("TICK");
    dispatchEvent("ON_TOUCH_LEFT_LONG_PRESS", "Left Hold (Voice Memo)");
  };

  const handleRightLongPress = () => {
    webAudioSynth.play("HAPPY_TRILL");
    dispatchEvent("ON_TOUCH_RIGHT_LONG_PRESS", "Right Hold (25m Focus)");
  };

  const handleSideTap = () => {
    webAudioSynth.play("TICK");
    dispatchEvent("ON_TOUCH_SIDE_TAP", "Side Tap");
  };

  const handleSideDoubleTap = () => {
    webAudioSynth.play("CHIRP");
    dispatchEvent("ON_TOUCH_SIDE_DOUBLE_TAP", "Side 2x (Briefing)");
  };

  const handleSideLongPress = () => {
    webAudioSynth.play("CHIRP");
    dispatchEvent("ON_TOUCH_SIDE_LONG_PRESS", "Side Hold (Voice)");
  };

  const handleDualTap = () => {
    webAudioSynth.play("HAPPY_TRILL");
    dispatchEvent("ON_TOUCH_DUAL_TAP", "Dual Tap");
  };

  const handleDualLongPress = () => {
    webAudioSynth.play("SLEEPY_SIGH");
    dispatchEvent("ON_TOUCH_DUAL_LONG_PRESS", "Dual Hold (Dimmer)");
  };

  const handleQuickPetting = () => {
    webAudioSynth.play("PURR");
    dispatchEvent("ON_TOUCH_DUAL_PETTING", "Petted");
  };

  const handleSwipeL2R = () => {
    webAudioSynth.play("TICK");
    dispatchEvent("ON_TOUCH_SWIPE_L2R", "Swipe Next");
  };

  const handleSwipeR2L = () => {
    webAudioSynth.play("TICK");
    dispatchEvent("ON_TOUCH_SWIPE_R2L", "Swipe Previous");
  };

  const handleRightPinch = () => {
    webAudioSynth.play("TICK");
    dispatchEvent("ON_TOUCH_RIGHT_PINCH", "Volume Up");
  };

  const handleCrossChord = () => {
    webAudioSynth.play("TICK");
    dispatchEvent("ON_TOUCH_CROSS_CHORD", "Volume Down");
  };

  const handleSwipeTopToSide = () => {
    webAudioSynth.play("TICK");
    dispatchEvent("ON_TOUCH_SWIPE_TOP_TO_SIDE", "Scroll Down");
  };

  const handleSwipeSideToTop = () => {
    webAudioSynth.play("TICK");
    dispatchEvent("ON_TOUCH_SWIPE_SIDE_TO_TOP", "Scroll Up");
  };

  const handleTripleTap = () => {
    webAudioSynth.play("WARNING");
    dispatchEvent("ON_TOUCH_TRIPLE_TAP", "Emergency Stop");
  };

  const handleTripleLongPress = () => {
    webAudioSynth.play("CHIRP");
    dispatchEvent("ON_TOUCH_TRIPLE_LONG_PRESS", "System Reset");
  };

  const handleFullBodyGrooming = () => {
    webAudioSynth.play("PURR");
    dispatchEvent("ON_TOUCH_FULL_BODY_GROOM", "Groomed");
  };

  const toggleMute = () => {
    const muted = webAudioSynth.toggleMute();
    setIsMuted(muted);
    if (!muted) {
      webAudioSynth.play("CHIRP");
    }
  };

  return (
    <div className={`flex flex-col items-center space-y-4 max-w-full ${className}`}>
      {/* Matte Black Desk Hardware Enclosure */}
      <div className="relative flex flex-col items-center rounded-3xl bg-zinc-900 p-5 border border-zinc-800 shadow-sm max-w-full">
        {/* Top Dual Touch Pads */}
        <div className="mb-3 flex flex-col items-center w-full">
          <div className="flex items-center justify-between w-full gap-2">
            <button
              type="button"
              onClick={handleLeftTap}
              className={`flex-1 flex h-7 items-center justify-center rounded-lg px-2.5 text-[10px] font-medium border transition-colors select-none ${
                touchActive
                  ? "bg-white text-zinc-950 border-white"
                  : "bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700"
              }`}
              title="Left Touch Sensor (GPIO 1)"
            >
              Left Sensor
            </button>

            <button
              type="button"
              onClick={handleRightTap}
              className={`flex-1 flex h-7 items-center justify-center rounded-lg px-2.5 text-[10px] font-medium border transition-colors select-none ${
                touchActive
                  ? "bg-white text-zinc-950 border-white"
                  : "bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700"
              }`}
              title="Right Touch Sensor (GPIO 2)"
            >
              Right Sensor
            </button>
          </div>
        </div>

        {/* Right Side Button Sensor */}
        <button
          type="button"
          onClick={handleSideTap}
          className={`absolute -right-2.5 top-28 h-20 w-2.5 rounded-r-md border transition-colors select-none ${
            touchActive
              ? "bg-white border-white"
              : "bg-zinc-700 border-zinc-600 hover:bg-zinc-500"
          }`}
          title="Side Touch Sensor (GPIO 3)"
        />

        {/* 1.8" Horizontal Display Bezel (pins on LEFT side) */}
        <div
          className="relative flex items-center rounded-xl bg-black p-2 border border-zinc-800"
          style={{ touchAction: "pan-y" }}
        >
          {/* Left-edge TFT Header Pin Reference Strip */}
          <div
            className="mr-1.5 flex flex-col justify-between h-24 w-1.5 py-1 rounded-sm bg-zinc-800/80 shrink-0"
            title="Display Header Pins (Left Side)"
          >
            <span className="w-1 h-1 mx-auto rounded-full bg-amber-400/75" />
            <span className="w-1 h-1 mx-auto rounded-full bg-zinc-500" />
            <span className="w-1 h-1 mx-auto rounded-full bg-zinc-500" />
            <span className="w-1 h-1 mx-auto rounded-full bg-zinc-500" />
            <span className="w-1 h-1 mx-auto rounded-full bg-zinc-500" />
            <span className="w-1 h-1 mx-auto rounded-full bg-zinc-500" />
            <span className="w-1 h-1 mx-auto rounded-full bg-zinc-500" />
            <span className="w-1 h-1 mx-auto rounded-full bg-zinc-500" />
          </div>

          <WidgetRuntimeSimulator
            ref={simulatorRef}
            widget={widget}
            stateSlots={stateSlots}
            petEmotion={petEmotion}
            onStateChange={onStateChange}
            scale={scale}
            showScanlines={showScanlines}
          />

          {gestureFeedback && (
            <div className="pointer-events-none absolute top-3 left-4 right-3 rounded-md bg-white px-2 py-1 text-center text-[11px] font-semibold text-zinc-950 shadow-sm border border-zinc-200">
              {gestureFeedback}
            </div>
          )}
        </div>

        {/* Bottom Hardware Markings */}
        <div className="mt-3.5 flex w-full items-center justify-between px-2 text-[10px] font-mono text-zinc-500">
          <span>···</span>
          <div className="flex items-center space-x-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                touchActive ? "bg-white" : "bg-emerald-500"
              }`}
            />
            <span className="font-semibold tracking-wider text-zinc-400">LOBO S3</span>
          </div>
          <span>···</span>
        </div>
      </div>

      {/* Advanced Gesture Test Toolbar (shown in Advanced Mode) */}
      {showDevControls && (
        <div className="w-full max-w-md space-y-3">
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {[
              { label: "L Tap", fn: handleLeftTap, icon: Hand },
              { label: "R Tap", fn: handleRightTap, icon: Hand },
              { label: "L 2x Home", fn: handleLeftDoubleTap, icon: Hand },
              { label: "R 2x Next", fn: handleRightDoubleTap, icon: Hand },
              { label: "L Hold Memo", fn: handleLeftLongPress, icon: Clock },
              { label: "R Hold Focus", fn: handleRightLongPress, icon: Clock },
              { label: "Side Tap", fn: handleSideTap, icon: Hand },
              { label: "Side 2x Brief", fn: handleSideDoubleTap, icon: Hand },
              { label: "Side Hold Voice", fn: handleSideLongPress, icon: Clock },
              { label: "Dual Tap", fn: handleDualTap, icon: Heart },
              { label: "Dual Pet", fn: handleQuickPetting, icon: Heart },
              { label: "Dual Dimmer", fn: handleDualLongPress, icon: Clock },
              { label: "Swipe L-R", fn: handleSwipeL2R, icon: Hand },
              { label: "Swipe R-L", fn: handleSwipeR2L, icon: Hand },
              { label: "Vol+", fn: handleRightPinch, icon: Hand },
              { label: "Vol-", fn: handleCrossChord, icon: Hand },
              { label: "Scroll Down", fn: handleSwipeTopToSide, icon: Hand },
              { label: "Scroll Up", fn: handleSwipeSideToTop, icon: Hand },
              { label: "Full Groom", fn: handleFullBodyGrooming, icon: Heart },
              { label: "3x E-Stop", fn: handleTripleTap, icon: Hand },
              { label: "3x Reset", fn: handleTripleLongPress, icon: Clock },
            ].map((btn) => {
              const Icon = btn.icon;
              return (
                <button
                  key={btn.label}
                  type="button"
                  onClick={btn.fn}
                  className="flex items-center space-x-1 rounded-md bg-white px-2.5 py-1 text-[11px] font-mono text-zinc-800 border border-zinc-300 hover:border-zinc-950 transition-colors"
                >
                  <Icon className="h-3 w-3 text-zinc-500" strokeWidth={1.75} />
                  <span>{btn.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-center space-x-3 rounded-lg bg-white px-3 py-1.5 text-xs font-mono border border-zinc-200">
            <div className="flex items-center space-x-1 border-r border-zinc-200 pr-2.5">
              <Maximize2 className="h-3.5 w-3.5 text-zinc-500" />
              {[1.5, 2.0, 2.5].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScale(s)}
                  className={`px-1.5 py-0.5 rounded ${
                    scale === s ? "bg-zinc-950 text-white font-semibold" : "text-zinc-600 hover:text-zinc-950"
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShowScanlines(!showScanlines)}
              className={`flex items-center space-x-1 px-1.5 py-0.5 rounded ${
                showScanlines ? "bg-zinc-950 text-white font-semibold" : "text-zinc-600 hover:text-zinc-950"
              }`}
            >
              <Monitor className="h-3.5 w-3.5" />
              <span>Grid</span>
            </button>

            <button
              type="button"
              onClick={toggleMute}
              className={`flex items-center space-x-1 px-1.5 py-0.5 rounded ${
                isMuted ? "text-zinc-500" : "bg-zinc-950 text-white font-semibold"
              }`}
            >
              {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              <span>{isMuted ? "Muted" : "Sound"}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
