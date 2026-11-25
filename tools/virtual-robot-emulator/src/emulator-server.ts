import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Bonjour } from "bonjour-service";
import pino from "pino";
import {
  FrameStreamParser,
  FrameType,
  DEFAULT_WS_PORT,
  MDNS_SERVICE_NAME,
  encodeFrame,
  encodeControlPayload,
  HelloHandshakeSchema,
  type HelloHandshake,
} from "@petbot/protocol";
import {
  VirtualEsp32S3Robot,
  type VirtualRobotHardwareOptions,
  type TouchGesture,
} from "./virtual-hardware.js";

export interface VirtualRobotServerOptions extends VirtualRobotHardwareOptions {
  wsPort?: number | undefined;
  httpPort?: number | undefined;
  advertiseBonjour?: boolean | undefined;
  logger?: pino.Logger | undefined;
  harnessUrl?: string | undefined;
}

export class VirtualRobotServer {
  private readonly wsPort: number;
  private readonly httpPort: number;
  private readonly advertiseBonjour: boolean;
  private readonly harnessUrl: string | null;
  private readonly logger: pino.Logger;

  public readonly robot: VirtualEsp32S3Robot;
  private wsServer: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private bonjour: Bonjour | null = null;
  private bonjourService: any = null;
  private harnessClientWs: WebSocket | null = null;
  private harnessUnsub: (() => void) | null = null;

  private connectedClients = new Set<WebSocket>();
  private sseClients = new Set<http.ServerResponse>();

  constructor(options: VirtualRobotServerOptions = {}) {
    this.wsPort = options.wsPort ?? DEFAULT_WS_PORT; // 8443
    this.httpPort = options.httpPort ?? 8444;
    this.advertiseBonjour = options.advertiseBonjour ?? true;
    this.harnessUrl = options.harnessUrl ?? null;

    this.logger =
      options.logger ??
      pino({
        name: "petbot-emulator",
        level: "info",
      });

    this.robot = new VirtualEsp32S3Robot({
      ...options,
      onFrameOutbound: (frame) => this.broadcastBinaryFrame(frame),
      onSoundTriggered: (soundId) => {
        this.logger.info({ soundId }, `[Sound Effect] Playing ${soundId}`);
        this.notifySseClients();
      },
      onLogMessage: (msg) => {
        this.logger.info(msg);
        this.notifySseClients();
      },
    });
  }

  public async start(): Promise<void> {
    // 1. Binary Protocol WebSocket Server on wsPort (8443)
    await this.startWebSocketServer();

    // 2. HTTP Inspection Dashboard on httpPort (8444)
    await this.startHttpServer();

    // 3. Advertise mDNS _petbot._tcp.local
    if (this.advertiseBonjour) {
      try {
        this.bonjour = new Bonjour();
        this.bonjourService = this.bonjour.publish({
          name: "PetBot ESP32-S3 Emulator",
          type: "petbot",
          port: this.wsPort,
          txt: {
            deviceId: "petbot-esp32s3-sim-01",
            version: "1.0.0",
            mode: "EMULATOR",
          },
        });
        this.logger.info(
          `[mDNS] Advertised service "${MDNS_SERVICE_NAME}" on port ${this.wsPort}`
        );
      } catch (err) {
        this.logger.warn({ err }, "[mDNS] Failed to publish Bonjour service, continuing without mDNS");
      }
    }

    this.logger.info(
      `[Emulator] PetBot ESP32-S3 Software Twin Online! WS: port ${this.wsPort}, Dashboard: http://localhost:${this.httpPort}`
    );

    // 4. Auto-pair with Desktop Harness if harnessUrl provided
    if (this.harnessUrl) {
      this.connectToHarness(this.harnessUrl).catch((err) => {
        this.logger.warn(
          { err: err?.message || err },
          "[Harness] Initial auto-pair deferred, will connect when harness daemon is ready"
        );
      });
    }
  }

