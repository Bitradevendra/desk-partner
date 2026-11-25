import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import type {
  WidgetPackage,
  UINode,
  EventType,
  Condition,
  Action,
  EmitHarnessRpcAction,
  EmotionType,
} from "@petbot/widget-schema";
import { webAudioSynth, type PetSoundEffect } from "../../services/web-audio-synth.js";
import { ExpressionCanvasRenderer } from "./ExpressionCanvasRenderer.js";

export interface WidgetRuntimeSimulatorProps {
  widget: WidgetPackage;
  stateSlots?: Record<string, string | number | boolean> | undefined;
  petEmotion?: EmotionType | undefined;
  onStateChange?: ((slots: Record<string, string | number | boolean>) => void) | undefined;
  onEmitHarnessRpc?: ((action: EmitHarnessRpcAction) => void) | undefined;
  onNavigatePage?: ((targetWidgetId: string) => void) | undefined;
  scale?: number | undefined;
  showScanlines?: boolean | undefined;
  className?: string | undefined;
}

export interface WidgetRuntimeSimulatorRef {
  dispatchTouchEvent: (event: EventType) => void;
  setExpression: (emotion: EmotionType, durationMs?: number) => void;
  getCanvas: () => HTMLCanvasElement | null;
}

export function toRgbString(color: string | number | undefined, fallback = "#000000"): string {
  if (color === undefined) return fallback;
  if (typeof color === "string") return color;
  // Convert 16-bit RGB565 to rgb(r, g, b)
  const r = ((color >> 11) & 0x1f) << 3;
  const g = ((color >> 5) & 0x3f) << 2;
  const b = (color & 0x1f) << 3;
  return `rgb(${r}, ${g}, ${b})`;
}

export const WidgetRuntimeSimulator = forwardRef<
  WidgetRuntimeSimulatorRef,
  WidgetRuntimeSimulatorProps
