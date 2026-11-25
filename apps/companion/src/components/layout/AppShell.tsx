import React from "react";
import { usePetBotStore, type NavTab } from "../../store/usePetBotStore.js";
import { LiveRobotPill } from "./LiveRobotPill.js";
import { Touch2FaModal } from "../modals/Touch2FaModal.js";
import { RobotProvisionModal } from "../modals/RobotProvisionModal.js";
import {
  Home,
  Layers,
  Folder,
  Mic,
  Bluetooth,
  Wifi,
} from "lucide-react";

interface AppShellProps {
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const {
    activeTab,
    setActiveTab,
    connectionState,
    connect,
    setProvisionModalOpen,
  } = usePetBotStore();

  const navItems: { id: NavTab; label: string; icon: React.FC<{ className?: string; strokeWidth?: number }> }[] = [
    { id: "HUB", label: "Home", icon: Home },
    { id: "STUDIO", label: "Studio", icon: Layers },
    { id: "VAULT", label: "Files", icon: Folder },
    { id: "PRO", label: "Voice", icon: Mic },
  ];

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-petbot-surface text-petbot-textPrimary">
      {/* Classic White Top Bar */}
      <header className="shrink-0 z-40 w-full bg-white border-b border-zinc-200 pt-[env(safe-area-inset-top)]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          {/* Brand */}
          <button
            type="button"
            onClick={() => setActiveTab("HUB")}
            className="flex items-center space-x-2.5 text-left select-none"
          >
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-950 text-white font-semibold text-sm tracking-tight">
              L
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-zinc-950 tracking-tight">Lobo</div>
              <div className="text-[11px] text-zinc-500">Companion</div>
            </div>
          </button>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center space-x-1 p-1 bg-zinc-100 rounded-lg border border-zinc-200">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors select-none ${
                    isActive
                      ? "bg-white text-zinc-950 shadow-sm border border-zinc-200"
                      : "text-zinc-600 hover:text-zinc-950"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" strokeWidth={1.75} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Actions */}
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() => setProvisionModalOpen(true)}
              className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-white hover:bg-zinc-50 border border-zinc-300 text-xs font-medium text-zinc-900 transition-colors select-none"
              title="Wi-Fi and connection setup"
            >
              <Wifi className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span>Wi-Fi</span>
            </button>

            {connectionState === "SEARCHING" && (
              <button
                type="button"
                onClick={() => void connect(false)}
                className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-xs font-medium text-white transition-colors select-none"
              >
                <Bluetooth className="w-3.5 h-3.5" strokeWidth={1.75} />
                <span className="hidden sm:inline">Pair</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Scrollable Viewport Pane */}
      <div className="flex-1 min-h-0 w-full touch-scroll-pane">
        <div className="w-full px-4 sm:px-6 pt-3">
          <div className="max-w-5xl mx-auto">
            <LiveRobotPill />
          </div>
        </div>

        <main className="w-full px-4 sm:px-6 py-4 pb-8 max-w-5xl mx-auto">
          {children}
        </main>
      </div>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden shrink-0 z-40 bg-white border-t border-zinc-200 px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center justify-around">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`flex flex-col items-center justify-center min-w-[64px] py-1.5 px-3 rounded-lg transition-colors select-none ${
                isActive ? "text-zinc-950 bg-zinc-100 font-semibold" : "text-zinc-500 hover:text-zinc-900"
              }`}
            >
              <Icon className="w-5 h-5 mb-0.5" strokeWidth={isActive ? 2 : 1.65} />
              <span className="text-[11px]">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Modals */}
      <Touch2FaModal />
      <RobotProvisionModal />
    </div>
  );
};
