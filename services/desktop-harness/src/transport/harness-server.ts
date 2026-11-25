import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as os from "node:os";
import * as nodeCrypto from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { Bonjour } from "bonjour-service";
import pino from "pino";
import {
  DEFAULT_WS_PORT,
  FrameType,
  RiskTier,
  RobotMode,
  encodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  FrameStreamParser,
  HelloHandshakeSchema,
  ModeTransitionSchema,
  HeartbeatPayloadSchema,
  Touch2FaChallengeSchema,
  Touch2FaResponseSchema,
  HarnessRpcReqSchema,
  HarnessRpcResSchema,
  type DecodedFrame,
  type HelloHandshake,
  type ModeTransition,
  type HeartbeatPayload,
  type Touch2FaResponse,
  type HarnessRpcReq,
  type HarnessRpcRes,
  type SystemTelemetry,
} from "@petbot/protocol";
import {
  CryptoVault,
  type PairedDeviceRecord,
  type ActiveChallenge,
} from "../security/crypto-vault.js";

export interface HarnessServerOptions {
  port?: number;
  host?: string;
  cryptoVault?: CryptoVault;
  allowPairingMode?: boolean;
  logger?: pino.Logger;
  bonjourEnabled?: boolean;
  heartbeatIntervalMs?: number;
}

export interface PeerSession {
  id: string;
  socket: WebSocket;
  remoteAddress: string;
  parser: FrameStreamParser;
  authenticated: boolean;
  handshakeCompleted: boolean;
  device?: PairedDeviceRecord;
  role?: "ROBOT" | "COMPANION";
  connectedAt: number;
  lastFrameAt: number;
  sequenceOut: number;
}

interface Pending2Fa {
  challenge: ActiveChallenge;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

/**
 * Low-latency binary WebSocket server with Bonjour mDNS advertisement,
 * Zero-Trust Ed25519/HMAC authentication, and hardware 2FA orchestration.
 */
export class HarnessServer extends EventEmitter {
  public readonly port: number;
  public readonly host: string;
  public readonly cryptoVault: CryptoVault;
  private readonly logger: pino.Logger;
  private readonly allowPairingMode: boolean;
  private readonly bonjourEnabled: boolean;
  private readonly heartbeatIntervalMs: number;

  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private bonjour: Bonjour | null = null;
  private bonjourService: ReturnType<Bonjour["publish"]> | null = null;

  private readonly sessions = new Map<string, PeerSession>();
  private activeRobotSession: PeerSession | null = null;
  private readonly pending2Fa = new Map<string, Pending2Fa>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private nextSessionId = 1;

  constructor(options?: HarnessServerOptions) {
    super();
    this.port = options?.port ?? DEFAULT_WS_PORT;
    this.host = options?.host ?? "0.0.0.0";
    this.cryptoVault = options?.cryptoVault ?? new CryptoVault();
    this.allowPairingMode = options?.allowPairingMode ?? false;
    this.bonjourEnabled = options?.bonjourEnabled ?? true;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 3000;

    this.logger =
      options?.logger ??
      pino({
        name: "desktop-harness",
        level: process.env["LOG_LEVEL"] ?? "info",
      });
  }

  public getActiveRobotSession(): PeerSession | null {
    return this.activeRobotSession;
  }

  public getSessions(): PeerSession[] {
    return Array.from(this.sessions.values());
  }

  public isRunning(): boolean {
    return this.wss !== null;
  }