  private startWebSocketServer(): Promise<void> {
    return new Promise((resolve) => {
      this.wsServer = new WebSocketServer({ port: this.wsPort });

      this.wsServer.on("connection", (socket, req) => {
        const clientIp = req.socket.remoteAddress || "unknown";
        this.logger.info(`[WS] Client paired from ${clientIp}`);
        this.connectedClients.add(socket);

        const parser = new FrameStreamParser();
        parser.onFrame((frame) => {
          this.robot.handleInboundFrame(frame);
          this.notifySseClients();
        });

        socket.on("message", (data) => {
          if (data instanceof Buffer) {
            parser.push(new Uint8Array(data));
          } else if (data instanceof ArrayBuffer) {
            parser.push(new Uint8Array(data));
          }
        });

        socket.on("close", () => {
          this.logger.info(`[WS] Client disconnected from ${clientIp}`);
          this.connectedClients.delete(socket);
          if (this.connectedClients.size === 0) {
            this.robot.onConnectionSevered();
          }
        });

        socket.on("error", (err) => {
          this.logger.warn({ err }, `[WS] Client socket error`);
          this.connectedClients.delete(socket);
          if (this.connectedClients.size === 0) {
            this.robot.onConnectionSevered();
          }
        });
      });

      this.wsServer.on("listening", () => {
        resolve();
      });
    });
  }

