import {
  DEFAULT_WS_PORT,
  MDNS_SERVICE_NAME,
  FrameType,
  encodeFrame,
  decodeFrame,
  type DecodedFrame,
} from "@petbot/protocol";
import {
  serializeWidgetPacket,
  deserializeWidgetPacket,
  type WidgetPacket,
  type EyeFaceWidget,
} from "@petbot/widget-schema";

export interface CompanionConnectionOptions {
  readonly host: string;
  readonly port?: number;
  readonly onFrameReceived?: (frame: DecodedFrame) => void;
}

export class CompanionClient {
  private readonly host: string;
  private readonly port: number;
  private sequenceCounter = 0;

  constructor(options: CompanionConnectionOptions) {
    this.host = options.host;
    this.port = options.port ?? DEFAULT_WS_PORT;
  }

  public getEndpointUrl(): string {
    return `ws://${this.host}:${this.port}/ws`;
  }

  public getDiscoveryTarget(): string {
    return MDNS_SERVICE_NAME;
  }

  public createFaceUpdateMessage(faceWidget: EyeFaceWidget): Uint8Array {
    const serializedWidget = serializeWidgetPacket(faceWidget);
    const frame = encodeFrame(
      FrameType.WIDGET_DEPLOY,
      serializedWidget,
      ++this.sequenceCounter
    );
    return frame;
  }

  public parseIncomingMessage(buffer: Uint8Array): {
    frame: DecodedFrame;
    widget?: WidgetPacket | undefined;
  } {
    const frame = decodeFrame(buffer);
    let widget: WidgetPacket | undefined;

    if (frame.header.frameType === FrameType.WIDGET_DEPLOY) {
      widget = deserializeWidgetPacket(frame.payload);
    }

    return { frame, widget };
  }
}

// Export UI & Services
export * from "./services/robot-connection.js";
export * from "./services/web-audio-synth.js";
export * from "./services/ai-studio-compiler.js";
export * from "./services/rgb565-image-scaler.js";
export * from "./services/sd-vault-client.js";
export * from "./services/ota-update-client.js";
export * from "./services/automation-studio.js";
export * from "./mobile-harness/index.js";
export {
  usePetBotStore,
  type PetBotStore,
  type NavTab,
  type ChatMessage,
  type StudioState,
  type SubscriptionState,
} from "./store/usePetBotStore.js";
export * from "./store/builtin-widgets.js";
export * from "./components/simulator/RobotTftScreen.js";
export * from "./components/simulator/ExpressionCanvasRenderer.js";
export * from "./components/simulator/WidgetRuntimeSimulator.js";
export * from "./components/simulator/VirtualPetDeviceFrame.js";
export * from "./components/studio/MagicStudioView.js";
export * from "./components/studio/ZeroCodeAutomationBuilder.js";
export * from "./components/vault/SdPocketVaultView.js";
export * from "./components/hub/DeviceHubView.js";
export * from "./components/hub/FirmwareUpdateModal.js";
export * from "./components/voice/VoiceAndProView.js";
export * from "./components/layout/AppShell.js";
export * from "./components/layout/LiveRobotPill.js";
export * from "./components/views/HubView.js";
export * from "./components/views/StudioView.js";
export * from "./components/views/VaultView.js";
export * from "./components/views/VoiceProView.js";
export * from "./components/modals/Touch2FaModal.js";
export { App, default as AppComponent } from "./App.js";