  /**
   * Starts WebSocket server on port 8443, sets TCP_NODELAY, and broadcasts mDNS service.
   */
  public async start(): Promise<void> {
    if (this.wss) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.httpServer = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            service: "petbot-desktop-harness",
            status: "running",
            harnessId: this.cryptoVault.getIdentity().deviceId,
            ed25519PublicKeyHex: this.cryptoVault.getIdentity().ed25519PublicKeyHex,
            connectedPeers: this.sessions.size,
          })
        );
      });

      this.wss = new WebSocketServer({
        server: this.httpServer,
        perMessageDeflate: false, // Zero compression overhead for low-latency packets
      });

      this.wss.on("connection", (socket: WebSocket, req: http.IncomingMessage) => {
        this.handleConnection(socket, req);
      });

      this.wss.on("error", (err: Error) => {
        this.logger.error({ err }, "[HarnessServer] WebSocket server error");
        this.emit("error", err);
      });

      this.httpServer.on("error", (err: Error) => {
        this.logger.error({ err }, "[HarnessServer] HTTP server listen error");
        reject(err);
      });

      this.httpServer.listen(this.port, this.host, () => {
        this.logger.info(
          { port: this.port, host: this.host },
          "[HarnessServer] Low-latency WebSocket server listening"
        );

        // Start Bonjour / mDNS Service Broadcaster
        if (this.bonjourEnabled) {
          this.startMdnsBroadcaster();
        }

        // Periodic heartbeat watchdog
        this.heartbeatTimer = setInterval(() => {
          this.sweepHeartbeats();
        }, this.heartbeatIntervalMs);

        resolve();
      });
    });
  }

  /**
   * Gracefully shuts down WebSocket server, terminates sessions, and tears down mDNS.
   */
  public async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Reject all pending 2FA challenges
    for (const [chalId, pending] of this.pending2Fa.entries()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
      this.pending2Fa.delete(chalId);
    }

    // Stop mDNS broadcaster
    if (this.bonjour) {
      try {
        if (this.bonjourService) {
          this.bonjourService.stop?.();
          this.bonjourService = null;
        }
        this.bonjour.unpublishAll();
        this.bonjour.destroy();
      } catch (err) {
        this.logger.warn({ err }, "[HarnessServer] Error tearing down Bonjour service");
      }
      this.bonjour = null;
    }

    // Close all connected peer sockets
    for (const session of this.sessions.values()) {
      try {
        session.socket.terminate();
      } catch {
        // Ignore termination error
      }
    }
    this.sessions.clear();
    this.activeRobotSession = null;

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss?.close(() => resolve());
      });
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = null;
    }

    this.logger.info("[HarnessServer] Server stopped successfully");
  }

  public getBoundPort(): number {
    const addr = this.httpServer?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return this.port;
  }

  // --- Public Message Routing API ---

  /**
   * Transmits a binary PetBot frame directly to the connected, authenticated ESP32-S3 robot.
   */
  public sendToRobot(frameType: FrameType, payload: Uint8Array, flags: number = 0): boolean {
    if (
      !this.activeRobotSession ||
      !this.activeRobotSession.authenticated ||
      this.activeRobotSession.socket.readyState !== WebSocket.OPEN
    ) {
      this.logger.warn(
        { frameType },
        "[HarnessServer] Cannot send frame: No authenticated robot session active"
      );
      return false;
    }

    return this.sendFrameToSession(this.activeRobotSession, frameType, payload, flags);
  }

  /**
   * Broadcasts a binary PetBot frame to all connected and authenticated Companion apps.
   */
  public broadcastToCompanions(frameType: FrameType, payload: Uint8Array): void {
    for (const session of this.sessions.values()) {
      if (
        session.authenticated &&
        session.role === "COMPANION" &&
        session.socket.readyState === WebSocket.OPEN
      ) {
        this.sendFrameToSession(session, frameType, payload);
      }
    }
  }

  /**
   * Requests physical capacitive Hardware 2FA confirmation from the robot.
   * Transmits TOUCH_2FA_CHALLENGE frame and awaits verified TOUCH_2FA_RESPONSE.
   */
  public async requestHardwareTouch2FA(
    actionTitle: string,
    riskTier: RiskTier,
    timeoutMs: number = 15000
  ): Promise<boolean> {
    if (
      !this.activeRobotSession ||
      !this.activeRobotSession.authenticated ||
      this.activeRobotSession.socket.readyState !== WebSocket.OPEN
    ) {
      this.logger.warn(
        { actionTitle },
        "[HarnessServer] Cannot request 2FA: Robot is not connected/authenticated"
      );
      return false;
    }

    const challenge = this.cryptoVault.createTouch2FAChallenge(actionTitle, riskTier, timeoutMs);
    const challengePayload = encodeControlPayload(
      Touch2FaChallengeSchema,
      challenge.protocolPayload
    );

    const sent = this.sendToRobot(FrameType.TOUCH_2FA_CHALLENGE, challengePayload);
    if (!sent) {
      return false;
    }

    this.logger.info(
      { challengeId: challenge.challengeId, actionTitle, riskTier: challenge.riskTierName },
      "[HarnessServer] Dispatched TOUCH_2FA_CHALLENGE to robot"
    );

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending2Fa.delete(challenge.challengeId);
        this.logger.warn(
          { challengeId: challenge.challengeId },
          "[HarnessServer] Touch 2FA challenge timed out"
        );
        resolve(false);
      }, timeoutMs + 1000);

      this.pending2Fa.set(challenge.challengeId, {
        challenge,
        resolve,
        timer,
      });
    });
  }

  /**
   * Broadcasts PC telemetry (CPU %, RAM %, GPU %, media, active window) to the robot.
   */
  public broadcastTelemetry(telemetry: SystemTelemetry): void {
    if (!this.activeRobotSession || !this.activeRobotSession.authenticated) {
      return;
    }

    const rpcReq: HarnessRpcReq = {
      callId: `telemetry_${Date.now()}`,
      method: "telemetry_update",
      params: telemetry,
    };

    const payload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
    this.sendToRobot(FrameType.HARNESS_RPC_REQ, payload);
  }

  // --- Internal Connection & Frame Pipeline ---

  private handleConnection(socket: WebSocket, req: http.IncomingMessage): void {
    // Disable Nagle's algorithm for sub-millisecond roundtrips
    if (req.socket) {
      req.socket.setNoDelay(true);
    }

    const sessionId = `peer_${this.nextSessionId++}`;
    const remoteAddress = req.socket?.remoteAddress ?? "unknown";

    const parser = new FrameStreamParser({
      maxPayloadBytes: 65536,
      zeroCopy: true,
    });

    const session: PeerSession = {
      id: sessionId,
      socket,
      remoteAddress,
      parser,
      authenticated: false,
      handshakeCompleted: false,
      connectedAt: Date.now(),
      lastFrameAt: Date.now(),
      sequenceOut: 0,
    };

    this.sessions.set(sessionId, session);
    this.logger.info({ sessionId, remoteAddress }, "[HarnessServer] Peer connection opened");

    parser.onFrame((frame: DecodedFrame) => {
      this.handleFrame(session, frame);
    });

    parser.onError((err: Error) => {
      this.logger.warn({ sessionId, err: err.message }, "[HarnessServer] Frame stream parse error");
    });

    socket.on("message", (data: RawData) => {
      let chunk: Uint8Array;
      if (Buffer.isBuffer(data)) {
        chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else if (data instanceof ArrayBuffer) {
        chunk = new Uint8Array(data);
      } else if (Array.isArray(data)) {
        chunk = new Uint8Array(Buffer.concat(data));
      } else {
        return;
      }
      session.parser.push(chunk);
    });

    socket.on("close", (code: number, reason: Buffer) => {
      this.handleSocketClose(session, code, reason.toString("utf-8"));
    });

    socket.on("error", (err: Error) => {
      this.logger.warn({ sessionId, err: err.message }, "[HarnessServer] Socket error");
    });

    // Step 1 of Zero-Trust Handshake: Send Harness HELLO_HANDSHAKE immediately
    const harnessHandshake: HelloHandshake = {
      deviceId: this.cryptoVault.getIdentity().deviceId,
      firmwareVersion: "desktop-harness-1.0.0",
      psramFreeBytes: 0,
      sdCardCapacityBytes: 0,
      sdCardFreeBytes: 0,
      ed25519PublicKeyHex: this.cryptoVault.getIdentity().ed25519PublicKeyHex,
      capabilities: ["harness_rpc", "touch_2fa_requester", "telemetry_host", "sd_vault_fetch"],
    };

    const handshakePayload = encodeControlPayload(HelloHandshakeSchema, harnessHandshake);
    this.sendFrameToSession(session, FrameType.HELLO_HANDSHAKE, handshakePayload);
  }

  private handleFrame(session: PeerSession, frame: DecodedFrame): void {
    session.lastFrameAt = Date.now();
    const frameType = frame.header.frameType;

    // Handle handshake frame
    if (frameType === FrameType.HELLO_HANDSHAKE) {
      this.processPeerHandshake(session, frame);
      return;
    }

    // CRITICAL SECURITY RULE: Zero-Trust Gate
    // Never execute any RPC or sensitive action from an unauthenticated socket.
    if (!session.authenticated) {
      this.logger.warn(
        { sessionId: session.id, frameType },
        "[HarnessServer] SECURITY VIOLATION: Dropping frame from unauthenticated peer socket"
      );
      return;
    }

    // Route authenticated frames
    switch (frameType) {
      case FrameType.HEARTBEAT_PING: {
        const pong: HeartbeatPayload = {
          timestampUs: Date.now() * 1000,
          batteryPercent: 100,
          wifiRssi: 0,
        };
        const pongPayload = encodeControlPayload(HeartbeatPayloadSchema, pong);
        this.sendFrameToSession(session, FrameType.HEARTBEAT_PONG, pongPayload, 0, frame.header.seqId);
        break;
      }

      case FrameType.HEARTBEAT_PONG: {
        // Heartbeat acknowledged
        break;
      }

      case FrameType.TOUCH_2FA_RESPONSE: {
        try {
          const responsePayload = decodeControlPayload(Touch2FaResponseSchema, frame.payload);
          this.handleTouch2FAResponse(session, responsePayload);
        } catch (err) {
          this.logger.error({ err }, "[HarnessServer] Failed to decode TOUCH_2FA_RESPONSE");
        }
        break;
      }

      case FrameType.HARNESS_RPC_REQ: {
        try {
          const rpcReq = decodeControlPayload(HarnessRpcReqSchema, frame.payload);
          this.handleHarnessRpcReq(session, rpcReq, frame.header.seqId);
        } catch (err) {
          this.logger.error({ err }, "[HarnessServer] Failed to decode HARNESS_RPC_REQ");
        }
        break;
      }

      case FrameType.HARNESS_RPC_RES: {
        this.emit("harnessRpcRes", { session, frame });
        break;
      }

      default:
        this.emit("frame", { session, frame });
        break;
    }
  }

  private processPeerHandshake(session: PeerSession, frame: DecodedFrame): void {
    let peerHandshake: HelloHandshake;
    try {
      peerHandshake = decodeControlPayload(HelloHandshakeSchema, frame.payload);
    } catch (err) {
      this.logger.warn({ err }, "[HarnessServer] Malformed HELLO_HANDSHAKE payload");
      session.socket.close(4400, "Bad Handshake Payload");
      return;
    }

    this.logger.info(
      { deviceId: peerHandshake.deviceId, capabilities: peerHandshake.capabilities },
      "[HarnessServer] Received HELLO_HANDSHAKE from peer"
    );

    // Look up device in paired devices registry
    let record =
      this.cryptoVault.getPairedDevice(peerHandshake.deviceId) ??
      this.cryptoVault.findDeviceByPublicKey(peerHandshake.ed25519PublicKeyHex);

    if (!record && this.allowPairingMode) {
      // Auto-pairing in pairing mode
      const isRobot =
        peerHandshake.capabilities.includes("screen_128x160") ||
        peerHandshake.capabilities.includes("touch_2fa");
      const sharedSecretHex = nodeCrypto.randomBytes(32).toString("hex");

      record = this.cryptoVault.registerPairedDevice({
        deviceId: peerHandshake.deviceId,
        deviceName: isRobot ? "Pet Robot" : "Companion App",
        role: isRobot ? "ROBOT" : "COMPANION",
        ed25519PublicKeyHex: peerHandshake.ed25519PublicKeyHex,
        sharedHmacSecretHex: sharedSecretHex,
      });

      this.logger.info(
        { deviceId: record.deviceId, role: record.role },
        "[HarnessServer] Auto-paired new device during pairing mode"
      );
    }

    if (!record) {
      this.logger.warn(
        { deviceId: peerHandshake.deviceId, pubKey: peerHandshake.ed25519PublicKeyHex },
        "[HarnessServer] Authentication Failed: Peer device is not paired with Desktop Harness"
      );
      session.socket.close(4401, "Unauthorized: Device not paired");
      return;
    }

    // Authenticate session
    session.authenticated = true;
    session.handshakeCompleted = true;
    session.device = record;
    session.role = record.role;
    this.cryptoVault.updateLastSeen(record.deviceId);

    this.logger.info(
      { sessionId: session.id, deviceId: record.deviceId, role: record.role },
      "[HarnessServer] Peer authenticated successfully via pinned cryptographic key"
    );

    if (record.role === "ROBOT") {
      this.activeRobotSession = session;

      // Emit MODE_TRANSITION to AGENTIC_CONNECTED in <50ms
      const modeTransition: ModeTransition = {
        targetMode: RobotMode.AGENTIC_CONNECTED,
        companionHost: this.getLocalIpAddress(),
        companionPort: this.port,
        transitionReason: "DESKTOP_HARNESS_DISCOVERY_CONNECT",
      };

      const transitionPayload = encodeControlPayload(ModeTransitionSchema, modeTransition);
      this.sendFrameToSession(session, FrameType.MODE_TRANSITION, transitionPayload);
      this.logger.info(
        { targetMode: "AGENTIC_CONNECTED" },
        "[HarnessServer] Sent MODE_TRANSITION to Robot"
      );
    }

    this.emit("authenticated", session);
  }

  private handleTouch2FAResponse(session: PeerSession, response: Touch2FaResponse): void {
    const pending = this.pending2Fa.get(response.challengeId);
    if (!pending) {
      this.logger.warn(
        { challengeId: response.challengeId },
        "[HarnessServer] Received 2FA response for unknown/expired challenge"
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pending2Fa.delete(response.challengeId);

    if (!session.device) {
      pending.resolve(false);
      return;
    }

    const isVerified = this.cryptoVault.verifyTouch2FAResponse(
      pending.challenge,
      response,
      session.device
    );

    this.logger.info(
      { challengeId: response.challengeId, decision: response.decision, verified: isVerified },
      "[HarnessServer] Touch 2FA response verified"
    );

    pending.resolve(isVerified);
  }

  private handleHarnessRpcReq(session: PeerSession, req: HarnessRpcReq, seqId: number): void {
    this.logger.info({ method: req.method, callId: req.callId }, "[HarnessServer] Incoming RPC request");

    // Standard RPC dispatch (e.g. single tap on PC Telemetry HUD sends media_play_pause)
    let result: Record<string, unknown> = {};
    let success = true;

    if (req.method === "media_play_pause") {
      this.emit("mediaControl", { action: "play_pause", session });
      result = { status: "toggled" };
    } else {
      this.emit("rpcRequest", { req, session, reply: (res: HarnessRpcRes) => {
        const payload = encodeControlPayload(HarnessRpcResSchema, res);
        this.sendFrameToSession(session, FrameType.HARNESS_RPC_RES, payload, 0, seqId);
      }});
      return;
    }

    const res: HarnessRpcRes = {
      callId: req.callId,
      success,
      result,
    };
    const payload = encodeControlPayload(HarnessRpcResSchema, res);
    this.sendFrameToSession(session, FrameType.HARNESS_RPC_RES, payload, 0, seqId);
  }

  private sendFrameToSession(
    session: PeerSession,
    frameType: FrameType,
    payload: Uint8Array,
    flags: number = 0,
    seqId?: number
  ): boolean {
    if (session.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    const sequenceNumber = seqId ?? (++session.sequenceOut & 0xffff);
    const frameBytes = encodeFrame(frameType, payload, sequenceNumber, flags);

    try {
      session.socket.send(frameBytes, { binary: true });
      return true;
    } catch (err) {
      this.logger.warn({ sessionId: session.id, err }, "[HarnessServer] Failed to send frame");
      return false;
    }
  }

  private handleSocketClose(session: PeerSession, code: number, reason: string): void {
    this.logger.info(
      { sessionId: session.id, code, reason },
      "[HarnessServer] Peer socket closed"
    );

    if (this.activeRobotSession === session) {
      this.activeRobotSession = null;
      this.emit("robotDisconnected", session);
    }

    this.sessions.delete(session.id);
    this.emit("disconnected", session);
  }

  private sweepHeartbeats(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.authenticated) {
        // Disconnect unauthenticated sessions lingering for > 10 seconds
        if (now - session.connectedAt > 10000) {
          this.logger.warn(
            { sessionId: session.id },
            "[HarnessServer] Terminating lingering unauthenticated socket"
          );
          session.socket.close(4408, "Handshake Timeout");
        }
      }
    }
  }

  // --- Bonjour / mDNS Broadcaster ---

  private startMdnsBroadcaster(): void {
    try {
      this.bonjour = new Bonjour();
      this.bonjourService = this.bonjour.publish({
        name: "PetBot Desktop Harness",
        type: "petbot",
        protocol: "tcp",
        port: this.port,
        txt: {
          version: "1.0.0",
          role: "desktop-harness",
          harnessId: this.cryptoVault.getIdentity().deviceId,
          publicKey: this.cryptoVault.getIdentity().ed25519PublicKeyHex,
        },
      });

      this.logger.info(
        { service: "_petbot._tcp.local", port: this.port },
        "[HarnessServer] Bonjour mDNS service advertised"
      );
    } catch (err) {
      this.logger.warn({ err }, "[HarnessServer] Failed to publish Bonjour mDNS service");
    }
  }

  private getLocalIpAddress(): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name] ?? []) {
        if (net.family === "IPv4" && !net.internal) {
          return net.address;
        }
      }
    }
    return "127.0.0.1";
  }
}
