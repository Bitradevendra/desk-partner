/**
 * Cross-Platform Duplex Serial Communicator for ESP32-S3 Physical Robot Bridge
 * Operates reliably on Windows (.NET System.IO.Ports bridge) and POSIX (stty/cat bridge)
 * with zero native compilation / node-gyp requirements.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface SerialCommunicatorOptions {
  port: string;
  baudRate?: number;
  readTimeoutMs?: number;
}

export interface ISerialCommunicator {
  open(): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;
  writeLine(line: string): Promise<void>;
  sendRpcCommand(command: string, timeoutMs?: number, matchPattern?: RegExp): Promise<string>;
  on(event: "line", listener: (line: string) => void): this;
}

/**
 * Universal Native Serial Bridge
 */
export class NativeSerialCommunicator extends EventEmitter implements ISerialCommunicator {
  private readonly port: string;
  private readonly baudRate: number;
  private childProcess: ChildProcess | null = null;
  private openState = false;
  private lineBuffer = "";
  private pendingResolvers: Array<{
    resolve: (val: string) => void;
    reject: (err: Error) => void;
    pattern: RegExp | undefined;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(options: SerialCommunicatorOptions) {
    super();
    this.port = options.port;
    this.baudRate = options.baudRate ?? 115200;
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public async open(): Promise<void> {
    if (this.openState) return;

    return new Promise<void>((resolve, reject) => {
      if (process.platform === "win32") {
        // Windows: Spawn persistent PowerShell worker with .NET SerialPort
        const psScript = `
          $ErrorActionPreference = 'Stop'
          $port = New-Object System.IO.Ports.SerialPort '${this.port}', ${this.baudRate}, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One
          $port.ReadTimeout = 1000
          $port.WriteTimeout = 2000
          $port.DtrEnable = $true
          $port.RtsEnable = $true
          $port.Open()
          [Console]::WriteLine("@@READY@@")

          # Background reader thread
          $run = $true
          $reader = [System.Threading.Thread]::new([System.Threading.ThreadStart]{
            while ($run -and $port.IsOpen) {
              try {
                $line = $port.ReadLine()
                if ($line) { [Console]::WriteLine($line) }
              } catch [System.TimeoutException] {}
                catch { break }
            }
          })
          $reader.Start()

          # Stdin loop for writes
          $stdin = [Console]::In
          while ($true) {
            $cmd = $stdin.ReadLine()
            if ($cmd -eq $null -or $cmd -eq "@@EXIT@@") { break }
            $port.WriteLine($cmd)
          }

          $run = $false
          $port.Close()
        `;

        this.childProcess = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
          stdio: ["pipe", "pipe", "pipe"],
        });

        let ready = false;
        const startupTimeout = setTimeout(() => {
          if (!ready) {
            this.close();
            reject(new Error(`Serial connection to ${this.port} timed out after 5000ms.`));
          }
        }, 5000);

        this.childProcess.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          if (!ready && text.includes("@@READY@@")) {
            ready = true;
            clearTimeout(startupTimeout);
            this.openState = true;
            resolve();
            return;
          }
          this.handleIncomingData(text);
        });

        this.childProcess.stderr?.on("data", (chunk: Buffer) => {
          const errText = chunk.toString("utf-8").trim();
          if (errText.length > 0 && !ready) {
            clearTimeout(startupTimeout);
            reject(new Error(`Serial error on ${this.port}: ${errText}`));
          }
        });

        this.childProcess.on("exit", () => {
          this.openState = false;
          this.childProcess = null;
        });
      } else {
        // POSIX: Linux / macOS using python or bash stty bridge
        const pyScript = `
import sys, serial, threading
port = sys.argv[1]
baud = int(sys.argv[2])
ser = serial.Serial(port, baud, timeout=1.0)
sys.stdout.write("@@READY@@\\n")
sys.stdout.flush()

def reader():
    while ser.is_open:
        try:
            line = ser.readline()
            if line:
                sys.stdout.write(line.decode('utf-8', errors='replace'))
                sys.stdout.flush()
        except:
            break

t = threading.Thread(target=reader, daemon=True)
t.start()

for line in sys.stdin:
    if line.strip() == "@@EXIT@@":
        break
    ser.write((line.strip() + "\\r\\n").encode('utf-8'))
ser.close()
`;
        this.childProcess = spawn("python3", ["-c", pyScript, this.port, String(this.baudRate)], {
          stdio: ["pipe", "pipe", "pipe"],
        });

        let ready = false;
        const startupTimeout = setTimeout(() => {
          if (!ready) {
            this.close();
            reject(new Error(`Serial connection to ${this.port} timed out after 5000ms.`));
          }
        }, 5000);

        this.childProcess.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          if (!ready && text.includes("@@READY@@")) {
            ready = true;
            clearTimeout(startupTimeout);
            this.openState = true;
            resolve();
            return;
          }
          this.handleIncomingData(text);
        });

