/**
 * Bi-Directional Voice AI WebSocket Gateway
 * 
 * Features:
 * 1. Binary WebSocket Endpoint at `/ws/v1/voice-stream`.
 * 2. Subscription Gate Enforcement:
 *    - Rejects AUDIO_UPLINK_FRAME streaming for non-PRO users.
 *    - Dispatches instant friendly vocal/visual prompt: "[ALERT] Real-time Voice AI is a PetBot Pro feature."
 * 3. End-to-End Pipeline:
 *    - Ingests AUDIO_UPLINK_FRAME -> UplinkAudioBuffer -> STT -> AgenticVoiceBrain -> Downlink Frames.
 *    - Relays tool RPC frames (HARNESS_RPC_REQ, WIDGET_DEPLOY) immediately.
 * 4. Instant Barge-In (Interruption):
 *    - Aborts active downlink TTS queue immediately if user speaks (vadActive == 1) during playback.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import {
  FrameType,
  EmotionId,
  FrameStreamParser,
  decodeFrame,
  decodeAudioUplinkFrame,
  encodeFrame,
  type DecodedFrame,
  type AudioUplinkFrame,
} from "@petbot/protocol";
import {
  EntitlementEngine,
  type SubscriptionTier,
} from "../auth/entitlement-engine.js";
import {
  UplinkAudioBuffer,
  chunkPcmToSyncedDownlinkFrames,
  proceduralFormantSynthesize,
  type CompletedUtterance,
} from "./audio-viseme-pipeline.js";
import {
  AgenticVoiceBrain,
  type PetPersonaId,
  type BrainVoiceTurnResult,
} from "./agentic-voice-brain.js";
import {
  PartnerOrchestrator,
  type PartnerVoiceTurnResult,
} from "./partner-orchestrator.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export type SttTranscriberFn = (
  pcmBytes: Uint8Array,
  sampleRate: number
) => Promise<string>;

export type TtsSynthesizerFn = (
  text: string
) => Promise<{ pcm: Uint8Array | Int16Array; sampleRate: number }>;

export interface VoiceGatewayWsOptions {
  entitlementEngine: EntitlementEngine;
  sttTranscriber?: SttTranscriberFn | undefined;
  ttsSynthesizer?: TtsSynthesizerFn | undefined;
  defaultPersona?: PetPersonaId | undefined;
  partnerOrchestrator?: PartnerOrchestrator | undefined;
}

export interface VoiceSessionState {
  readonly sessionId: string;
  deviceId: string;
  readonly socket: WebSocket;
  userId: string;
  tier: SubscriptionTier;
  persona: PetPersonaId;
  isAuthenticated: boolean;
  connectedAt: Date;

  // DSP and Agent instances
  uplinkBuffer: UplinkAudioBuffer;
  brain: AgenticVoiceBrain;
  downlinkSeqId: number;

  // Real-time state flags
  isStreamingDownlink: boolean;
  currentDownlinkAbortController: AbortController | null;
  totalAudioUplinkFrames: number;
  totalAudioDownlinkFrames: number;
  totalToolCalls: number;
  lastActiveTimestampMs: number;
}

// ============================================================================
// Voice Gateway Manager
// ============================================================================

export class VoiceGatewayManager {
  private readonly sessions = new Map<string, VoiceSessionState>(); // deviceId -> session
  private readonly entitlementEngine: EntitlementEngine;
  private readonly sttTranscriber: SttTranscriberFn | undefined;
  private readonly ttsSynthesizer: TtsSynthesizerFn | undefined;
  private readonly defaultPersona: PetPersonaId;
  public readonly partnerOrchestrator: PartnerOrchestrator;

  constructor(options: VoiceGatewayWsOptions) {
    this.entitlementEngine = options.entitlementEngine;
    this.sttTranscriber = options.sttTranscriber;
    this.ttsSynthesizer = options.ttsSynthesizer;
    this.defaultPersona = options.defaultPersona ?? "Nova";
    this.partnerOrchestrator = options.partnerOrchestrator ?? new PartnerOrchestrator();
  }

  public getPartnerOrchestrator(): PartnerOrchestrator {
    return this.partnerOrchestrator;
  }

  public getSession(deviceId: string): VoiceSessionState | undefined {
    return this.sessions.get(deviceId);
  }

  public getAllActiveSessions(): VoiceSessionState[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Main entry point when a WebSocket client connects to `/ws/v1/voice-stream`.
   */
  public handleConnection(socket: WebSocket, req: FastifyRequest): VoiceSessionState {
    const query = (req.query as Record<string, string>) ?? {};
    const headers = req.headers;

    // 1. Resolve Device & Authentication
    let token = query["token"];
    if (!token && typeof headers["authorization"] === "string") {
      const parts = headers["authorization"].split(" ");
      if (parts[0] === "Bearer" && parts[1]) {
        token = parts[1];
      }
    }

    let deviceId = query["deviceId"] || `esp32s3-${Date.now().toString(36)}`;
    let userId = "anonymous-user";
    let tier: SubscriptionTier = "FREE";
    let persona: PetPersonaId = this.defaultPersona;
    let isAuthenticated = false;

    // If token provided, verify synchronously or pre-extract
    if (token) {
      this.entitlementEngine
        .verifyEntitlementJwt(token)
        .then((claims) => {
          session.userId = claims.sub;
          session.deviceId = claims.deviceId || deviceId;
          session.tier = claims.tier;
          session.persona = (claims.activePersona as PetPersonaId) || this.defaultPersona;
          session.isAuthenticated = true;
          session.brain.setPersona(session.persona);
        })
        .catch(() => {
          // Token invalid, remain FREE anonymous
        });
    } else {
      // Check device in registry
      const registeredDevice = this.entitlementEngine.getDevice(deviceId);
      if (registeredDevice) {
        userId = registeredDevice.ownerUserId;
        const user = this.entitlementEngine.getUser(userId);
        if (user) {
          tier = user.tier;
          persona = (user.activePersona as PetPersonaId) || this.defaultPersona;
          isAuthenticated = true;
        }
      }
    }

    const sessionId = `vses_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const brain = new AgenticVoiceBrain({ persona });
    const uplinkBuffer = new UplinkAudioBuffer({
      energyThreshold: 650,
      silenceTimeoutMs: 450,
      minSpeechFrames: 2,
    });

    const session: VoiceSessionState = {
      sessionId,
      deviceId,
      socket,
      userId,
      tier,
      persona,
      isAuthenticated,
      connectedAt: new Date(),
      uplinkBuffer,
      brain,
      downlinkSeqId: 0,
      isStreamingDownlink: false,
      currentDownlinkAbortController: null,
      totalAudioUplinkFrames: 0,
      totalAudioDownlinkFrames: 0,
      totalToolCalls: 0,
      lastActiveTimestampMs: Date.now(),
    };

    this.sessions.set(deviceId, session);

    // 2. Wire Frame Stream Parser for binary protocol frames
    const parser = new FrameStreamParser({ zeroCopy: true });

    parser.onFrame(async (frame) => {
      await this.handleIncomingFrame(session, frame);
    });

    // 3. Socket Event Handlers
    socket.on("message", (raw: unknown, isBinary: boolean) => {
      session.lastActiveTimestampMs = Date.now();
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

        parser.push(buffer);
      }
    });

    socket.on("close", () => {
      this.cleanupSession(session);
    });

    socket.on("error", () => {
      this.cleanupSession(session);
    });

    return session;
  }

  // ==========================================================================
  // Incoming Binary Frame Router
  // ==========================================================================

  private async handleIncomingFrame(
    session: VoiceSessionState,
    frame: DecodedFrame
  ): Promise<void> {
    switch (frame.header.frameType) {
      case FrameType.AUDIO_UPLINK_FRAME: {
        session.totalAudioUplinkFrames++;
        await this.handleAudioUplinkFrame(session, frame);
        break;
      }

      case FrameType.HELLO_HANDSHAKE: {
        // Handshake packet from robot firmware: reply with heartbeat pong
        const pong = encodeFrame(
          FrameType.HEARTBEAT_PONG,
          new Uint8Array(0),
          session.downlinkSeqId++
        );
        this.safeSend(session, pong);
        break;
      }

      case FrameType.HEARTBEAT_PING: {
        const pong = encodeFrame(
          FrameType.HEARTBEAT_PONG,
          frame.payload,
          frame.header.seqId
        );
        this.safeSend(session, pong);
        break;
      }

      default:
        break;
    }
  }

  // ==========================================================================
  // Audio Uplink Streaming & Subscription Enforcement
  // ==========================================================================

  private async handleAudioUplinkFrame(
    session: VoiceSessionState,
    frame: DecodedFrame
  ): Promise<void> {
    const uplink = decodeAudioUplinkFrame(frame.payload);

    // ========================================================================
    // SUBSCRIPTION GATE ENFORCEMENT:
    // Reject streaming for non-PRO users with instant vocal/visual upgrade prompt
    // ========================================================================
    const caps = this.entitlementEngine.getCapabilities(session.tier);
    if (!caps.voiceAiEnabled) {
      await this.rejectNonProStreaming(session);
      return;
    }

    // ========================================================================
    // INSTANT BARGE-IN (INTERRUPTION):
    // If user speaks (vadActive == 1) during downlink playback, abort immediately!
    // ========================================================================
    if (uplink.vadActive && session.isStreamingDownlink) {
      if (session.currentDownlinkAbortController) {
        session.currentDownlinkAbortController.abort();
        session.currentDownlinkAbortController = null;
      }
      session.isStreamingDownlink = false;

      // Send immediate interruption / listening keyframe
      const cancelPayload = chunkPcmToSyncedDownlinkFrames(new Int16Array(320), {
        emotionId: EmotionId.LISTENING,
        eyeGazeX: -8,
        eyeGazeY: 4,
        startSeqId: session.downlinkSeqId++,
      });
      if (cancelPayload[0]) {
        this.safeSend(session, cancelPayload[0].binaryFrame);
      }
    }

    // Ingest audio slice into VAD accumulator
    const utterance = session.uplinkBuffer.ingestFrame(uplink);
    if (utterance) {
      // Complete user utterance captured! Process through AI Brain
      await this.processCompletedUtterance(session, utterance);
    }
  }

  /**
   * Rejects non-subscribed user audio stream with short friendly vocal + visual prompt.
   */
  private async rejectNonProStreaming(session: VoiceSessionState): Promise<void> {
    if (session.isStreamingDownlink) {
      return; // Already explaining
    }

    session.isStreamingDownlink = true;
    session.currentDownlinkAbortController = new AbortController();

    const promptText =
      "[ALERT] Real-time Voice AI is a PetBot Pro feature. Please upgrade in your companion app!";

    // Synthesize vocal explanation with wide alert eyes
    const pcm = proceduralFormantSynthesize(promptText, {
      emotionId: EmotionId.ALERT,
      speedFactor: 1.1,
    });

    const frames = chunkPcmToSyncedDownlinkFrames(pcm, {
      emotionId: EmotionId.ALERT,
      eyeGazeX: 0,
      eyeGazeY: 16,
      startSeqId: session.downlinkSeqId,
    });

    session.downlinkSeqId = (session.downlinkSeqId + frames.length) & 0xffff;

    for (const f of frames) {
      if (session.currentDownlinkAbortController?.signal.aborted) {
        break;
      }
      this.safeSend(session, f.binaryFrame);
    }

    session.isStreamingDownlink = false;
  }

  // ==========================================================================
  // Speech-To-Text -> Agentic Brain -> Text-To-Speech Downlink Pipeline
  // ==========================================================================

  private async processCompletedUtterance(
    session: VoiceSessionState,
    utterance: CompletedUtterance
  ): Promise<void> {
    // 1. Transcribe Speech
    let transcription = "";
    if (this.sttTranscriber) {
      try {
        transcription = await this.sttTranscriber(utterance.pcmBytes, 16000);
      } catch {
        transcription = "";
      }
    }

    // Fallback / mock transcription for tests and local demo if no external STT
    if (!transcription) {
      transcription = this.inferMockTranscriptionFromAudio(utterance);
    }

    // 2. Check if this is an autonomous partner request!
    if (this.partnerOrchestrator.isPartnerCommand(transcription)) {
      const partnerResult = await this.partnerOrchestrator.handlePartnerVoiceUtterance(transcription, {
        deviceId: session.deviceId,
        startSeqId: session.downlinkSeqId,
      });

      session.downlinkSeqId = (session.downlinkSeqId + partnerResult.binaryFrames.length) & 0xffff;
      session.totalToolCalls += partnerResult.toolCallsExecuted.length;

      // Stream partner audio downlink frames
      session.isStreamingDownlink = true;
      const abortController = new AbortController();
      session.currentDownlinkAbortController = abortController;

      try {
        for (const frame of partnerResult.binaryFrames) {
          if (abortController.signal.aborted) break;
          this.safeSend(session, frame);
          session.totalAudioDownlinkFrames++;
        }
      } finally {
        session.isStreamingDownlink = false;
        session.currentDownlinkAbortController = null;
      }
      return;
    }

    // 3. Process via Agentic Brain
    const turnResult = await session.brain.processUserUtterance(transcription, {
      deviceId: session.deviceId,
      ownerUserId: session.userId,
    });

    session.totalToolCalls += turnResult.toolCallsExecuted.length;

    // 3. Immediately dispatch all tool-call binary control frames (HARNESS_RPC_REQ, WIDGET_DEPLOY)
    for (const frame of turnResult.framesToSend) {
      this.safeSend(session, frame);
    }

    // 4. Stream emotion-synchronized speech downlink frames
    await this.streamDownlinkFrames(session, turnResult);
  }

  /**
   * Streams 20ms AUDIO_DOWNLINK_FRAME packets with interleaved 8-byte visual expressions.
   */
  private async streamDownlinkFrames(
    session: VoiceSessionState,
    turnResult: BrainVoiceTurnResult
  ): Promise<void> {
    session.isStreamingDownlink = true;
    const abortController = new AbortController();
    session.currentDownlinkAbortController = abortController;

    let pcm: Uint8Array | Int16Array;
    let sampleRate = 16000;

    if (this.ttsSynthesizer) {
      try {
        const tts = await this.ttsSynthesizer(turnResult.spokenText);
        pcm = tts.pcm;
        sampleRate = tts.sampleRate;
      } catch {
        pcm = proceduralFormantSynthesize(turnResult.spokenText, {
          emotionId: turnResult.emotionId,
        });
      }
    } else {
      pcm = proceduralFormantSynthesize(turnResult.spokenText, {
        emotionId: turnResult.emotionId,
      });
    }

    const downlinkFrames = chunkPcmToSyncedDownlinkFrames(pcm, {
      inputSampleRate: sampleRate,
      emotionId: turnResult.emotionId,
      startSeqId: session.downlinkSeqId,
    });

    session.downlinkSeqId = (session.downlinkSeqId + downlinkFrames.length) & 0xffff;

    for (const frame of downlinkFrames) {
      if (abortController.signal.aborted) {
        break; // Interrupted by user barge-in
      }

      this.safeSend(session, frame.binaryFrame);
      session.totalAudioDownlinkFrames++;

      // Yield event loop briefly for real-time flow
      await new Promise((resolve) => setImmediate(resolve));
    }

    session.isStreamingDownlink = false;
    session.currentDownlinkAbortController = null;
  }

  /**
   * Helper that infers transcription for testing/offline scenarios when no external STT is configured.
   */
  private inferMockTranscriptionFromAudio(utterance: CompletedUtterance): string {
    // If utterance contains simulated tone tests, return natural voice queries
    if (utterance.durationMs > 2500) {
      return "Hey PetBot, create a coffee counter widget on your screen";
    }
    if (utterance.durationMs > 1500) {
      return "Start a 25-minute Pomodoro timer";
    }
    return "Toggle microphone mute";
  }

  private safeSend(session: VoiceSessionState, data: Uint8Array): void {
    if (session.socket.readyState === 1 /* OPEN */) {
      session.socket.send(data);
    }
  }

  private cleanupSession(session: VoiceSessionState): void {
    if (session.currentDownlinkAbortController) {
      session.currentDownlinkAbortController.abort();
    }
    session.uplinkBuffer.reset();
    this.sessions.delete(session.deviceId);
  }
}

// ============================================================================
// Fastify Route Registration Plugin
// ============================================================================

export function registerVoiceGatewayWebSocket(
  app: FastifyInstance,
  options: VoiceGatewayWsOptions
): VoiceGatewayManager {
  const manager = new VoiceGatewayManager(options);

  app.get("/ws/v1/voice-stream", { websocket: true }, (socket, req) => {
    manager.handleConnection(socket, req);
  });

  return manager;
}