  private broadcastBinaryFrame(frame: Uint8Array): void {
    for (const client of this.connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(frame);
      }
    }
    this.notifySseClients();
  }

  private startHttpServer(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // GET /api/status -> JSON Telemetry
        if (url.pathname === "/api/status" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.robot.getTelemetrySnapshot()));
          return;
        }

        // GET /api/framebuffer -> Raw RGBA bytes
        if (url.pathname === "/api/framebuffer" && req.method === "GET") {
          const rgba = this.robot.getFramebufferRgba();
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": rgba.byteLength,
          });
          res.end(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
          return;
        }

        // POST /api/touch (query param or JSON body)
        if (url.pathname === "/api/touch" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            let gesture = (url.searchParams.get("gesture") || "SINGLE_TAP") as TouchGesture;
            if (body) {
              try {
                const parsed = JSON.parse(body);
                if (parsed.gesture) gesture = parsed.gesture;
              } catch {
                // Ignore parse errors, use query param default
              }
            }
            const result = this.robot.triggerTouchGesture(gesture);
            this.notifySseClients();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, gesture, signedResponse: result }));
          });
          return;
        }

        // POST /api/audio-uplink
        if (url.pathname === "/api/audio-uplink" && req.method === "POST") {
          this.robot.injectSyntheticVoiceUplink();
          this.notifySseClients();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, message: "Injected 16kHz audio uplink frame" }));
          return;
        }

        // GET /api/screen-stream -> Server-Sent Events (SSE)
        if (url.pathname === "/api/screen-stream") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(`data: ${JSON.stringify(this.robot.getTelemetrySnapshot())}\n\n`);
          this.sseClients.add(res);

          req.on("close", () => {
            this.sseClients.delete(res);
          });
          return;
        }

        // GET / -> Serve Inspection Dashboard HTML
        if (url.pathname === "/" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(this.renderDashboardHtml());
          return;
        }

        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      });

      this.httpServer.listen(this.httpPort, () => {
        resolve();
      });
    });
  }

  private notifySseClients(): void {
    if (this.sseClients.size === 0) return;
    const telemetry = JSON.stringify(this.robot.getTelemetrySnapshot());
    for (const client of this.sseClients) {
      try {
        client.write(`data: ${telemetry}\n\n`);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  public async connectToHarness(harnessUrl: string): Promise<WebSocket> {
    if (this.harnessClientWs && this.harnessClientWs.readyState === WebSocket.OPEN) {
      return this.harnessClientWs;
    }

    const ws = new WebSocket(harnessUrl);
    const parser = new FrameStreamParser({ zeroCopy: true });

    parser.onFrame((frame) => {
      this.robot.handleInboundFrame(frame);
      this.notifySseClients();
    });

    ws.on("message", (data) => {
      if (Buffer.isBuffer(data)) {
        parser.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } else if (data instanceof ArrayBuffer) {
        parser.push(new Uint8Array(data));
      }
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for Desktop Harness connection"));
      }, 5000);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.harnessClientWs = ws;
        this.logger.info(`[Harness] Connected to Desktop Harness at ${harnessUrl}`);

        const handshake: HelloHandshake = {
          deviceId: this.robot.getTelemetrySnapshot().deviceId,
          firmwareVersion: this.robot.getTelemetrySnapshot().firmwareVersion,
          psramFreeBytes: 6 * 1024 * 1024,
          sdCardCapacityBytes: 32 * 1024 * 1024 * 1024,
          sdCardFreeBytes: 30 * 1024 * 1024 * 1024,
          ed25519PublicKeyHex: this.robot.getPublicKeyHex(),
          capabilities: ["screen_160x128", "audio_i2s_16khz", "touch_2fa", "sd_card"],
        };

        const payload = encodeControlPayload(HelloHandshakeSchema, handshake);
        const frame = encodeFrame(FrameType.HELLO_HANDSHAKE, payload, 1, 0);

        ws.send(frame);
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        this.logger.warn({ err: err?.message || err }, "[Harness] WebSocket client error");
        reject(err);
      });

      ws.on("close", () => {
        this.logger.info("[Harness] Disconnected from Desktop Harness");
        this.harnessClientWs = null;
      });
    });

    if (this.harnessUnsub) {
      this.harnessUnsub();
    }
    this.harnessUnsub = this.robot.addOutboundListener((frame: Uint8Array) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    });

    return ws;
  }

  public async stop(): Promise<void> {
    if (this.harnessUnsub) {
      this.harnessUnsub();
      this.harnessUnsub = null;
    }
    if (this.harnessClientWs) {
      try {
        this.harnessClientWs.close();
      } catch {}
      this.harnessClientWs = null;
    }

    this.robot.dispose();

    if (this.bonjourService) {
      this.bonjourService.stop?.();
    }
    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }

    for (const client of this.connectedClients) {
      client.close();
    }
    this.connectedClients.clear();

    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    if (this.wsServer) {
      await new Promise<void>((resolve) => this.wsServer?.close(() => resolve()));
      this.wsServer = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
      this.httpServer = null;
    }

    this.logger.info("[Emulator] Stopped all servers gracefully");
  }

  public getBoundPorts(): { wsPort: number; httpPort: number } {
    const wsAddr = this.wsServer?.address();
    const httpAddr = this.httpServer?.address();
    const wsPort = typeof wsAddr === "object" && wsAddr ? wsAddr.port : this.wsPort;
    const httpPort = typeof httpAddr === "object" && httpAddr ? httpAddr.port : this.httpPort;
    return { wsPort, httpPort };
  }

  private renderDashboardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PetBot ESP32-S3 Virtual Hardware Twin</title>
  <style>
    :root {
      --bg: #090B0E;
      --card: #14181F;
      --border: #222733;
      --cyan: #00F0FF;
      --emerald: #50FA7B;
      --amber: #FFB020;
      --text: #F0F3F8;
      --text-muted: #8892B0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 32px 16px;
    }
    .container {
      max-width: 900px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(0,240,255,0.1);
      border: 1px solid rgba(0,240,255,0.3);
      color: var(--cyan);
      font-size: 11px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 999px;
      text-transform: uppercase;
      font-family: monospace;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 24px;
    }
    @media(min-width: 768px) {
      .grid { grid-template-columns: 320px 1fr; }
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .screen-wrapper {
      background: #000;
      border: 6px solid #1E232E;
      border-radius: 18px;
      padding: 4px;
      box-shadow: 0 0 24px rgba(0,240,255,0.2);
    }
    canvas {
      display: block;
      width: 256px;
      height: 320px;
      image-rendering: pixelated;
      border-radius: 8px;
      background: #000;
    }
    .controls {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .btn-group {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    button {
      background: #1C222D;
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
      padding: 12px 16px;
      border-radius: 14px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    button:hover {
      background: #262E3D;
      border-color: var(--cyan);
      color: #fff;
      transform: translateY(-1px);
    }
    button:active { transform: translateY(1px); }
    button.primary {
      background: rgba(0,240,255,0.15);
      border-color: rgba(0,240,255,0.4);
      color: var(--cyan);
    }
    .alert-2fa {
      background: rgba(255,176,32,0.15);
      border: 1px solid var(--amber);
      border-radius: 16px;
      padding: 16px;
      width: 100%;
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .telemetry-row {
      display: flex;
      justify-content: space-between;
      width: 100%;
      font-size: 12px;
      font-family: monospace;
      color: var(--text-muted);
      padding: 4px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .telemetry-val { color: #fff; font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <div class="badge">ESP32-S3 Hardware Twin</div>
        <h1 style="font-size: 22px; margin-top: 6px;">PetBot Desktop Hardware Emulator</h1>
      </div>
      <div style="text-align: right; font-family: monospace; font-size: 12px; color: var(--text-muted);">
        <div>WebSocket: <span style="color: var(--cyan);">ws://localhost:${this.wsPort}/ws</span></div>
        <div>mDNS: <span style="color: var(--emerald);">${MDNS_SERVICE_NAME}</span></div>
      </div>
    </header>

    <div class="grid">
      <!-- Left: Live 160x128 Landscape TFT Display -->
      <div class="card">
        <div class="screen-wrapper">
          <canvas id="tftCanvas" width="160" height="128"></canvas>
        </div>
        <div style="font-size: 11px; font-family: monospace; color: var(--text-muted);">
          1.8" TFT ST7735S • 160x128 RGB565
        </div>
      </div>

      <!-- Right: Touch Sensor & Hardware Controls -->
      <div class="card controls" style="align-items: stretch;">
        <div id="banner2Fa" class="alert-2fa">
          <div style="font-weight: bold; color: var(--amber); font-size: 13px;">🔒 Hardware Touch 2FA Required</div>
          <div id="title2Fa" style="font-size: 12px; color: #fff;"></div>
          <div style="font-size: 11px; color: var(--text-muted);">Click [Single Tap] to approve, or [Long Press] to deny.</div>
        </div>

        <div>
          <div style="font-size: 12px; font-weight: bold; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px;">
            Capacitive Touch Sensor Triggers
          </div>
          <div class="btn-group">
            <button class="primary" onclick="triggerGesture('SINGLE_TAP')">👆 Single Tap</button>
            <button onclick="triggerGesture('DOUBLE_TAP')">✌️ Double Tap</button>
            <button onclick="triggerGesture('LONG_PRESS')">⏱️ Long Press</button>
            <button onclick="triggerGesture('PETTING_RAPID')">🐾 Pet Robot</button>
          </div>
        </div>

        <div>
          <div style="font-size: 12px; font-weight: bold; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px;">
            Audio & Testing Actions
          </div>
          <div class="btn-group">
            <button onclick="injectVoice()">🎙️ Push-to-Talk Mic</button>
            <button onclick="fetchStatus()">🔄 Sync Telemetry</button>
          </div>
        </div>

        <div style="margin-top: auto; padding-top: 12px; border-top: 1px solid var(--border);">
          <div class="telemetry-row"><span>Robot Mode</span><span id="telMode" class="telemetry-val">CONNECTED</span></div>
          <div class="telemetry-row"><span>Emotion State</span><span id="telMood" class="telemetry-val">HAPPY</span></div>
          <div class="telemetry-row"><span>Active Widget</span><span id="telWidget" class="telemetry-val">Clock</span></div>
          <div class="telemetry-row"><span>Battery</span><span id="telBattery" class="telemetry-val">98%</span></div>
          <div class="telemetry-row"><span>Viseme Mouth Open</span><span id="telViseme" class="telemetry-val">0</span></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const canvas = document.getElementById('tftCanvas');
    const ctx = canvas.getContext('2d');

    async function updateScreen() {
      try {
        const res = await fetch('/api/framebuffer');
        if (res.ok) {
          const buf = await res.arrayBuffer();
          const rgba = new Uint8ClampedArray(buf);
          const imgData = new ImageData(rgba, 160, 128);
          ctx.putImageData(imgData, 0, 0);
        }
      } catch (err) {
        // Retry
      }
    }

    async function triggerGesture(gesture) {
      await fetch('/api/touch?gesture=' + gesture, { method: 'POST' });
      await updateScreen();
    }

    async function injectVoice() {
      await fetch('/api/audio-uplink', { method: 'POST' });
    }

    async function fetchStatus() {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        updateUI(data);
      }
    }

    function updateUI(data) {
      document.getElementById('telMode').innerText = data.mode === 1 ? 'AGENTIC_CONNECTED' : 'NORMAL_OFFLINE';
      document.getElementById('telMood').innerText = ['IDLE', 'HAPPY', 'CURIOUS', 'SLEEPY', 'FOCUSED'][data.petMood] || 'HAPPY';
      document.getElementById('telWidget').innerText = data.activeWidgetId || 'Builtin';
      document.getElementById('telBattery').innerText = data.batteryPct + '%';
      document.getElementById('telViseme').innerText = data.visemeMouthOpen;

      const banner = document.getElementById('banner2Fa');
      if (data.active2FaChallengeId) {
        banner.style.display = 'flex';
        document.getElementById('title2Fa').innerText = data.active2FaTitle || 'Privileged Action';
      } else {
        banner.style.display = 'none';
      }
    }

    // Connect Server-Sent Events (SSE) for zero-latency screen and telemetry updates
    const sse = new EventSource('/api/screen-stream');
    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        updateUI(data);
        updateScreen();
      } catch {}
    };

    // Polling fallback every 200ms
    setInterval(updateScreen, 200);
    setInterval(fetchStatus, 500);
    fetchStatus();
    updateScreen();
  </script>
</body>
</html>`;
  }
}

export default VirtualRobotServer;