        this.childProcess.stderr?.on("data", () => {});
        this.childProcess.on("exit", () => {
          this.openState = false;
          this.childProcess = null;
        });
      }
    });
  }

  public async close(): Promise<void> {
    if (this.childProcess && this.openState) {
      try {
        this.childProcess.stdin?.write("@@EXIT@@\n");
      } catch {}
      this.childProcess.kill();
      this.childProcess = null;
    }
    this.openState = false;

    for (const pending of this.pendingResolvers) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Serial port closed"));
    }
    this.pendingResolvers = [];
  }

  public async writeLine(line: string): Promise<void> {
    if (!this.openState || !this.childProcess?.stdin) {
      throw new Error(`Cannot write to serial port ${this.port}: port is not open.`);
    }
    this.childProcess.stdin.write(`${line.trim()}\n`);
  }

  public async sendRpcCommand(
    command: string,
    timeoutMs: number = 3000,
    matchPattern?: RegExp
  ): Promise<string> {
    await this.writeLine(command);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingResolvers.findIndex((p) => p.timer === timer);
        if (idx >= 0) {
          this.pendingResolvers.splice(idx, 1);
        }
        reject(new Error(`Serial RPC command '${command}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pendingResolvers.push({
        resolve,
        reject,
        pattern: matchPattern,
        timer,
      });
    });
  }

  private handleIncomingData(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "@@READY@@") continue;

      this.emit("line", trimmed);

      // Check pending resolvers
      for (let i = 0; i < this.pendingResolvers.length; ++i) {
        const item = this.pendingResolvers[i]!;
        if (!item.pattern || item.pattern.test(trimmed)) {
          clearTimeout(item.timer);
          this.pendingResolvers.splice(i, 1);
          item.resolve(trimmed);
          break;
        }
      }
    }
  }
}

/**
 * Mock Serial Communicator for CI and hardware simulation
 */
export class MockSerialCommunicator extends EventEmitter implements ISerialCommunicator {
  private openState = false;
  private readonly simulatedResponses: Map<string, string> = new Map();

  constructor() {
    super();
    // Default simulated firmware responses
    this.simulatedResponses.set("help", "--- PetBot Serial CLI Commands ---");
    this.simulatedResponses.set("status", "--- PetBot System Status ---\nRobot Mode : AGENTIC_CONNECTED");
    this.simulatedResponses.set("setpin list", "--- PetBot ESP32-S3 Pin Configuration ---");
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public async open(): Promise<void> {
    this.openState = true;
  }

  public async close(): Promise<void> {
    this.openState = false;
  }

  public setMockResponse(commandPrefix: string, response: string): void {
    this.simulatedResponses.set(commandPrefix, response);
  }

  public async writeLine(line: string): Promise<void> {
    if (!this.openState) throw new Error("Mock serial port is not open.");

    setTimeout(() => {
      if (line.startsWith("provision_json")) {
        const resp = JSON.stringify({
          status: "PROVISION_OK",
          ssid: "PetBot_Home_WiFi",
          host: "192.168.1.100",
          port: 8443,
          secretConfigured: true,
          msg: "Credentials persisted to NVS namespace 'petbot_prov'. Connecting immediately.",
        });
        this.emit("line", resp);
      } else if (line.startsWith("setpin")) {
        this.emit("line", "[Pins] Pin configured in NVS namespace 'pins'.");
      } else {
        const matched = Array.from(this.simulatedResponses.entries()).find(([k]) =>
          line.startsWith(k)
        );
        this.emit("line", matched ? matched[1] : `[CLI] Executed: ${line}`);
      }
    }, 20);
  }

  public async sendRpcCommand(
    command: string,
    timeoutMs: number = 3000,
    matchPattern?: RegExp
  ): Promise<string> {
    await this.writeLine(command);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Mock command '${command}' timed out.`));
      }, timeoutMs);

      const handler = (line: string) => {
        if (!matchPattern || matchPattern.test(line)) {
          clearTimeout(timer);
          this.off("line", handler);
          resolve(line);
        }
      };
      this.on("line", handler);
    });
  }
}
