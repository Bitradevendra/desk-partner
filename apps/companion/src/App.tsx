import React, { useEffect } from "react";
import { AppShell } from "./components/layout/AppShell.js";
import { DeviceHubView } from "./components/hub/DeviceHubView.js";
import { MagicStudioView } from "./components/studio/MagicStudioView.js";
import { SdPocketVaultView } from "./components/vault/SdPocketVaultView.js";
import { VoiceAndProView } from "./components/voice/VoiceAndProView.js";
import { usePetBotStore } from "./store/usePetBotStore.js";

export const App: React.FC = () => {
  const { activeTab, connect } = usePetBotStore();

  useEffect(() => {
    // Attempt connection once on mount; fallback cleanly to simulator if hardware isn't reachable yet
    void connect(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderActiveView = () => {
    switch (activeTab) {
      case "HUB":
        return <DeviceHubView />;
      case "STUDIO":
        return <MagicStudioView />;
      case "VAULT":
        return <SdPocketVaultView />;
      case "PRO":
        return <VoiceAndProView />;
      default:
        return <DeviceHubView />;
    }
  };

  return <AppShell>{renderActiveView()}</AppShell>;
};

export default App;
