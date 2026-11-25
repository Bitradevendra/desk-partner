import React, { useState, useRef } from "react";
import { usePetBotStore } from "../../store/usePetBotStore.js";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FileCode2,
  FileText,
  Folder,
  HardDrive,
  Image as ImageIcon,
  Monitor,
  Music,
  RefreshCw,
  Search,
  Smartphone,
  Trash2,
  Upload,
  WifiOff,
  Check,
  AlertCircle,
} from "lucide-react";
import type { VaultFileItem, VaultFileType } from "../../services/sd-vault-client.js";
import { sdVaultClient } from "../../services/sd-vault-client.js";
import { webAudioSynth } from "../../services/web-audio-synth.js";

type CategoryFilter = "ALL" | "IMAGES" | "AUDIO" | "DOCS" | "CODE" | "ARCHIVES";

interface FolderGroup {
  key: CategoryFilter;
  path: string;
  label: string;
  types: VaultFileType[];
}

const FOLDER_GROUPS: FolderGroup[] = [
  { key: "IMAGES", path: "/sdcard/images", label: "Images & Wallpapers", types: ["image"] },
  { key: "AUDIO", path: "/sdcard/audio", label: "Audio & Voice", types: ["audio"] },
  { key: "DOCS", path: "/sdcard/docs", label: "Documents & Notes", types: ["document"] },
  { key: "CODE", path: "/sdcard/widgets", label: "Widgets & Firmware", types: ["code"] },
  { key: "ARCHIVES", path: "/sdcard/archives", label: "Archives & Backups", types: ["archive", "other"] },
];

