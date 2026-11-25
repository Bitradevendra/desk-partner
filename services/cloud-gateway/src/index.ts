import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import {
  DEFAULT_WS_PORT,
  AUDIO_FRAME_BYTES,
  AUDIO_SAMPLES_PER_FRAME,
  AUDIO_SAMPLE_RATE_HZ,
  AUDIO_FRAME_DURATION_MS,
  AUDIO_DOWNLINK_HEADER_SIZE,
  AUDIO_UPLINK_HEADER_SIZE,
  FrameType,
  EmotionId,
  RiskTier,
  decodeFrame,
  encodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  encodeAudioUplinkFrame,
  decodeAudioUplinkFrame,
  encodeAudioDownlinkFrame,
  decodeAudioDownlinkFrame,
  SubscriptionEntitlementSyncSchema,
  FrameStreamParser,
  type DecodedFrame,
  type SubscriptionEntitlementSync,
} from "@petbot/protocol";
import {
  deserializeWidgetPacket,
  serializeWidgetPacket,
  type WidgetPacket,
} from "@petbot/widget-schema";
import {
  EntitlementEngine,
  TIER_CAPABILITIES,
  type SubscriptionTier,
  type TierCapabilities,
  type UserAccount,
  type PairedDevice,
  type MintedEntitlements,
  type EntitlementEngineOptions,
} from "./auth/entitlement-engine.js";
import {
  subscriptionRoutes,
  type SubscriptionRoutesOptions,
} from "./routes/subscription-routes.js";
import {
  AudioVisemePipeline,
  UplinkAudioBuffer,
  parseInlineEmotionTags,
  chunkPcmToSyncedDownlinkFrames,
  proceduralFormantSynthesize,
  createWavBuffer,
  EMOTION_GAZE_PRESETS,
  type SpokenEmotionSegment,
  type SyncedAudioDownlinkFrame,
  type CompletedUtterance,
  type UplinkAudioBufferOptions,
  type ChunkPcmDownlinkOptions,
  type ProceduralFormantOptions,
  type PipelineProcessingOptions,
  type TtsSynthesizeCallback,
} from "./voice/audio-viseme-pipeline.js";
import {
  AgenticVoiceBrain,
  PET_PERSONA_PROFILES,
  AGENTIC_TOOL_DEFINITIONS,
  parseEmotionFromTag,
  type PetPersonaId,
  type PersonaProfile,
  type AgenticToolCall,
  type ToolCallExecutionResult,
  type BrainVoiceTurnResult,
  type AgenticVoiceBrainOptions,
  type RobotHabitSnapshot,
  type RobotNoteSnapshot,
  type AutomationSnapshot,
  type RobotEcosystemState,
} from "./voice/agentic-voice-brain.js";
import {
  VoiceGatewayManager,
  registerVoiceGatewayWebSocket,
  type VoiceGatewayWsOptions,
  type VoiceSessionState,
  type SttTranscriberFn,
  type TtsSynthesizerFn,
} from "./voice/voice-gateway-ws.js";
import {
  PartnerOrchestrator,
  type PartnerIntentType,
  type PartnerVoiceTurnResult,
  type PartnerOrchestratorOptions,
  type PartnerExecutionRecord,
} from "./voice/partner-orchestrator.js";
import {
  ZeroCodeCompilerService,
  type GenerateWidgetParams,
  type GenerateWidgetResult,
  type StudioTemplate,
  type LinkedDesktopWorkflow,
  type LinkedDesktopWorkflowStep,
} from "./studio/zero-code-compiler-service.js";
import {
  studioRoutes,
  type StudioRoutesOptions,
  type StudioGenerateRequest,
} from "./routes/studio-routes.js";

export const DEFAULT_GATEWAY_PORT = 8787;

