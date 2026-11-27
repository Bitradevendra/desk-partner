import React, { useState } from "react";
import { usePetBotStore } from "../../store/usePetBotStore.js";
import { robotConnection } from "../../services/robot-connection.js";
import { webAudioSynth } from "../../services/web-audio-synth.js";
import {
  Wifi,
  Bluetooth,
  CheckCircle2,
  X,
  Eye,
  EyeOff,
  Server,
  Loader2,
} from "lucide-react";

export const RobotProvisionModal: React.FC = () => {
  const {
    isProvisionModalOpen,
    setProvisionModalOpen,
    wifiProvisionConfig,
    provisionRobotWifi,
    connectBle,
    connectToHost,
    connectionState,
  } = usePetBotStore();

  const [ssid, setSsid] = useState(wifiProvisionConfig.ssid);
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [harnessHost, setHarnessHost] = useState(wifiProvisionConfig.harnessHost);
  const [harnessPort, setHarnessPort] = useState(String(wifiProvisionConfig.harnessPort));
  const [showAdvancedHost, setShowAdvancedHost] = useState(false);
  const [stage, setStage] = useState<"IDLE" | "SENDING" | "DONE">("IDLE");
  const [connectStatus, setConnectStatus] = useState<string | null>(null);

  if (!isProvisionModalOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ssid.trim()) return;

    setStage("SENDING");
    setConnectStatus(null);
    webAudioSynth.play("CHIRP");

    const ok = await provisionRobotWifi(
      ssid.trim(),
      password,
      harnessHost.trim() || "petbot.local",
      parseInt(harnessPort, 10) || 8443
    );

    if (ok) {
      setStage("DONE");
      webAudioSynth.play("SUCCESS");
    } else {
      setStage("IDLE");
      setConnectStatus(
        "Not connected to Lobo. Connect via Scan BLE or Connect Host first."
      );
      webAudioSynth.play("WARNING");
    }
  };

  const handlePairBle = async () => {
    webAudioSynth.play("TICK");
    setConnectStatus("Scanning nearby Bluetooth devices...");
    const ok = await connectBle();
    if (ok || usePetBotStore.getState().connectionState === "AGENTIC_ONLINE") {
      webAudioSynth.play("SUCCESS");
      setConnectStatus("Connected to Lobo over Bluetooth LE.");
    } else {
      webAudioSynth.play("WARNING");
      setConnectStatus(
        robotConnection.getLastConnectionError() ||
          "No nearby Lobo responded. Power on Lobo and enable Bluetooth."
      );
    }
  };

  const handleDirectConnect = async () => {
    webAudioSynth.play("TICK");
    const host = harnessHost.trim() || "petbot.local";
    const port = parseInt(harnessPort, 10) || 8443;
    setConnectStatus(`Connecting to ${host}:${port}...`);
    const ok = await connectToHost(host, port);
    setConnectStatus(
      ok
        ? `Connected to ${host}:${port}`
        : `No response at ${host}:${port}. Check Wi-Fi and robot power.`
    );
  };

  const handleClose = () => {
    setStage("IDLE");
    setConnectStatus(null);
    setProvisionModalOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="relative w-full max-w-md max-h-[90dvh] overflow-y-auto p-6 bg-white border border-zinc-200 rounded-2xl shadow-lg space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-lg bg-zinc-100 text-zinc-900">
              <Wifi className="w-5 h-5" strokeWidth={1.75} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-950">Wi-Fi &amp; Connection</h2>
              <p className="text-xs text-zinc-500">Connect directly or configure Lobo&apos;s Wi-Fi</p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleClose}
            className="p-2 rounded-lg text-zinc-500 hover:text-zinc-950 hover:bg-zinc-100"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Direct Bluetooth & LAN Host Connect */}
        <div className="p-3.5 rounded-xl bg-zinc-50 border border-zinc-200 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center space-x-2">
              <Bluetooth className="w-4 h-4 text-zinc-800" strokeWidth={1.75} />
              <div>
                <div className="text-xs font-semibold text-zinc-950">Direct Pair</div>
                <div className="text-[11px] font-mono text-zinc-500">{connectionState}</div>
              </div>
            </div>
            <div className="flex items-center space-x-1.5">
              <button
                type="button"
                onClick={() => void handleDirectConnect()}
                className="px-3 py-1.5 rounded-lg bg-white hover:bg-zinc-100 border border-zinc-300 text-xs font-medium text-zinc-900"
              >
                Connect Host
              </button>
              <button
                type="button"
                onClick={() => void handlePairBle()}
                className="px-3 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-xs font-medium text-white"
              >
                Scan BLE
              </button>
            </div>
          </div>
          {connectStatus && (
            <div className="text-xs text-zinc-700 font-mono bg-white px-2.5 py-1.5 rounded border border-zinc-200">
              {connectStatus}
            </div>
          )}
        </div>

        {stage === "DONE" ? (
          <div className="flex flex-col items-center justify-center p-6 rounded-xl bg-zinc-50 border border-zinc-200 text-center space-y-3">
            <CheckCircle2 className="w-9 h-9 text-emerald-600" strokeWidth={1.75} />
            <div className="space-y-1">
              <div className="text-sm font-semibold text-zinc-950">Wi-Fi Settings Sent</div>
              <p className="text-xs text-zinc-600">
                Lobo saved <span className="font-mono font-semibold text-zinc-950">{ssid}</span> and
                is connecting to that Wi-Fi network.
              </p>
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="px-6 py-2.5 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-semibold"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-700">
                2.4 GHz Wi-Fi Network Name (SSID)
              </label>
              <input
                type="text"
                value={ssid}
                onChange={(e) => setSsid(e.target.value)}
                required
                placeholder="lobo"
                className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-50 border border-zinc-300 focus:border-zinc-950 text-sm text-zinc-950 outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-700">Wi-Fi Password</label>
              <div className="relative">
                <input
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password (leave blank for open)"
                  className="w-full px-3.5 py-2.5 pr-10 rounded-xl bg-zinc-50 border border-zinc-300 focus:border-zinc-950 text-sm text-zinc-950 outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-3 text-zinc-500 hover:text-zinc-950"
                  title={showPass ? "Hide Password" : "Show Password"}
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowAdvancedHost(!showAdvancedHost)}
                className="text-[11px] font-medium text-zinc-500 hover:text-zinc-950"
              >
                {showAdvancedHost ? "Hide Advanced Host" : "Advanced Desktop/WS Host"}
              </button>
              {showAdvancedHost && (
                <div className="grid grid-cols-3 gap-3 mt-2">
                  <div className="col-span-2 space-y-1.5">
                    <label className="flex items-center space-x-1 text-xs font-medium text-zinc-700">
                      <Server className="w-3.5 h-3.5 text-zinc-600" />
                      <span>Robot / Host Address</span>
                    </label>
                    <input
                      type="text"
                      value={harnessHost}
                      onChange={(e) => setHarnessHost(e.target.value)}
                      placeholder="petbot.local"
                      className="w-full px-3 py-2.5 rounded-xl bg-zinc-50 border border-zinc-300 focus:border-zinc-950 text-xs font-mono text-zinc-950 outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-700">Port</label>
                    <input
                      type="number"
                      value={harnessPort}
                      onChange={(e) => setHarnessPort(e.target.value)}
                      placeholder="8443"
                      className="w-full px-3 py-2.5 rounded-xl bg-zinc-50 border border-zinc-300 focus:border-zinc-950 text-xs font-mono text-zinc-950 outline-none"
                    />
                  </div>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={stage === "SENDING"}
              className="w-full flex items-center justify-center space-x-2 py-3 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-semibold transition-colors disabled:opacity-60"
            >
              {stage === "SENDING" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Pushing Wi-Fi to Lobo...</span>
                </>
              ) : (
                <>
                  <Wifi className="w-4 h-4" />
                  <span>Push New Wi-Fi &amp; Connect</span>
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default RobotProvisionModal;