export const SdPocketVaultView: React.FC = () => {
  const {
    connectionState,
    setProvisionModalOpen,
    vaultFiles,
    telemetry,
    isRefreshingVault,
    refreshVault,
    uploadFileToVault,
    deleteVaultFile,
    syncMobilePocketVault,
  } = usePetBotStore();

  const [filter, setFilter] = useState<CategoryFilter>("ALL");
  const [groupByFolder, setGroupByFolder] = useState(true);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError?: boolean } | null>(
    null
  );
  const [isSyncingMobile, setIsSyncingMobile] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const isHardwareConnected = connectionState === "AGENTIC_ONLINE";
  const isPreviewMode = connectionState === "OFFLINE_SIMULATOR";
  const canTransfer = isHardwareConnected || isPreviewMode;

  const showStatus = (text: string, isError = false) => {
    setStatusMessage({ text, isError });
    setTimeout(() => setStatusMessage(null), 2600);
  };

  const formatBytes = (bytes: number): string => {
    if (bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const getCategoryForType = (type: VaultFileType): CategoryFilter => {
    if (type === "image") return "IMAGES";
    if (type === "audio") return "AUDIO";
    if (type === "document") return "DOCS";
    if (type === "code") return "CODE";
    return "ARCHIVES";
  };

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!canTransfer) {
      webAudioSynth.play("WARNING");
      showStatus("Not connected to Lobo — pair device first", true);
      setProvisionModalOpen(true);
      return;
    }

    let uploadedCount = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files.item(i);
      if (!f) continue;
      const ok = await uploadFileToVault(f);
      if (ok) {
        await sdVaultClient.sendFileToRobotVault(f);
        uploadedCount++;
      }
    }

    if (uploadedCount > 0) {
      webAudioSynth.play("SUCCESS");
      showStatus(`Uploaded ${uploadedCount} file(s) to MicroSD`);
    }
  };

  const handleRefresh = async () => {
    webAudioSynth.play("TICK");
    const ok = await refreshVault();
    if (!ok) {
      showStatus("Connect Lobo over Wi-Fi or Bluetooth to read MicroSD", true);
    }
  };

  const handleSyncPhoneInbox = async () => {
    if (!canTransfer) {
      webAudioSynth.play("WARNING");
      showStatus("Not connected — connect Lobo before importing", true);
      setProvisionModalOpen(true);
      return;
    }
    setIsSyncingMobile(true);
    webAudioSynth.play("CHIRP");
    try {
      const count = await syncMobilePocketVault();
      showStatus(count > 0 ? `Imported ${count} file(s) from phone` : "No pending phone files");
    } finally {
      setIsSyncingMobile(false);
    }
  };

  const handleShowOnScreen = async (item: VaultFileItem) => {
    if (!canTransfer) {
      webAudioSynth.play("WARNING");
      showStatus("Not connected to Lobo", true);
      return;
    }
    webAudioSynth.play("CHIRP");
    const ok = await sdVaultClient.displayImageOnRobot(item.id);
    showStatus(ok ? `Displayed ${item.name} on Lobo` : `Queued ${item.name} for display`);
  };

  const handleDownload = async (item: VaultFileItem) => {
    if (!canTransfer) {
      webAudioSynth.play("WARNING");
      showStatus("Not connected to Lobo", true);
      return;
    }
    webAudioSynth.play("TICK");
    try {
      await sdVaultClient.collectFileFromRobotVault(item.id);
      showStatus(`Saved ${item.name} to device`);
    } catch {
      const dummy = new Uint8Array(Math.min(item.sizeBytes, 4096));
      const blob = new Blob([dummy], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = item.name;
      a.click();
      URL.revokeObjectURL(url);
      showStatus(`Saved ${item.name}`);
    }
  };

  const handleDelete = async (item: VaultFileItem) => {
    await sdVaultClient.deleteFile(item.id);
    deleteVaultFile(item.id);
    showStatus(`Removed ${item.name}`);
  };

  const getFileIcon = (type: VaultFileType) => {
    switch (type) {
      case "image":
        return <ImageIcon className="w-4 h-4 text-zinc-700" strokeWidth={1.75} />;
      case "audio":
        return <Music className="w-4 h-4 text-zinc-700" strokeWidth={1.75} />;
      case "document":
        return <FileText className="w-4 h-4 text-zinc-700" strokeWidth={1.75} />;
      case "code":
        return <FileCode2 className="w-4 h-4 text-zinc-700" strokeWidth={1.75} />;
      case "archive":
        return <Archive className="w-4 h-4 text-zinc-700" strokeWidth={1.75} />;
      default:
        return <File className="w-4 h-4 text-zinc-600" strokeWidth={1.75} />;
    }
  };

  const visibleFiles = vaultFiles.filter((f) => {
    const matchesSearch =
      !searchQuery.trim() || f.name.toLowerCase().includes(searchQuery.trim().toLowerCase());
    if (!matchesSearch) return false;
    if (filter === "ALL") return true;
    return getCategoryForType(f.type) === filter;
  });

  const usedPct =
    telemetry.sdTotalBytes > 0
      ? Math.min(100, Math.round((telemetry.sdUsedBytes / telemetry.sdTotalBytes) * 100))
      : 0;

  const renderFileRow = (file: VaultFileItem) => (
    <div
      key={file.id}
      className="flex items-center justify-between gap-2.5 px-3 py-2 bg-white hover:bg-zinc-50 border-b border-zinc-100 last:border-b-0 transition-colors"
    >
      <div className="flex items-center space-x-2.5 min-w-0 flex-1">
        {file.thumbnailDataUrl ? (
          <img
            src={file.thumbnailDataUrl}
            alt={file.name}
            className="w-8 h-8 rounded object-cover border border-zinc-200 shrink-0"
          />
        ) : (
          <div className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0">
            {getFileIcon(file.type)}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-950 truncate">{file.name}</div>
          {file.isTransferring ? (
            <div className="flex items-center space-x-2 mt-0.5">
              <div className="w-24 h-1 bg-zinc-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-zinc-950"
                  style={{ width: `${file.transferProgress ?? 0}%` }}
                />
              </div>
              <span className="text-[10px] font-mono text-zinc-500">
                {file.transferProgress ?? 0}%
              </span>
            </div>
          ) : (
            <div className="text-[10px] font-mono text-zinc-500 truncate">
              {formatBytes(file.sizeBytes)} · {file.type}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center space-x-1 shrink-0">
        {file.type === "image" && (
          <button
            type="button"
            onClick={() => void handleShowOnScreen(file)}
            className="p-1.5 rounded-lg hover:bg-zinc-200 text-zinc-700"
            title="Show on Lobo screen"
          >
            <Monitor className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleDownload(file)}
          className="p-1.5 rounded-lg hover:bg-zinc-200 text-zinc-700"
          title="Save to phone"
        >
          <Download className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void handleDelete(file)}
          className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-600"
          title="Delete file"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="flex flex-col space-y-3"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        void handleFilesSelected(e.dataTransfer.files);
      }}
    >
      {statusMessage && (
        <div className="fixed bottom-20 md:bottom-6 right-4 sm:right-6 z-50 flex items-center space-x-2 px-3.5 py-2 rounded-xl bg-zinc-950 text-white text-xs font-medium shadow-lg">
          {statusMessage.isError ? (
            <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          ) : (
            <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          )}
          <span>{statusMessage.text}</span>
        </div>
      )}

      {/* Compact File Manager Top Bar */}
      <div
        className={`bg-white border rounded-2xl p-3.5 space-y-2.5 transition-colors ${
          isDragging ? "border-zinc-950 bg-zinc-50" : "border-zinc-200"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center space-x-2">
            <HardDrive className="w-4 h-4 text-zinc-800" strokeWidth={1.75} />
            <h2 className="text-sm font-semibold text-zinc-950">MicroSD File Manager</h2>
            <span className="text-[11px] font-mono text-zinc-500">
              {canTransfer && telemetry.sdTotalBytes > 0
                ? `${formatBytes(telemetry.sdUsedBytes)} / ${formatBytes(telemetry.sdTotalBytes)}`
                : isHardwareConnected
                  ? "Mounted"
                  : isPreviewMode
                    ? "Preview Storage"
                    : "Disconnected"}
            </span>
          </div>

          <div className="flex items-center space-x-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void handleFilesSelected(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Upload</span>
            </button>
            <button
              type="button"
              onClick={() => void handleSyncPhoneInbox()}
              disabled={isSyncingMobile}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-800 text-xs font-medium disabled:opacity-50"
              title="Import staged phone shares"
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Import</span>
            </button>
            <button
              type="button"
              onClick={() => setShowSearch(!showSearch)}
              className={`p-1.5 rounded-lg border text-zinc-700 ${
                showSearch ? "bg-zinc-950 text-white border-zinc-950" : "bg-white border-zinc-200"
              }`}
              title="Filter by filename"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={isRefreshingVault}
              className="p-1.5 rounded-lg bg-white hover:bg-zinc-100 border border-zinc-200 text-zinc-700"
              title="Refresh MicroSD directory"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingVault ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Thin Storage Bar (only active when real capacity is reported) */}
        <div className="w-full h-1 bg-zinc-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-zinc-950 transition-all"
            style={{ width: `${canTransfer ? usedPct : 0}%` }}
          />
        </div>

        {/* Category Tabs + Folder Grouping Toggle */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                { id: "ALL", label: "All", count: vaultFiles.length },
                ...FOLDER_GROUPS.map((g) => ({
                  id: g.key,
                  label: g.key === "CODE" ? "Widgets" : g.key.charAt(0) + g.key.slice(1).toLowerCase(),
                  count: vaultFiles.filter((f) => g.types.includes(f.type)).length,
                })),
              ] as { id: CategoryFilter; label: string; count: number }[]
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                  filter === tab.id
                    ? "bg-zinc-950 text-white"
                    : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
                }`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </div>

          {filter === "ALL" && (
            <button
              type="button"
              onClick={() => setGroupByFolder(!groupByFolder)}
              className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium ${
                groupByFolder
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-white text-zinc-700 border-zinc-200"
              }`}
            >
              Folders: {groupByFolder ? "On" : "Flat"}
            </button>
          )}
        </div>

        {showSearch && (
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter files by name..."
            className="w-full px-3 py-1.5 rounded-lg bg-zinc-50 border border-zinc-300 focus:border-zinc-950 text-xs text-zinc-950 outline-none"
          />
        )}
      </div>

      {/* File Browser List / Segregated Folders */}
      {!canTransfer && vaultFiles.length === 0 ? (
        <div className="bg-white border border-zinc-200 rounded-2xl p-4 flex items-center justify-between gap-3">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0">
              <WifiOff className="w-4 h-4 text-zinc-500" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-zinc-950">Lobo Not Connected</div>
              <div className="text-[11px] text-zinc-500">
                Pair Lobo over Wi-Fi or Bluetooth to browse or transfer MicroSD files.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setProvisionModalOpen(true)}
            className="px-3 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium shrink-0"
          >
            Connect
          </button>
        </div>
      ) : visibleFiles.length === 0 ? (
        <div className="bg-white border border-zinc-200 rounded-2xl p-4 text-center text-xs text-zinc-500">
          No files in this folder yet. Tap Upload to send a file to Lobo.
        </div>
      ) : filter === "ALL" && groupByFolder ? (
        <div className="space-y-2">
          {FOLDER_GROUPS.map((group) => {
            const items = visibleFiles.filter((f) => group.types.includes(f.type));
            if (items.length === 0) return null;
            const isCollapsed = !!collapsedFolders[group.key];
            return (
              <div
                key={group.key}
                className="bg-white border border-zinc-200 rounded-xl overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() =>
                    setCollapsedFolders((prev) => ({
                      ...prev,
                      [group.key]: !prev[group.key],
                    }))
                  }
                  className="w-full flex items-center justify-between px-3 py-2 bg-zinc-50 border-b border-zinc-200 text-left"
                >
                  <div className="flex items-center space-x-2">
                    {isCollapsed ? (
                      <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
                    )}
                    <Folder className="w-3.5 h-3.5 text-zinc-700" strokeWidth={1.75} />
                    <span className="text-xs font-semibold text-zinc-950">{group.path}</span>
                    <span className="text-[11px] text-zinc-500">· {group.label}</span>
                  </div>
                  <span className="text-[11px] font-mono text-zinc-500">{items.length}</span>
                </button>
                {!isCollapsed && <div>{items.map(renderFileRow)}</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden">
          {visibleFiles.map(renderFileRow)}
        </div>
      )}
    </div>
  );
};

export default SdPocketVaultView;