// Export all auth, entitlement, audio DSP, protocol, and studio compiler primitives
export {
  EntitlementEngine,
  TIER_CAPABILITIES,
  subscriptionRoutes,
  ZeroCodeCompilerService,
  studioRoutes,
  AudioVisemePipeline,
  UplinkAudioBuffer,
  parseInlineEmotionTags,
  chunkPcmToSyncedDownlinkFrames,
  proceduralFormantSynthesize,
  createWavBuffer,
  EMOTION_GAZE_PRESETS,
  AgenticVoiceBrain,
  PET_PERSONA_PROFILES,
  AGENTIC_TOOL_DEFINITIONS,
  parseEmotionFromTag,
  VoiceGatewayManager,
  registerVoiceGatewayWebSocket,
  PartnerOrchestrator,
  type PartnerIntentType,
  type PartnerVoiceTurnResult,
  type PartnerOrchestratorOptions,
  type PartnerExecutionRecord,
  AUDIO_FRAME_BYTES,
  AUDIO_SAMPLES_PER_FRAME,
  AUDIO_SAMPLE_RATE_HZ,
  AUDIO_FRAME_DURATION_MS,
  AUDIO_DOWNLINK_HEADER_SIZE,
  AUDIO_UPLINK_HEADER_SIZE,
  FrameType,
  EmotionId,
  RiskTier,
  decodeFrame,
  encodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  encodeAudioUplinkFrame,
  decodeAudioUplinkFrame,
  encodeAudioDownlinkFrame,
  decodeAudioDownlinkFrame,
  SubscriptionEntitlementSyncSchema,
  FrameStreamParser,
  deserializeWidgetPacket,
  serializeWidgetPacket,
  type DecodedFrame,
  type SubscriptionEntitlementSync,
  type WidgetPacket,
  type SubscriptionTier,
  type TierCapabilities,
  type UserAccount,
  type PairedDevice,
  type MintedEntitlements,
  type EntitlementEngineOptions,
  type SubscriptionRoutesOptions,
  type StudioRoutesOptions,
  type StudioGenerateRequest,
  type GenerateWidgetParams,
  type GenerateWidgetResult,
  type StudioTemplate,
  type LinkedDesktopWorkflow,
  type LinkedDesktopWorkflowStep,
  type SpokenEmotionSegment,
  type SyncedAudioDownlinkFrame,
  type CompletedUtterance,
  type UplinkAudioBufferOptions,
  type ChunkPcmDownlinkOptions,
  type ProceduralFormantOptions,
  type PipelineProcessingOptions,
  type TtsSynthesizeCallback,
  type PetPersonaId,
  type PersonaProfile,
  type AgenticToolCall,
  type ToolCallExecutionResult,
  type BrainVoiceTurnResult,
  type AgenticVoiceBrainOptions,
  type RobotHabitSnapshot,
  type RobotNoteSnapshot,
  type AutomationSnapshot,
  type RobotEcosystemState,
  type VoiceGatewayWsOptions,
  type VoiceSessionState,
  type SttTranscriberFn,
  type TtsSynthesizerFn,
};

// ============================================================================
// Device Session & Gateway Router
// ============================================================================

export interface DeviceSession {
  readonly deviceId: string;
  readonly connectedAt: Date;
  lastSequenceNumber: number;
  totalAudioFrames: number;
  socket?: WebSocket | undefined;
}

export class CloudGatewayRouter {
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly defaultPort: number;

  constructor(port: number = DEFAULT_WS_PORT) {
    this.defaultPort = port;
  }

  public getPort(): number {
    return this.defaultPort;
  }

  public registerDevice(deviceId: string): DeviceSession {
    const existing = this.sessions.get(deviceId);
    if (existing) {
      return existing;
    }

    const session: DeviceSession = {
      deviceId,
      connectedAt: new Date(),
      lastSequenceNumber: 0,
      totalAudioFrames: 0,
    };
    this.sessions.set(deviceId, session);
    return session;
  }

  public unregisterDevice(deviceId: string): boolean {
    return this.sessions.delete(deviceId);
  }

  public getSession(deviceId: string): DeviceSession | undefined {
    return this.sessions.get(deviceId);
  }

  public attachWebSocket(deviceId: string, socket: WebSocket): DeviceSession {
    let session = this.sessions.get(deviceId);
    if (!session) {
      session = this.registerDevice(deviceId);
    }
    session.socket = socket;
    return session;
  }

  public detachWebSocket(deviceId: string): void {
    const session = this.sessions.get(deviceId);
    if (session) {
      session.socket = undefined;
    }
  }

  public getWebSocket(deviceId: string): WebSocket | undefined {
    return this.sessions.get(deviceId)?.socket;
  }

  public pushFrameToDevice(deviceId: string, frame: Uint8Array): boolean {
    const session = this.sessions.get(deviceId);
    if (session?.socket && session.socket.readyState === 1 /* OPEN */) {
      session.socket.send(frame);
      return true;
    }
    return false;
  }

  public broadcastFrameToUserDevices(deviceIds: string[], frame: Uint8Array): number {
    let sent = 0;
    for (const devId of deviceIds) {
      if (this.pushFrameToDevice(devId, frame)) {
        sent += 1;
      }
    }
    return sent;
  }

