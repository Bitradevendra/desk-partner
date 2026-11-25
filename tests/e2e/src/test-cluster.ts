import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WebSocket } from "ws";
import {
  RobotMode,
  FrameStreamParser,
  FrameType,
  encodeFrame,
  encodeControlPayload,
  HelloHandshakeSchema,
  type HelloHandshake,
  type DecodedFrame,
} from "@petbot/protocol";
import {
  VirtualRobotServer,
  VirtualEsp32S3Robot,
} from "@petbot/virtual-robot-emulator";
import {
  DesktopHarnessDaemon,
} from "@petbot/desktop-harness";
import {
  createCloudGatewayServer,
  type CloudGatewayServerInstance,
} from "@petbot/cloud-gateway";
import { RobotConnectionManager } from "@petbot/companion";

export interface PetBotTestClusterOptions {
  robotInitialMode?: RobotMode;
  firmwareVersion?: string;
  otaTrustedPublicKey?: string;
}

export class PetBotTestCluster {
  public readonly tempDir: string;
  public readonly sdDir: string;
  public robotServer!: VirtualRobotServer;
  public harnessDaemon!: DesktopHarnessDaemon;
  public cloudGateway!: CloudGatewayServerInstance;
  public cloudGatewayUrl!: string;
  public companion!: RobotConnectionManager;
  private robotHarnessBridge: WebSocket | null = null;
  private robotBridgeUnsub: (() => void) | null = null;

  constructor(private readonly options: PetBotTestClusterOptions = {}) {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot-e2e-"));
    this.sdDir = path.join(this.tempDir, "sd");
    fs.mkdirSync(this.sdDir, { recursive: true });
  }

  public get robot(): VirtualEsp32S3Robot {
    return this.robotServer.robot;
  }

  public async start(): Promise<void> {
    // 1. Initialize Virtual Robot Server on ephemeral ports
    this.robotServer = new VirtualRobotServer({
      wsPort: 0,
      httpPort: 0,
      advertiseBonjour: false,
      sdDirectory: this.sdDir,
      initialMode: this.options.robotInitialMode ?? RobotMode.NORMAL_OFFLINE,
      firmwareVersion: this.options.firmwareVersion ?? "1.0.0-xtensa-lx7",
      otaTrustedPublicKey: this.options.otaTrustedPublicKey,
    });
    await this.robotServer.start();

    // 2. Initialize Desktop Harness Daemon on ephemeral port
    this.harnessDaemon = new DesktopHarnessDaemon({
      port: 0,
      host: "127.0.0.1",
      bonjourEnabled: false,
      allowPairingMode: true,
      enableTelemetryBroadcasting: false,
      osOptions: { mock: true },
      auditLogFilePath: path.join(this.tempDir, "audit.log"),
      workflowsFilePath: path.join(this.tempDir, "workflows.json"),
      vaultOptions: {
        baseDir: this.tempDir,
      },
    });
    await this.harnessDaemon.start();

    // Register Robot's Hardware Ed25519 identity in Harness Vault
    this.harnessDaemon.vault.registerPairedDevice({
      deviceId: this.robot.getTelemetrySnapshot().deviceId,
      deviceName: "PetBot ESP32-S3 Hardware Twin",
      role: "ROBOT",
      ed25519PublicKeyHex: this.robot.getPublicKeyHex(),
      sharedHmacSecretHex: "01".repeat(32),
    });

    // 3. Initialize Cloud Voice & Studio Gateway
    this.cloudGateway = await createCloudGatewayServer({
      port: 0,
      host: "127.0.0.1",
      logger: false,
    });
    this.cloudGatewayUrl = await this.cloudGateway.start(0, "127.0.0.1");

    // 4. Initialize Companion Connection Manager
    this.companion = new RobotConnectionManager();
  }

  /**
   * Connects the Virtual Robot to the Desktop Harness via live WebSocket.
   * Completes Zero-Trust HELLO_HANDSHAKE exchange and verifies active session.
   */
  public async connectRobotToHarness(): Promise<WebSocket> {
    if (this.robotHarnessBridge && this.robotHarnessBridge.readyState === WebSocket.OPEN) {
      return this.robotHarnessBridge;
    }

    const harnessPort = this.harnessDaemon.getBoundPort();
    const ws = new WebSocket(`ws://127.0.0.1:${harnessPort}`);

    const parser = new FrameStreamParser({ zeroCopy: true });

    parser.onFrame((frame: DecodedFrame) => {
      this.robot.handleInboundFrame(frame);
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
        reject(new Error("Timeout waiting for Robot-to-Harness WebSocket connection"));
      }, 5000);

      ws.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Wire outbound frames from robot to harness
    this.robotBridgeUnsub = this.robot.addOutboundListener((frame: Uint8Array) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    });

    // Transmit Robot HELLO_HANDSHAKE to Harness
    const handshake: HelloHandshake = {
      deviceId: this.robot.getTelemetrySnapshot().deviceId,
      firmwareVersion: this.robot.getTelemetrySnapshot().firmwareVersion,
      psramFreeBytes: 6 * 1024 * 1024,
      sdCardCapacityBytes: 32 * 1024 * 1024 * 1024,
      sdCardFreeBytes: 30 * 1024 * 1024 * 1024,
      ed25519PublicKeyHex: this.robot.getPublicKeyHex(),
      capabilities: ["TFT_160X128", "TOUCH_CAP", "I2S_AUDIO", "PSRAM_8MB", "SD_MMC"],
    };
    const payload = encodeControlPayload(HelloHandshakeSchema, handshake);
    const frame = encodeFrame(FrameType.HELLO_HANDSHAKE, payload, 1);
    ws.send(frame);

    // Wait up to 3 seconds for Harness to authenticate the session
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      if (this.harnessDaemon.server.getActiveRobotSession()?.authenticated) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    this.robotHarnessBridge = ws;
    return ws;
  }

  public async stop(): Promise<void> {
    if (this.companion) {
      this.companion.disconnect();
    }

    if (this.robotBridgeUnsub) {
      this.robotBridgeUnsub();
      this.robotBridgeUnsub = null;
    }

    if (this.robotHarnessBridge) {
      try {
        this.robotHarnessBridge.close();
      } catch {
        // ignore
      }
      this.robotHarnessBridge = null;
    }

    if (this.robotServer) {
      await this.robotServer.stop();
    }

    if (this.harnessDaemon) {
      await this.harnessDaemon.stop();
    }

    if (this.cloudGateway) {
      await this.cloudGateway.stop();
    }

    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
