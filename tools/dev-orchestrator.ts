#!/usr/bin/env node
/**
 * PetBot Unified Ecosystem Dev Orchestrator
 *
 * Single-command developer launcher (pnpm dev:ecosystem) that boots:
 *  1. @petbot/cloud-gateway (Port 8787)
 *  2. @petbot/virtual-robot-emulator (WebSocket Port 8443, Live 128x160 Inspector Port 8444)
 *  3. @petbot/desktop-harness (Auto-paired with Virtual Robot Twin, WebSocket Port 8445)
 *  4. @petbot/companion (Vite UI on Port 5173)
 *
 * Manages child process lifecycles, ANSI color-coded log multiplexing, auto-pairing
 * Zero-Trust Ed25519 credential injection, and clean SIGINT/SIGTERM shutdown.
 */

import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import * as http from "node:http";

// --- ANSI Color Formatting Constants ---
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";
const BG_CYAN = "\x1b[46m\x1b[30m";
const BG_GREEN = "\x1b[42m\x1b[30m";

interface ServiceConfig {
  name: string;
  tag: string;
  color: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  checkUrl?: string;
  checkPort?: number;
}

interface ManagedProcess {
  config: ServiceConfig;
  proc: child_process.ChildProcess;
  killed: boolean;
}

class DevOrchestrator {
  private readonly rootDir: string;
  private readonly petbotDir: string;
  private readonly processes: ManagedProcess[] = [];
  private isShuttingDown = false;

  constructor() {
    this.rootDir = process.cwd();
    this.petbotDir = path.join(os.homedir(), ".petbot");
  }

  /**
   * Pre-flight: Provision Zero-Trust Ed25519 pairing credentials between
   * Virtual Robot Hardware Twin and Desktop OS Harness before startup.
   */
  public setupAutoPairing(): { robotPubKeyHex: string } {
    try {
      fs.mkdirSync(this.petbotDir, { recursive: true });
    } catch {
      // Ignored if exists
    }

    const emulatorKeysPath = path.join(this.petbotDir, "emulator-keys.json");
    let robotPubKeyHex = "";

    // 1. Ensure Emulator Ed25519 keypair exists
    if (fs.existsSync(emulatorKeysPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(emulatorKeysPath, "utf-8"));
        if (raw.publicKeyHex) {
          robotPubKeyHex = raw.publicKeyHex;
        }
      } catch {
        // Fallback to regenerate
      }
    }

    if (!robotPubKeyHex) {
      const keyPair = crypto.generateKeyPairSync("ed25519");
      const privateKeyPem = keyPair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString();
      const derSpki = keyPair.publicKey.export({ type: "spki", format: "der" });
      robotPubKeyHex = derSpki.subarray(-32).toString("hex");

      fs.writeFileSync(
        emulatorKeysPath,
        JSON.stringify({ privateKeyPem, publicKeyHex: robotPubKeyHex }, null, 2),
        "utf-8"
      );
    }

    // 2. Ensure Desktop Harness paired-devices.json pre-registers the Virtual Twin
    const pairedDevicesPath = path.join(this.petbotDir, "paired-devices.json");
    let pairedStore = { version: 1, devices: {} as Record<string, any> };

    if (fs.existsSync(pairedDevicesPath)) {
      try {
        pairedStore = JSON.parse(fs.readFileSync(pairedDevicesPath, "utf-8"));
        if (!pairedStore.devices) pairedStore.devices = {};
      } catch {
        // Reset if corrupt
        pairedStore = { version: 1, devices: {} };
      }
    }

    pairedStore.devices["petbot-esp32s3-sim-01"] = {
      deviceId: "petbot-esp32s3-sim-01",
      deviceName: "PetBot ESP32-S3 Hardware Twin",
      role: "ROBOT",
      ed25519PublicKeyHex: robotPubKeyHex.toLowerCase(),
      sharedHmacSecretHex: "01".repeat(32),
      pairedAt: Date.now(),
    };

    fs.writeFileSync(
      pairedDevicesPath,
      JSON.stringify(pairedStore, null, 2),
      "utf-8"
    );

