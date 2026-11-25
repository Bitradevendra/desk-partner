import React, { useState, useEffect, useRef } from "react";
import {
  Cpu,
  Download,
  AlertCircle,
  X,
  ShieldCheck,
  RefreshCw,
  FileUp,
  Check,
} from "lucide-react";
import {
  otaUpdateClient,
  AVAILABLE_FIRMWARE_RELEASES,
  type OtaUpdateProgress,
} from "../../services/ota-update-client.js";
import { webAudioSynth } from "../../services/web-audio-synth.js";

interface FirmwareUpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentVersion?: string;
  onUpdateCompleted?: (newVersion: string) => void;
}

export const FirmwareUpdateModal: React.FC<FirmwareUpdateModalProps> = ({
  isOpen,
  onClose,
  currentVersion = "v2.0.0",
  onUpdateCompleted,
}) => {
  const [selectedRelease] = useState(AVAILABLE_FIRMWARE_RELEASES[0]!);
  const [progress, setProgress] = useState<OtaUpdateProgress>(otaUpdateClient.getProgress());
  const [customFile, setCustomFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unbind = otaUpdateClient.onProgress((p) => {
      setProgress(p);
      if (p.phase === "COMPLETED") {
        webAudioSynth.play("SUCCESS");
        if (onUpdateCompleted) {
          onUpdateCompleted(p.version || selectedRelease.version);
        }
      } else if (p.phase === "STREAMING" && p.currentChunk % 10 === 0) {
        webAudioSynth.play("TICK");
      }
    });
    return unbind;
  }, [selectedRelease, onUpdateCompleted]);

  if (!isOpen) return null;

  const isUpdating =
    progress.phase === "STARTING" ||
    progress.phase === "STREAMING" ||
    progress.phase === "VERIFYING" ||
    progress.phase === "REBOOTING";

  const isDone = progress.phase === "COMPLETED";
  const isError = progress.phase === "ERROR";

  const handleStartUpdate = async () => {
    webAudioSynth.play("CHIRP");
    try {
      if (customFile) {
        await otaUpdateClient.flashFirmware(customFile);
      } else {
        const dummyBin = new Uint8Array(selectedRelease.sizeBytes);
        for (let i = 0; i < dummyBin.length; i++) {
          dummyBin[i] = (i ^ 0x5a) & 0xff;
        }
        await otaUpdateClient.flashFirmware(dummyBin, selectedRelease.version);
      }
    } catch {
      webAudioSynth.play("WARNING");
    }
  };

  const handleCustomFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCustomFile(file);
      webAudioSynth.play("TICK");
    }
  };

  const handleClose = () => {
    if (isUpdating) {
      if (confirm("Firmware update is in progress. Cancel update?")) {
        otaUpdateClient.cancelUpdate();
        onClose();
      }
    } else {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="relative w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-2xl bg-white border border-zinc-200 shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200">
          <div className="flex items-center space-x-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-100 text-zinc-900">
              <Cpu className="w-5 h-5" strokeWidth={1.75} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-950">Device Firmware</h2>
              <p className="text-xs text-zinc-500">Dual-partition rollback protection</p>
            </div>
          </div>

          {!isUpdating && (
            <button
              type="button"
              onClick={handleClose}
              className="p-2 rounded-lg text-zinc-500 hover:text-zinc-950 hover:bg-zinc-100"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {!isUpdating && !isDone && !isError && (
            <div className="space-y-5">
              <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200 space-y-2.5">
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-[11px] font-medium text-zinc-600">
                      Current: <strong className="text-zinc-950">{currentVersion}</strong>
                    </span>
                    <h3 className="text-base font-semibold text-zinc-950 mt-0.5">
                      {selectedRelease.version} — {selectedRelease.releaseName}
                    </h3>
                  </div>
                  <span className="text-xs font-mono text-zinc-500">
                    {(selectedRelease.sizeBytes / (1024 * 1024)).toFixed(2)} MB
                  </span>
                </div>

                <p className="text-xs text-zinc-600 leading-relaxed">
                  {selectedRelease.description}
                </p>

                <div className="pt-2 border-t border-zinc-200 space-y-1.5">
                  {selectedRelease.features.map((feat, idx) => (
                    <div key={idx} className="flex items-center space-x-2 text-xs text-zinc-700">
                      <Check className="w-3.5 h-3.5 text-zinc-900 shrink-0" />
                      <span>{feat}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center space-x-2.5 p-3 rounded-xl bg-zinc-50 border border-zinc-200 text-xs text-zinc-700">
                <ShieldCheck className="w-4 h-4 text-zinc-900 shrink-0" />
                <span>Signed with Ed25519 &amp; SHA-256 verification before reboot.</span>
              </div>

              <div>
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".pbota,.bin"
                  onChange={handleCustomFileSelect}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center space-x-2 text-xs text-zinc-600 hover:text-zinc-950"
                >
                  <FileUp className="w-3.5 h-3.5" />
                  <span>
                    {customFile
                      ? `Loaded: ${customFile.name} (${(customFile.size / 1024).toFixed(0)} KB)`
                      : "Choose a custom .pbota or .bin file"}
                  </span>
                </button>
              </div>

              <div className="flex items-center justify-end space-x-2.5 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-xl border border-zinc-300 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleStartUpdate()}
                  className="flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-semibold"
                >
                  <Download className="w-4 h-4" />
                  <span>Install Update</span>
                </button>
              </div>
            </div>
          )}

          {isUpdating && (
            <div className="py-5 space-y-5 text-center">
              <div className="mx-auto w-14 h-14 rounded-2xl bg-zinc-100 flex items-center justify-center">
                <RefreshCw className="w-7 h-7 text-zinc-950 animate-spin" />
              </div>

              <div>
                <h3 className="text-lg font-semibold text-zinc-950">Updating Firmware...</h3>
                <p className="text-xs text-zinc-500 mt-1">
                  {progress.phase === "STARTING" && "Initializing flash partition..."}
                  {progress.phase === "STREAMING" &&
                    `Transferring chunk ${progress.currentChunk} of ${progress.totalChunks}`}
                  {progress.phase === "VERIFYING" && "Verifying checksum..."}
                  {progress.phase === "REBOOTING" && "Rebooting device..."}
                </p>
              </div>

              <div className="space-y-1.5 text-left">
                <div className="flex justify-between text-xs font-mono">
                  <span className="font-semibold text-zinc-950">{progress.progressPct}%</span>
                  <span className="text-zinc-500">
                    {progress.speedKBps > 0 ? `${progress.speedKBps} KB/s` : "Preparing"}
                  </span>
                </div>
                <div className="w-full h-2.5 bg-zinc-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-zinc-950 transition-all duration-300 rounded-full"
                    style={{ width: `${progress.progressPct}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {isDone && (
            <div className="py-5 space-y-5 text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-zinc-100 flex items-center justify-center">
                <Check className="w-7 h-7 text-zinc-950" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-zinc-950">Firmware Updated</h3>
                <p className="text-xs text-zinc-600 mt-1">
                  Running {progress.version || selectedRelease.version}. Your widgets and settings are intact.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="w-full py-2.5 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-semibold"
              >
                Done
              </button>
            </div>
          )}

          {isError && (
            <div className="py-5 space-y-5 text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-red-50 flex items-center justify-center">
                <AlertCircle className="w-7 h-7 text-red-700" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-zinc-950">Update Interrupted</h3>
                <p className="text-xs text-red-700 mt-1">
                  {progress.errorDetail || "Connection error during update."}
                </p>
              </div>
              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 py-2.5 rounded-xl border border-zinc-300 text-xs font-medium text-zinc-700"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => void handleStartUpdate()}
                  className="flex-1 py-2.5 rounded-xl bg-zinc-950 text-white text-xs font-semibold"
                >
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