>(
  (
    {
      widget,
      stateSlots: externalSlots,
      petEmotion,
      onStateChange,
      onEmitHarnessRpc,
      onNavigatePage,
      scale = 1.6,
      showScanlines = false,
      className = "",
    },
    ref
  ) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    // Local reactive state dictionary
    const [localSlots, setLocalSlots] = useState<Record<string, string | number | boolean>>(() => {
      const initial: Record<string, string | number | boolean> = {};
      for (const [key, def] of Object.entries(widget.state || {})) {
        initial[key] = def.initialValue;
      }
      return initial;
    });

    // Merge external and local slots
    const currentSlots = externalSlots ?? localSlots;

    // Procedural expression engine instance
    const expressionRigRef = useRef<ExpressionCanvasRenderer>(
      new ExpressionCanvasRenderer("IDLE")
    );

    // Visual RPC toast banner
    const [rpcToast, setRpcToast] = useState<{
      actionId: string;
      riskTier: string;
      timestamp: number;
    } | null>(null);

    // Sync live expression from store/mood controls when changed
    useEffect(() => {
      if (petEmotion) {
        expressionRigRef.current.setEmotion(petEmotion);
      }
    }, [petEmotion]);

    // Sync state slots and default widget emotion when widget definition changes
    useEffect(() => {
      const initial: Record<string, string | number | boolean> = {};
      for (const [key, def] of Object.entries(widget.state || {})) {
        initial[key] = def.initialValue;
      }
      setLocalSlots(initial);
      onStateChange?.(initial);

      const findPetEmotion = (node?: UINode): EmotionType | null => {
        if (!node) return null;
        if (node.type === "PetExpression") return node.emotion;
        if (node.type === "Container" && node.children) {
          for (const child of node.children) {
            const found = findPetEmotion(child);
            if (found) return found;
          }
        }
        return null;
      };
      const nodeEmotion = findPetEmotion(widget.ui);
      if (nodeEmotion) {
        expressionRigRef.current.setEmotion(
          widget.manifest.id === "widget-pet-face-00" && petEmotion ? petEmotion : nodeEmotion
        );
      }
    }, [widget.manifest.id]);

    // Template interpolation helper: "{{cupsDrank}}" -> "4"
    const resolveTemplate = useCallback(
      (text: string): string => {
        return text.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
          const val = currentSlots[key] ?? widget.state[key]?.initialValue ?? "";
          return String(val);
        });
      },
      [currentSlots, widget.state]
    );

    // Condition evaluation matching C++ WidgetVM
    const evaluateCondition = useCallback(
      (condition?: Condition): boolean => {
        if (!condition) return true;
        const currentVal =
          currentSlots[condition.stateKey] ??
          widget.state[condition.stateKey]?.initialValue;

        if (currentVal === undefined) return false;

        const compare = condition.compareValue;

        switch (condition.operator) {
          case "EQ":
            return currentVal === compare;
          case "NEQ":
            return currentVal !== compare;
          case "GT":
            return Number(currentVal) > Number(compare);
          case "LT":
            return Number(currentVal) < Number(compare);
          case "GTE":
            return Number(currentVal) >= Number(compare);
          case "LTE":
            return Number(currentVal) <= Number(compare);
          default:
            return false;
        }
      },
      [currentSlots, widget.state]
    );

    // Action Execution Engine
    const executeAction = useCallback(
      (action: Action) => {
        switch (action.type) {
          case "MUTATE_STATE": {
            const current =
              currentSlots[action.targetKey] ??
              widget.state[action.targetKey]?.initialValue;

            let next: string | number | boolean = current ?? 0;
            const delta = typeof action.value === "number" ? action.value : 1;

            if (action.operation === "SET") {
              next = action.value !== undefined ? action.value : current ?? 0;
            } else if (action.operation === "INCREMENT") {
              next = (typeof current === "number" ? current : 0) + delta;
            } else if (action.operation === "DECREMENT") {
              next = (typeof current === "number" ? current : 0) - delta;
            } else if (action.operation === "TOGGLE") {
              next = !Boolean(current);
            }

            const updated = { ...currentSlots, [action.targetKey]: next };
            setLocalSlots(updated);
            onStateChange?.(updated);
            break;
          }

          case "PLAY_SOUND": {
            const effectName = action.soundId as PetSoundEffect;
            if (
              [
                "CHIRP",
                "HAPPY_TRILL",
                "PURR",
                "CURIOUS_BEEP",
                "SLEEPY_SIGH",
                "TICK",
                "SUCCESS",
                "WARNING",
              ].includes(effectName)
            ) {
              webAudioSynth.play(effectName);
            } else {
              webAudioSynth.playTone(action.frequencyHz, action.durationMs);
            }
            break;
          }

          case "SET_EXPRESSION": {
            expressionRigRef.current.setEmotion(action.emotion, action.durationMs);
            break;
          }

          case "EMIT_HARNESS_RPC": {
            setRpcToast({
              actionId: action.actionId,
              riskTier: action.riskTier,
              timestamp: Date.now(),
            });
            webAudioSynth.play("SUCCESS");
            onEmitHarnessRpc?.(action);
            setTimeout(() => {
              setRpcToast((prev) => (prev?.actionId === action.actionId ? null : prev));
            }, 2500);
            break;
          }

          case "NAVIGATE_PAGE": {
            onNavigatePage?.(action.targetWidgetId);
            break;
          }
        }
      },
      [currentSlots, widget.state, onStateChange, onEmitHarnessRpc, onNavigatePage]
    );

    // Dispatch Trigger Event (with dual-touch fallback routing)
    const dispatchTouchEvent = useCallback(
      (event: EventType) => {
        const triggers = widget.triggers || [];
        for (const rule of triggers) {
          const isMatch =
            rule.event === event ||
            (rule.event === "ON_TOUCH_TAP" &&
              (event === "ON_TOUCH_LEFT_TAP" || event === "ON_TOUCH_RIGHT_TAP")) ||
            (rule.event === "ON_TOUCH_DOUBLE_TAP" &&
              (event === "ON_TOUCH_LEFT_DOUBLE_TAP" || event === "ON_TOUCH_RIGHT_DOUBLE_TAP")) ||
            (rule.event === "ON_TOUCH_LONG_PRESS" &&
              (event === "ON_TOUCH_DUAL_LONG_PRESS")) ||
            (rule.event === "ON_TOUCH_PETTING" &&
              (event === "ON_TOUCH_DUAL_PETTING"));

          if (isMatch) {
            if (evaluateCondition(rule.condition)) {
              for (const action of rule.actions) {
                executeAction(action);
              }
            }
          }
        }
      },
      [widget.triggers, evaluateCondition, executeAction]
    );

    // Imperative Handle
    useImperativeHandle(
      ref,
      () => ({
        dispatchTouchEvent,
        setExpression: (emotion, durationMs) =>
          expressionRigRef.current.setEmotion(emotion, durationMs),
        getCanvas: () => canvasRef.current,
      }),
      [dispatchTouchEvent]
    );

    // Execute ON_LOAD triggers once mounted / changed
    useEffect(() => {
      dispatchTouchEvent("ON_LOAD");
    }, [widget.manifest.id, dispatchTouchEvent]);

    // Timer Tick interval
    useEffect(() => {
      const intervalMs = Math.max(16, widget.manifest.refreshIntervalMs || 1000);
      const timer = setInterval(() => {
        dispatchTouchEvent("ON_TIMER_TICK");
      }, intervalMs);

      return () => clearInterval(timer);
    }, [widget.manifest.refreshIntervalMs, dispatchTouchEvent]);

    // Recursive 2D Canvas Node Renderer
    const renderNode = useCallback(
      (ctx: CanvasRenderingContext2D, node: UINode, offsetX = 0, offsetY = 0) => {
        // Visibility check
        if (node.visible !== undefined) {
          if (typeof node.visible === "boolean" && !node.visible) return;
          if (typeof node.visible === "string") {
            const isVis = Boolean(currentSlots[node.visible]);
            if (!isVis) return;
          }
        }

        const nx = offsetX + node.x;
        const ny = offsetY + node.y;
        const nw = node.w;
        const nh = node.h;

        ctx.save();

        switch (node.type) {
          case "Container": {
            const bg = toRgbString(node.backgroundColor, "#000000");
            const r = Math.max(0, node.borderRadius || 0);

            ctx.fillStyle = bg;
            ctx.beginPath();
            ctx.roundRect(nx, ny, nw, nh, [r, r, r, r]);
            ctx.fill();

            if (node.borderColor) {
              ctx.strokeStyle = toRgbString(node.borderColor);
              ctx.lineWidth = 1;
              ctx.stroke();
            }

            const pad = node.padding || 0;
            if (node.children) {
              for (const child of node.children) {
                renderNode(ctx, child, nx + pad, ny + pad);
              }
            }
            break;
          }

          case "Text": {
            const str = resolveTemplate(node.text);
            const color = toRgbString(node.color, "#FFFFFF");

            let fontPx = 12;
            let weight = "600";
            if (node.fontSize === "sm") fontPx = 9;
            else if (node.fontSize === "md") fontPx = 12;
            else if (node.fontSize === "lg") fontPx = 15;
            else if (node.fontSize === "xl") {
              fontPx = 20;
              weight = "700";
            }

            ctx.font = `${weight} ${fontPx}px 'JetBrains Mono', monospace`;
            ctx.fillStyle = color;
            ctx.textBaseline = "middle";

            let tx = nx;
            if (node.align === "center") {
              tx = nx + nw / 2;
              ctx.textAlign = "center";
            } else if (node.align === "right") {
              tx = nx + nw;
              ctx.textAlign = "right";
            } else {
              ctx.textAlign = "left";
            }

            ctx.beginPath();
            ctx.rect(nx, ny, nw, nh);
            ctx.clip();

            ctx.fillText(str, tx, ny + nh / 2);
            break;
          }

          case "ProgressBar": {
            const rawVal =
              currentSlots[node.valueBinding] ??
              widget.state[node.valueBinding]?.initialValue ??
              0;
            const numVal = typeof rawVal === "number" ? rawVal : Number(rawVal) || 0;
            const range = Math.max(1, node.max - node.min);
            const pct = Math.min(1, Math.max(0, (numVal - node.min) / range));

            const bgColor = toRgbString(node.bgColor, "#1E2230");
            const fgColor = toRgbString(node.fgColor, "#00F0FF");

            // Background
            ctx.fillStyle = bgColor;
            ctx.beginPath();
            ctx.roundRect(nx, ny, nw, nh, [3, 3, 3, 3]);
            ctx.fill();

            // Foreground Fill
            ctx.fillStyle = fgColor;
            ctx.beginPath();
            if (node.orientation === "horizontal") {
              const fillW = Math.max(2, nw * pct);
              ctx.roundRect(nx, ny, fillW, nh, [3, 3, 3, 3]);
            } else {
              const fillH = Math.max(2, nh * pct);
              ctx.roundRect(nx, ny + (nh - fillH), nw, fillH, [3, 3, 3, 3]);
            }
            ctx.fill();
            break;
          }

          case "PetExpression": {
            expressionRigRef.current.render(ctx, { x: nx, y: ny, w: nw, h: nh });
            break;
          }

          case "Icon": {
            const iconColor = toRgbString(node.color, "#00F0FF");
            drawVectorIcon(ctx, node.builtinIconId, nx, ny, nw, nh, iconColor);
            break;
          }

          case "Sparkline": {
            const color = toRgbString(node.color, "#50FA7B");
            const t = Date.now() / 1000;
            // Simulated live sensor wave if not explicitly bound
            const pts: number[] = [
              0.4 + Math.sin(t * 1.5) * 0.2,
              0.6 + Math.cos(t * 2.0) * 0.25,
              0.35 + Math.sin(t * 3.1) * 0.2,
              0.75 + Math.cos(t * 1.8) * 0.2,
              0.9 + Math.sin(t * 2.4) * 0.1,
              0.55 + Math.cos(t * 2.9) * 0.2,
              0.8 + Math.sin(t * 1.2) * 0.18,
            ];

            const step = nw / (pts.length - 1);
            ctx.strokeStyle = color;
            ctx.lineWidth = node.lineWidth || 2;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";

            ctx.beginPath();
            pts.forEach((p, idx) => {
              const px = nx + idx * step;
              const py = ny + nh - p * nh;
              if (idx === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            });
            ctx.stroke();
            break;
          }

          case "List": {
            const rows = ["System Synced", "Audio Hal OK", "Agentic Ready"];
            const rowH = node.rowHeight || 18;
            ctx.font = "10px 'JetBrains Mono', monospace";
            ctx.textBaseline = "middle";

            rows.forEach((item, idx) => {
              const ry = ny + idx * rowH;
              if (ry + rowH > ny + nh) return;

              // Row divider
              ctx.strokeStyle = "#E4E4E7";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(nx, ry + rowH);
              ctx.lineTo(nx + nw, ry + rowH);
              ctx.stroke();

              // Row bullet
              ctx.fillStyle = toRgbString(node.activeItemColor, "#111111");
              ctx.beginPath();
              ctx.arc(nx + 6, ry + rowH / 2, 2.5, 0, Math.PI * 2);
              ctx.fill();

              // Text
              ctx.fillStyle = "#18181B";
              ctx.textAlign = "left";
              ctx.fillText(item, nx + 14, ry + rowH / 2);
            });
            break;
          }
        }

        ctx.restore();
      },
      [currentSlots, widget.state, resolveTemplate]
    );

    // 60FPS Animation Loop
    useEffect(() => {
      let animId: number;
      let lastTime = performance.now();

      const loop = (now: number) => {
        const dt = Math.min(0.1, (now - lastTime) / 1000);
        lastTime = now;

        // Update expression rig
        expressionRigRef.current.update(dt);

        // Render Canvas
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            // Clear screen to crisp white (160x128 landscape)
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(0, 0, 160, 128);

            // Render root UI tree
            if (widget.ui) {
              renderNode(ctx, widget.ui);
            }
          }
        }

        animId = requestAnimationFrame(loop);
      };

      animId = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(animId);
    }, [widget.ui, renderNode]);

    return (
      <div
        className={`relative inline-block select-none overflow-hidden rounded border border-zinc-200 transition-transform active:scale-[0.99] ${className}`}
        style={{
          width: `${160 * scale}px`,
          height: `${128 * scale}px`,
          backgroundColor: "#FFFFFF",
          touchAction: "pan-y",
        }}
        onClick={() => {
          webAudioSynth.play("TICK");
          dispatchTouchEvent("ON_TOUCH_TAP");
        }}
        title="160x128 Horizontal TFT Screen (Tap to interact)"
      >
        <canvas
          ref={canvasRef}
          width={160}
          height={128}
          style={{
            width: `${160 * scale}px`,
            height: `${128 * scale}px`,
            imageRendering: "pixelated",
            touchAction: "pan-y",
          }}
          className="block"
        />

        {/* Scanline CRT overlay for realistic hardware look */}
        {showScanlines && (
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.05]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, transparent, transparent 2px, #fff 2px, #fff 4px)",
            }}
          />
        )}

        {/* Action Feedback Overlay */}
        {rpcToast && (
          <div className="pointer-events-none absolute bottom-2 left-2 right-2 rounded bg-white p-1.5 text-center border border-zinc-300 shadow-sm">
            <div className="text-[9px] font-mono font-semibold text-zinc-600 uppercase tracking-wider">
              Action Sent
            </div>
            <div className="truncate text-[10px] font-mono text-zinc-950 font-semibold">
              {rpcToast.actionId.replace(/_/g, " ")}
            </div>
          </div>
        )}
      </div>
    );
  }
);

