import React from "react";
import { usePetBotStore } from "../../store/usePetBotStore.js";
import { Battery, BatteryCharging, Hand, RefreshCw, WifiOff } from "lucide-react";

export const LiveRobotPill: React.FC = () => {
  const {
    connectionState,
    telemetry,
    connect,
    disconnect,
    wakeOrPetRobot,
    setProvisionModalOpen,
    devMode,
  } = usePetBotStore();

  const isOnline = connectionState === "AGENTIC_ONLINE";
  const isPairing = connectionState === "BLE_FOUND";
  const isPreview = connectionState === "OFFLINE_SIMULATOR";

  const statusText = isOnline
    ? `Connected${telemetry.pingMs > 0 ? ` · ${telemetry.pingMs}ms` : ""}`
    : isPairing
      ? "Pairing..."
      : isPreview
        ? "Preview"
        : "Not Connected";

  const dotClass = isOnline
    ? "bg-emerald-500"
    : isPairing
      ? "bg-amber-500 animate-pulse"
      : isPreview
        ? "bg-zinc-600"
        : "bg-zinc-300";

  return (
    <div className="flex items-center space-x-2">
      {/* Main Connection Pill */}
      <button
        type="button"
        onClick={() => setProvisionModalOpen(true)}
        className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-white border border-zinc-200 hover:bg-zinc-50 text-xs font-medium text-zinc-900"
        title="Manage Lobo connection"
      >
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <span>{statusText}</span>
        {isOnline || isPreview ? (
          <span className="flex items-center space-x-1 pl-2 border-l border-zinc-200 text-[11px] font-mono text-zinc-600">
            {telemetry.isCharging ? (
              <BatteryCharging className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <Battery className="w-3.5 h-3.5 text-zinc-500" />
            )}
            <span>{telemetry.batteryPct}%</span>
          </span>
        ) : (
          <WifiOff className="w-3.5 h-3.5 text-zinc-400" />
        )}
      </button>

      {/* Retry Scan when disconnected, Wake/Pet when online, Exit when preview */}
      {isOnline ? (
        <button
          type="button"
          onClick={() => void wakeOrPetRobot()}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium transition-colors"
          title="Wake or pet Lobo"
        >
          <Hand className="w-3.5 h-3.5" strokeWidth={1.75} />
          <span className="hidden sm:inline">Wake</span>
        </button>
      ) : isPreview ? (
        <button
          type="button"
          onClick={() => disconnect()}
          className="px-2.5 py-1.5 rounded-full bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 text-[11px] font-medium text-zinc-700"
          title="Exit Preview mode"
        >
          Exit
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void connect(false)}
          className="p-1.5 rounded-full bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-700"
          title="Retry connection"
        >
          <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
      )}

      {/* Optional Preview Toggle only when Dev Mode is enabled */}
      {devMode && connectionState === "SEARCHING" && (
        <button
          type="button"
          onClick={() => void connect(true)}
          className="hidden sm:inline-flex px-2.5 py-1.5 rounded-full bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 text-[11px] font-medium text-zinc-700"
        >
          Preview
        </button>
      )}
    </div>
  );
};

export default LiveRobotPill;