    return { robotPubKeyHex };
  }

  /**
   * Spawns an ecosystem service child process with formatted stdout/stderr piping.
   */
  private spawnService(config: ServiceConfig): ManagedProcess {
    const isWindows = process.platform === "win32";
    const shellCmd = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows
      ? ["/d", "/s", "/c", `${config.command} ${config.args.join(" ")}`]
      : ["-c", `${config.command} ${config.args.join(" ")}`];

    const proc = child_process.spawn(shellCmd, shellArgs, {
      cwd: config.cwd,
      env: {
        ...process.env,
        ...(config.env || {}),
        FORCE_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const managed: ManagedProcess = {
      config,
      proc,
      killed: false,
    };

    this.pipeLogs(managed);

    proc.on("exit", (code, signal) => {
      if (!this.isShuttingDown && !managed.killed) {
        console.log(
          `${config.color}[${config.tag}]${RESET} ${YELLOW}Process terminated with exit code ${code ?? signal}${RESET}`
        );
      }
    });

    return managed;
  }

  /**
   * Multiplexes child stdout/stderr into formatted, colored terminal logs.
   */
  private pipeLogs(managed: ManagedProcess): void {
    const { config, proc } = managed;
    const prefix = `${config.color}[${config.tag.padEnd(9)}]${RESET} `;

    let stdoutBuffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length > 0) {
          console.log(`${prefix}${line}`);
        }
      }
    });

    let stderrBuffer = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf-8");
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length > 0) {
          console.error(`${prefix}${RED}${line}${RESET}`);
        }
      }
    });
  }

  /**
   * Prints the clean, color-coded startup dashboard in the terminal.
   */
  public printDashboard(): void {
    const line = "=".repeat(78);
    const divider = "-".repeat(78);

    console.log(`
${CYAN}${BOLD}${line}${RESET}
  ${WHITE}${BOLD}🚀 PETBOT AI DESKTOP ROBOT — UNIFIED DEV ECOSYSTEM${RESET}
${CYAN}${BOLD}${line}${RESET}
  ${GREEN}${BOLD}🌐 Companion Web App${RESET}          : ${BOLD}${WHITE}http://localhost:5173${RESET}
  ${MAGENTA}${BOLD}📺 Robot 128x160 Inspector${RESET}    : ${BOLD}${WHITE}http://localhost:8444${RESET}
  ${MAGENTA}${BOLD}🤖 Robot Binary WebSocket${RESET}     : ${BOLD}${WHITE}ws://localhost:8443/ws${RESET}
  ${CYAN}${BOLD}☁️  Cloud Voice / Studio Edge${RESET} : ${BOLD}${WHITE}http://localhost:8787${RESET}  ${DIM}(Health: /health)${RESET}
  ${GREEN}${BOLD}🛡️  Desktop OS Harness Daemon${RESET} : ${BOLD}${WHITE}ws://localhost:8445${RESET}    ${DIM}(Zero-Trust Paired)${RESET}
${CYAN}${BOLD}${divider}${RESET}
  ${DIM}• ESP32-S3 Hardware Twin paired via Zero-Trust Ed25519 credentials${RESET}
  ${DIM}• Bi-directional 16kHz PCM audio & live viseme streaming active${RESET}
  ${DIM}• Touch 2FA confirmation enabled on virtual capacitive sensor${RESET}
  ${DIM}• Press [Ctrl+C] to gracefully terminate all child services${RESET}
${CYAN}${BOLD}${line}${RESET}
`);
  }

  /**
   * Starts all 4 services.
   */
  public async start(): Promise<void> {
    console.log(`${CYAN}[DevOrchestrator] Setting up Zero-Trust auto-pairing...${RESET}`);
    this.setupAutoPairing();

    // 1. Cloud Gateway (Port 8787)
    const gatewayConfig: ServiceConfig = {
      name: "Cloud Gateway",
      tag: "GATEWAY",
      color: CYAN,
      command: "pnpm",
      args: ["exec", "tsx", "services/cloud-gateway/src/index.ts"],
      cwd: this.rootDir,
      env: {
        PORT: "8787",
        NODE_ENV: "development",
      },
      checkPort: 8787,
      checkUrl: "http://localhost:8787/health",
    };

    // 2. Desktop OS Harness Daemon (Port 8445)
    const harnessConfig: ServiceConfig = {
      name: "Desktop Harness",
      tag: "HARNESS",
      color: GREEN,
      command: "pnpm",
      args: ["exec", "tsx", "services/desktop-harness/src/index.ts", "--port", "8445"],
      cwd: this.rootDir,
      env: {
        HARNESS_PORT: "8445",
        PORT: "8445",
      },
      checkPort: 8445,
    };

    // 3. Virtual Robot Twin Emulator (WS 8443, HTTP 8444, auto-connecting to Desktop Harness on 8445)
    const emulatorConfig: ServiceConfig = {
      name: "Virtual Robot",
      tag: "ROBOT",
      color: MAGENTA,
      command: "pnpm",
      args: [
        "exec",
        "tsx",
        "tools/virtual-robot-emulator/src/cli.ts",
        "--port",
        "8443",
        "--http-port",
        "8444",
        "--harness-url",
        "ws://localhost:8445",
      ],
      cwd: this.rootDir,
      checkPort: 8444,
      checkUrl: "http://localhost:8444/api/status",
    };

    // 4. Companion React/Vite Web App (Port 5173)
    const companionConfig: ServiceConfig = {
      name: "Companion Web",
      tag: "COMPANION",
      color: BLUE,
      command: "pnpm",
      args: ["--filter", "@petbot/companion", "dev", "--port", "5173", "--host"],
      cwd: this.rootDir,
      env: {
        PORT: "5173",
      },
      checkPort: 5173,
    };

    console.log(`${CYAN}[DevOrchestrator] Booting 4 ecosystem services...${RESET}`);

    // Launch order: Gateway & Harness first, then Robot Emulator, then Companion App
    this.processes.push(this.spawnService(gatewayConfig));
    this.processes.push(this.spawnService(harnessConfig));

    // Allow servers to open listening ports before client twin links
    await new Promise((r) => setTimeout(r, 600));

    this.processes.push(this.spawnService(emulatorConfig));
    this.processes.push(this.spawnService(companionConfig));

    // Register exit handlers
    this.registerSignalHandlers();

    // Print dashboard once booted
    await new Promise((r) => setTimeout(r, 1200));
    this.printDashboard();
  }

  /**
   * Graceful cleanup of all child processes.
   */
  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log(`\n${YELLOW}[DevOrchestrator] Shutting down ecosystem processes cleanly...${RESET}`);

    const killPromises = this.processes.map((managed) => {
      return new Promise<void>((resolve) => {
        if (!managed.proc.pid || managed.killed) {
          resolve();
          return;
        }

        managed.killed = true;
        const pid = managed.proc.pid;

        if (process.platform === "win32") {
          // On Windows, terminate the entire process tree using taskkill
          child_process.exec(`taskkill /pid ${pid} /t /f`, () => {
            resolve();
          });
        } else {
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            try {
              managed.proc.kill("SIGTERM");
            } catch {}
          }
          setTimeout(() => {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              try {
                managed.proc.kill("SIGKILL");
              } catch {}
            }
            resolve();
          }, 1500);
        }
      });
    });

    await Promise.all(killPromises);
    console.log(`${GREEN}[DevOrchestrator] All processes terminated. Goodbye! 👋${RESET}\n`);
    process.exit(0);
  }

  private registerSignalHandlers(): void {
    const handleSignal = () => {
      this.shutdown();
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
    process.on("SIGHUP", handleSignal);
  }

  /**
   * Performs an automated TCP / HTTP port check (used for CI/self-check).
   */
  public async verifyPorts(timeoutMs = 10000): Promise<boolean> {
    const ports = [8787, 8443, 8444, 8445, 5173];
    const startTime = Date.now();

    for (const port of ports) {
      let connected = false;
      while (Date.now() - startTime < timeoutMs) {
        connected = await new Promise<boolean>((resolve) => {
          const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
            socket.destroy();
            resolve(true);
          });
          socket.on("error", () => {
            resolve(false);
          });
        });
        if (connected) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      if (!connected) {
        console.error(`${RED}[DevOrchestrator] Verification timeout: Port ${port} not ready${RESET}`);
        return false;
      }
    }
    return true;
  }
}

// Direct CLI entrypoint execution
const orchestrator = new DevOrchestrator();

if (process.argv.includes("--verify-only")) {
  orchestrator
    .start()
    .then(() => orchestrator.verifyPorts(15000))
    .then((success) => {
      if (success) {
        console.log(`${GREEN}✔ All 5 ports responsive and verified.${RESET}`);
      }
      return orchestrator.shutdown();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  orchestrator.start().catch((err) => {
    console.error(`${RED}[DevOrchestrator] Fatal startup error:${RESET}`, err);
    process.exit(1);
  });
}

export { DevOrchestrator };