WidgetRuntimeSimulator.displayName = "WidgetRuntimeSimulator";

/**
 * Procedural Vector Icon Drawer for 128x160 TFT Screen
 */
function drawVectorIcon(
  ctx: CanvasRenderingContext2D,
  iconId: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const cx = x + w / 2;
  const cy = y + h / 2;
  const s = Math.min(w, h) * 0.4;

  switch (iconId) {
    case 1: // Heart
      ctx.beginPath();
      ctx.moveTo(cx, cy + s * 0.7);
      ctx.bezierCurveTo(cx - s, cy, cx - s, cy - s * 0.7, cx, cy - s * 0.3);
      ctx.bezierCurveTo(cx + s, cy - s * 0.7, cx + s, cy, cx, cy + s * 0.7);
      ctx.fill();
      break;

    case 2: // Water droplet
      ctx.beginPath();
      ctx.moveTo(cx, cy - s);
      ctx.quadraticCurveTo(cx - s * 0.8, cy + s * 0.2, cx, cy + s * 0.8);
      ctx.quadraticCurveTo(cx + s * 0.8, cy + s * 0.2, cx, cy - s);
      ctx.fill();
      break;

    case 3: // Clock
      ctx.beginPath();
      ctx.arc(cx, cy, s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - s * 0.6);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + s * 0.5, cy);
      ctx.stroke();
      break;

    case 4: // Lightning / Zap
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.1, cy - s);
      ctx.lineTo(cx - s * 0.7, cy + s * 0.1);
      ctx.lineTo(cx - s * 0.05, cy + s * 0.1);
      ctx.lineTo(cx - s * 0.2, cy + s);
      ctx.lineTo(cx + s * 0.7, cy - s * 0.1);
      ctx.lineTo(cx + s * 0.05, cy - s * 0.1);
      ctx.closePath();
      ctx.fill();
      break;

    case 5: // Bell
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.2, s * 0.6, Math.PI, 0);
      ctx.lineTo(cx + s * 0.8, cy + s * 0.5);
      ctx.lineTo(cx - s * 0.8, cy + s * 0.5);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy + s * 0.7, s * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;

    case 6: // Flame
      ctx.beginPath();
      ctx.moveTo(cx, cy + s);
      ctx.bezierCurveTo(cx - s, cy + s * 0.5, cx - s * 0.5, cy - s * 0.4, cx, cy - s);
      ctx.bezierCurveTo(cx + s * 0.2, cy - s * 0.4, cx + s * 0.6, cy - s * 0.2, cx + s * 0.2, cy + s * 0.3);
      ctx.bezierCurveTo(cx + s * 0.8, cy + s * 0.2, cx + s * 0.6, cy + s * 0.8, cx, cy + s);
      ctx.fill();
      break;

    case 7: // Checkmark
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.7, cy);
      ctx.lineTo(cx - s * 0.1, cy + s * 0.6);
      ctx.lineTo(cx + s * 0.8, cy - s * 0.6);
      ctx.stroke();
      break;

    default: // Petbot Default Badge
      ctx.beginPath();
      ctx.roundRect(cx - s, cy - s * 0.8, s * 2, s * 1.6, [s * 0.4]);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx - s * 0.4, cy, s * 0.25, 0, Math.PI * 2);
      ctx.arc(cx + s * 0.4, cy, s * 0.25, 0, Math.PI * 2);
      ctx.fill();
      break;
  }

  ctx.restore();
}