  public getAllActiveDeviceIds(): string[] {
    const active: string[] = [];
    for (const [id, session] of this.sessions.entries()) {
      if (session.socket && session.socket.readyState === 1) {
        active.push(id);
      }
    }
    return active;
  }

  public handleInboundFrame(
    deviceId: string,
    frameBuffer: Uint8Array
  ): {
    frame: DecodedFrame;
    widgetPayload?: WidgetPacket | undefined;
  } {
    const frame = decodeFrame(frameBuffer);
    const session = this.sessions.get(deviceId);

    if (session) {
      session.lastSequenceNumber = frame.header.seqId;
      if (frame.header.frameType === FrameType.AUDIO_UPLINK_FRAME) {
        session.totalAudioFrames += 1;
      }
    }

    let widgetPayload: WidgetPacket | undefined;
    if (frame.header.frameType === FrameType.WIDGET_DEPLOY) {
      widgetPayload = deserializeWidgetPacket(frame.payload);
    }

    return { frame, widgetPayload };
  }

  public createAckFrame(sequence: number): Uint8Array {
    return encodeFrame(FrameType.HEARTBEAT_PONG, new Uint8Array(0), sequence);
  }
}

// ============================================================================
// Cloud Gateway Fastify Server Factory
// ============================================================================

export interface CloudGatewayServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  jwtSecret?: string | undefined;
  corsOrigin?: boolean | string | string[] | undefined;
  logger?: boolean | undefined;
  entitlementEngine?: EntitlementEngine | undefined;
  gatewayRouter?: CloudGatewayRouter | undefined;
  compilerService?: ZeroCodeCompilerService | undefined;
}

export interface CloudGatewayServerInstance {
  readonly app: FastifyInstance;
  readonly router: CloudGatewayRouter;
  readonly engine: EntitlementEngine;
  readonly voiceGatewayManager: VoiceGatewayManager;
  readonly compilerService: ZeroCodeCompilerService;
  start: (port?: number, host?: string) => Promise<string>;
  stop: () => Promise<void>;
}

