import React from "react";
import type { WidgetPackage, UINode } from "@petbot/widget-schema";

interface RobotTftScreenProps {
  widget: WidgetPackage;
  stateSlots: Record<string, string | number | boolean>;
  onScreenTap?: () => void;
  scale?: number;
}

function toCssColor(color: string | number | undefined, fallback = "transparent"): string {
  if (color === undefined) return fallback;
  if (typeof color === "string") return color;
  // Convert 16-bit RGB565 to rgb(r, g, b)
  const r = ((color >> 11) & 0x1f) << 3;
  const g = ((color >> 5) & 0x3f) << 2;
  const b = (color & 0x1f) << 3;
  return `rgb(${r}, ${g}, ${b})`;
}

export const RobotTftScreen: React.FC<RobotTftScreenProps> = ({
  widget,
  stateSlots,
  onScreenTap,
  scale = 2,
}) => {
  // Resolve state template strings like "{{cupsDrank}}"
  const resolveTemplate = (text: string): string => {
    return text.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
      const val = stateSlots[key] ?? widget.state[key]?.initialValue ?? "";
      return String(val);
    });
  };

  const renderNode = (node: UINode, key: string | number): React.ReactNode => {
    const style: React.CSSProperties = {
      position: "absolute",
      left: `${node.x}px`,
      top: `${node.y}px`,
      width: `${node.w}px`,
      height: `${node.h}px`,
      boxSizing: "border-box",
    };

    switch (node.type) {
      case "Container":
        return (
          <div
            key={key}
            style={{
              ...style,
              backgroundColor: toCssColor(node.backgroundColor),
              borderRadius: node.borderRadius ? `${node.borderRadius}px` : undefined,
              borderColor: node.borderColor ? toCssColor(node.borderColor) : undefined,
              borderWidth: node.borderColor ? "1px" : undefined,
              borderStyle: node.borderColor ? "solid" : undefined,
              padding: node.padding ? `${node.padding}px` : undefined,
              overflow: "hidden",
            }}
          >
            {node.children?.map((child, idx) => renderNode(child, `${key}-${idx}`))}
          </div>
        );

      case "Text": {
        const textValue = resolveTemplate(node.text);
        const fontSizes: Record<string, string> = {
          sm: "10px",
          md: "13px",
          lg: "16px",
          xl: "22px",
        };
        return (
          <div
            key={key}
            style={{
              ...style,
              color: toCssColor(node.color, "#FFFFFF"),
              fontSize: fontSizes[node.fontSize] || "12px",
              textAlign: node.align,
              fontWeight: node.fontSize === "xl" ? 700 : 600,
              fontFamily: "'JetBrains Mono', monospace",
              display: "flex",
              alignItems: "center",
              justifyContent:
                node.align === "center"
                  ? "center"
                  : node.align === "right"
                  ? "flex-end"
                  : "flex-start",
              lineHeight: 1.1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {textValue}
          </div>
        );
      }

      case "ProgressBar": {
        const rawVal = stateSlots[node.valueBinding] ?? widget.state[node.valueBinding]?.initialValue ?? 0;
        const numVal = typeof rawVal === "number" ? rawVal : Number(rawVal) || 0;
        const range = node.max - node.min || 1;
        const progressPct = Math.min(100, Math.max(0, ((numVal - node.min) / range) * 100));

        return (
          <div
            key={key}
            style={{
              ...style,
              backgroundColor: toCssColor(node.bgColor, "#232634"),
              borderRadius: "4px",
              overflow: "hidden",
              display: "flex",
            }}
          >
            <div
              style={{
                width: node.orientation === "horizontal" ? `${progressPct}%` : "100%",
                height: node.orientation === "vertical" ? `${progressPct}%` : "100%",
                backgroundColor: toCssColor(node.fgColor, "#00F0FF"),
                transition: "width 0.2s ease-out, height 0.2s ease-out",
                borderRadius: "4px",
              }}
            />
          </div>
        );
      }

      case "PetExpression":
        return (
          <div
            key={key}
            style={{
              ...style,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div className="relative flex items-center justify-center space-x-5">
              {/* Left Cheek Blush */}
              <span
                className="w-2.5 h-1.5 rounded-full opacity-70"
                style={{ backgroundColor: "#FF78A8", position: "absolute", left: "-6px", bottom: "-2px" }}
              />
              {/* Left Eye (Black classic) */}
              <div
                className="w-4 h-6 rounded-full bg-zinc-950 animate-blink"
                style={{
                  transform:
                    node.emotion === "HAPPY"
                      ? "scaleY(0.35)"
                      : node.emotion === "SLEEPY"
                      ? "scaleY(0.25)"
                      : node.emotion === "FOCUSED"
                      ? "scaleY(0.55) rotate(-8deg)"
                      : undefined,
                }}
              />
              {/* Right Eye (Black classic) */}
              <div
                className="w-4 h-6 rounded-full bg-zinc-950 animate-blink"
                style={{
                  transform:
                    node.emotion === "HAPPY"
                      ? "scaleY(0.35)"
                      : node.emotion === "SLEEPY"
                      ? "scaleY(0.25)"
                      : node.emotion === "FOCUSED"
                      ? "scaleY(0.55) rotate(8deg)"
                      : undefined,
                }}
              />
              {/* Right Cheek Blush */}
              <span
                className="w-2.5 h-1.5 rounded-full opacity-70"
                style={{ backgroundColor: "#FF78A8", position: "absolute", right: "-6px", bottom: "-2px" }}
              />
            </div>
            <svg width="16" height="8" viewBox="0 0 16 8" className="mt-1.5">
              <path
                d={node.emotion === "ALERT" ? "M5 4 A3 2.5 0 1 1 11 4 A3 2.5 0 1 1 5 4" : "M3 2 Q8 7 13 2"}
                fill="none"
                stroke="#111111"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
        );

      case "Icon":
        return (
          <div
            key={key}
            style={{
              ...style,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: toCssColor(node.color, "#00F0FF"),
            }}
          >
            <svg
              className="w-full h-full"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
        );

      case "Sparkline":
        return (
          <div
            key={key}
            style={{
              ...style,
              display: "flex",
              alignItems: "flex-end",
              gap: "2px",
              padding: "2px",
            }}
          >
            {[40, 65, 30, 80, 95, 60, 85].map((val, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: `${val}%`,
                  backgroundColor: toCssColor(node.color, "#50FA7B"),
                  borderRadius: "1px",
                }}
              />
            ))}
          </div>
        );

      case "List":
        return (
          <div key={key} style={{ ...style, overflow: "hidden" }}>
            {["Inbox Ready", "Vitals Good", "Wi-Fi Synced"].map((item, idx) => (
              <div
                key={idx}
                style={{
                  height: `${node.rowHeight}px`,
                  fontSize: "11px",
                  color: "#F4F5F8",
                  display: "flex",
                  alignItems: "center",
                  borderBottom: "1px solid #232634",
                }}
              >
                {item}
              </div>
            ))}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div
      onClick={onScreenTap}
      className="relative cursor-pointer select-none overflow-hidden rounded shadow-sm border border-zinc-200 transition-transform active:scale-[0.99]"
      style={{
        width: `${160 * scale}px`,
        height: `${128 * scale}px`,
        backgroundColor: "#FFFFFF",
      }}
      title="160x128 Landscape TFT Screen (Tap to interact)"
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "160px",
          height: "128px",
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {renderNode(widget.ui, "root")}
      </div>
    </div>
  );
};