export async function createCloudGatewayServer(
  options?: CloudGatewayServerOptions
): Promise<CloudGatewayServerInstance> {
  const engine =
    options?.entitlementEngine ??
    new EntitlementEngine({
      jwtSecret: options?.jwtSecret,
    });

  const router =
    options?.gatewayRouter ??
    new CloudGatewayRouter(options?.port ?? DEFAULT_GATEWAY_PORT);

  const compilerService =
    options?.compilerService ?? new ZeroCodeCompilerService();

  const app = Fastify({
    logger: options?.logger ?? false,
  });

  // 1. Cross-Origin Resource Sharing
  await app.register(cors, {
    origin: options?.corsOrigin ?? true,
    credentials: true,
  });

  // 2. High-performance WebSocket Plugin
  await app.register(websocket, {
    options: {
      maxPayload: 1048576, // 1MB frame buffer limit
    },
  });

  // 3. Register Subscription & Entitlement API Routes
  await app.register(subscriptionRoutes, {
    entitlementEngine: engine,
    gatewayRouter: router,
  });

  // 4. Register Zero-Code Widget & Workflow Studio API Routes
  await app.register(studioRoutes, {
    compilerService,
  });

  // 5. Health and Status Diagnostic Endpoint
  app.get("/health", async () => {
    return {
      status: "ok",
      service: "petbot-cloud-gateway",
      activeSessions: router.getAllActiveDeviceIds().length,
      timestamp: new Date().toISOString(),
    };
  });

  // 5b. Live Gemini Cross-Widget Voice & Command Endpoint
  const commandBrain = new AgenticVoiceBrain();
  app.post("/api/v1/voice/command", async (req, reply) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const text = typeof body["text"] === "string" ? body["text"].trim() : "";
    if (!text) {
      return reply.code(400).send({ error: "Missing required 'text' command" });
    }

    const persona = body["persona"] as PetPersonaId | undefined;
    if (persona && PET_PERSONA_PROFILES[persona]) {
      commandBrain.setPersona(persona);
    }

    const deviceId = typeof body["deviceId"] === "string" ? body["deviceId"] : undefined;
    const statePatch = body["statePatch"] as Partial<RobotEcosystemState> | undefined;

    const turnResult = await commandBrain.processUserUtterance(text, {
      ...(deviceId ? { deviceId } : {}),
      ...(statePatch ? { statePatch } : {}),
    });

    let pushedToDevice = 0;
    for (const frame of turnResult.framesToSend) {
      if (deviceId && router.pushFrameToDevice(deviceId, frame)) {
        pushedToDevice++;
      } else {
        for (const activeId of router.getAllActiveDeviceIds()) {
          if (router.pushFrameToDevice(activeId, frame)) pushedToDevice++;
        }
      }
    }

    return {
      success: true,
      spokenText: turnResult.spokenText,
      emotionId: turnResult.emotionId,
      persona: turnResult.persona,
      toolCalls: turnResult.toolCallsExecuted.map((t) => ({
        toolName: t.toolName,
        success: t.success,
        resultMessage: t.resultMessage,
        data: t.data,
      })),
      framesGenerated: turnResult.framesToSend.length,
      framesDispatched: pushedToDevice,
      ecosystemState: commandBrain.getEcosystemState(),
    };
  });

  // 6. Binary Frame WebSocket Stream Endpoints
  function setupWebSocketHandler(socket: WebSocket, deviceId: string) {
    router.attachWebSocket(deviceId, socket);

    const streamParser = new FrameStreamParser({
      zeroCopy: true,
    });

    streamParser.onFrame((frame) => {
      // Feed frame to router session tracking
      const encoded = encodeFrame(
        frame.header.frameType,
        frame.payload,
        frame.header.seqId,
        frame.header.flags
      );
      router.handleInboundFrame(deviceId, encoded);

      // Automatic Pong on Ping
      if (frame.header.frameType === FrameType.HEARTBEAT_PING) {
        const pong = router.createAckFrame(frame.header.seqId);
        if (socket.readyState === 1) {
          socket.send(pong);
        }
      }
    });

    socket.on("message", (raw: unknown, isBinary: boolean) => {
      if (isBinary && raw) {
        let buffer: Uint8Array;
        if (raw instanceof Uint8Array) {
          buffer = raw;
        } else if (raw instanceof ArrayBuffer) {
          buffer = new Uint8Array(raw);
        } else if (Buffer.isBuffer(raw)) {
          buffer = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        } else {
          return;
        }
        streamParser.push(buffer);
      }
    });

    socket.on("close", () => {
      router.detachWebSocket(deviceId);
    });

    socket.on("error", () => {
      router.detachWebSocket(deviceId);
    });
  }

  app.get("/ws", { websocket: true }, (socket, req) => {
    const query = req.query as Record<string, string>;
    const deviceId = query["deviceId"] || `robot-esp32-${Date.now()}`;
    setupWebSocketHandler(socket, deviceId);
  });

  app.get("/ws/device/:deviceId", { websocket: true }, (socket, req) => {
    const params = req.params as { deviceId: string };
    setupWebSocketHandler(socket, params.deviceId);
  });

  // 7. Real-Time Bi-Directional Voice Stream WebSocket Endpoint
  const voiceGatewayManager = registerVoiceGatewayWebSocket(app, {
    entitlementEngine: engine,
  });

  const serverInstance: CloudGatewayServerInstance = {
    app,
    router,
    engine,
    voiceGatewayManager,
    compilerService,
    start: async (port?: number, host = "0.0.0.0") => {
      const listenPort = port ?? options?.port ?? DEFAULT_GATEWAY_PORT;
      const address = await app.listen({ port: listenPort, host });
      return address;
    },
    stop: async () => {
      await app.close();
    },
  };

  return serverInstance;
}

export const buildCloudGatewayServer = createCloudGatewayServer;

// Standalone execution trigger
const isDirectEntry =
  typeof process !== "undefined" &&
  process.env["NODE_ENV"] !== "test" &&
  process.argv[1] &&
  (pathToFileURL(process.argv[1]).href === import.meta.url ||
    process.argv[1].replace(/\\/g, "/").endsWith("src/index.ts") ||
    process.argv[1].replace(/\\/g, "/").endsWith("dist/index.js"));

if (isDirectEntry) {
  const port = parseInt(process.env["PORT"] ?? `${DEFAULT_GATEWAY_PORT}`, 10);
  createCloudGatewayServer({ logger: true, port })
    .then((srv) => srv.start(port))
    .then((address) => {
      console.log(`[CloudGateway] Server running on ${address}`);
    })
    .catch((err) => {
      console.error("[CloudGateway] Startup error:", err);
      process.exit(1);
    });
}
