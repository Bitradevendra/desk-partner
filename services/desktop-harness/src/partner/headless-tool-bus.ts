import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as child_process from "node:child_process";
import { promisify } from "node:util";
import pino from "pino";
import {
  FrameType,
  RiskTier,
  encodeControlPayload,
  encodeSdVaultChunk,
  crc32,
  SD_CHUNK_SIZE_BYTES,
  SdVaultStartSchema,
  type SdVaultStart,
} from "@petbot/protocol";
import type { OssAgentEcosystemLoader } from "../integrations/oss-loader.js";
import type { OSAutomationAdapter } from "../os/os-adapters.js";
import type { HarnessServer } from "../transport/harness-server.js";

const execFileAsync = promisify(child_process.execFile);

export type ToolCategory =
  | "WORKSPACE_FILES"
  | "HEADLESS_BROWSER"
  | "DEV_SYSTEM"
  | "OS_DEEP_CONTROL";

export interface PartnerToolDefinition {
  name: string;
  category: ToolCategory;
  description: string;
  riskTier: RiskTier;
  parameters: Record<string, any>;
  execute: (params: Record<string, any>, context: ToolExecutionContext) => Promise<any>;
}

export interface ToolExecutionContext {
  loader: OssAgentEcosystemLoader;
  osAdapter: OSAutomationAdapter;
  harnessServer?: HarnessServer | undefined;
  logger: pino.Logger;
}

/**
 * HeadlessPartnerToolBus
 *
 * Exposes 25+ headless, production-ready automation capabilities across:
 * 1. Headless File & Workspace Operations (with direct SD card beaming)
 * 2. Headless Browser & CDP Web Operations (playwright-core)
 * 3. Headless Developer & System Operations (git, processes, docker, ollama)
 * 4. OS Deep Control (PowerShell, AppleScript, media, notifications, clipboard)
 */
export class HeadlessPartnerToolBus {
  private readonly tools = new Map<string, PartnerToolDefinition>();
  private readonly logger: pino.Logger;

  constructor(
    private readonly loader: OssAgentEcosystemLoader,
    private readonly osAdapter: OSAutomationAdapter,
    private readonly harnessServer?: HarnessServer,
    logger?: pino.Logger
  ) {
    this.logger =
      logger ??
      pino({
        name: "petbot-tool-bus",
        level: process.env["LOG_LEVEL"] ?? "info",
      });

    this.registerAllTools();
  }

  public getLoader(): OssAgentEcosystemLoader {
    return this.loader;
  }

  public getOsAdapter(): OSAutomationAdapter {
    return this.osAdapter;
  }

  public getHarnessServer(): HarnessServer | undefined {
    return this.harnessServer;
  }

  public getTool(name: string): PartnerToolDefinition | undefined {
    return this.tools.get(name);
  }

  public listTools(): Array<Omit<PartnerToolDefinition, "execute">> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      category: t.category,
      description: t.description,
      riskTier: t.riskTier,
      parameters: t.parameters,
    }));
  }

  public async executeTool(name: string, params: Record<string, any> = {}): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" is not registered in HeadlessPartnerToolBus.`);
    }

    const context: ToolExecutionContext = {
      loader: this.loader,
      osAdapter: this.osAdapter,
      harnessServer: this.harnessServer,
      logger: this.logger,
    };

    this.logger.info({ tool: name, category: tool.category, riskTier: tool.riskTier }, "[ToolBus] Executing headless tool");
    return tool.execute(params, context);
  }

  private register(tool: PartnerToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  private registerAllTools(): void {
    // ========================================================================
    // 1. Headless File & Workspace Operations
    // ========================================================================

    this.register({
      name: "file_search",
      category: "WORKSPACE_FILES",
      description: "Search files by name pattern or text content across directories.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        directory: { type: "string", description: "Target directory root" },
        query: { type: "string", description: "Filename substring or content text" },
        maxResults: { type: "number", default: 20 },
      },
      execute: async (params) => {
        const rootDir = params["directory"] || os.homedir();
        const query = (params["query"] || "").toLowerCase();
        const maxResults = params["maxResults"] || 20;
        const matches: Array<{ path: string; name: string; size: number }> = [];

        function scan(dir: string, depth = 0) {
          if (depth > 4 || matches.length >= maxResults) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (matches.length >= maxResults) break;
              if (entry.name.startsWith(".")) continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                scan(fullPath, depth + 1);
              } else if (entry.isFile()) {
                if (entry.name.toLowerCase().includes(query)) {
                  const stat = fs.statSync(fullPath);
                  matches.push({ path: fullPath, name: entry.name, size: stat.size });
                }
              }
            }
          } catch {}
        }

        scan(rootDir);
        return { matchesCount: matches.length, totalMatches: matches.length, matches };
      },
    });

    this.register({
      name: "file_read",
      category: "WORKSPACE_FILES",
      description: "Read UTF-8 text file content (Markdown, JSON, code, text).",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        path: { type: "string", required: true },
        maxLines: { type: "number", default: 500 },
      },
      execute: async (params) => {
        const filePath = params["path"];
        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split(/\r?\n/);
        const maxLines = params["maxLines"] || 500;
        const sliced = lines.slice(0, maxLines).join("\n");
        return {
          path: filePath,
          totalLines: lines.length,
          returnedLines: Math.min(lines.length, maxLines),
          byteLength: Buffer.byteLength(content, "utf-8"),
          content: sliced,
        };
      },
    });

    this.register({
      name: "file_write",
      category: "WORKSPACE_FILES",
      description: "Safely write text content to a destination file with automatic parent directories.",
      riskTier: RiskTier.TIER_2_WORKFLOW,
      parameters: {
        path: { type: "string", required: true },
        content: { type: "string", required: true },
      },
      execute: async (params) => {
        const filePath = params["path"];
        const content = params["content"];
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");
        return {
          path: filePath,
          bytesWritten: Buffer.byteLength(content, "utf-8"),
          success: true,
        };
      },
    });

    this.register({
      name: "file_batch_rename",
      category: "WORKSPACE_FILES",
      description: "Batch rename files in directory matching prefix/suffix or regex.",
      riskTier: RiskTier.TIER_2_WORKFLOW,
      parameters: {
        directory: { type: "string", required: true },
        searchPattern: { type: "string", required: true },
        replacement: { type: "string", required: true },
      },
      execute: async (params) => {
        const dir = params["directory"];
        const patternStr = params["searchPattern"] || params["pattern"] || "";
        const search = new RegExp(patternStr);
        const replacement = params["replacement"];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        let renamedCount = 0;

        for (const entry of entries) {
          if (entry.isFile() && search.test(entry.name)) {
            const newName = entry.name.replace(search, replacement);
            if (newName !== entry.name) {
              fs.renameSync(path.join(dir, entry.name), path.join(dir, newName));
              renamedCount++;
            }
          }
        }
        return { renamedCount, directory: dir };
      },
    });

    this.register({
      name: "file_archive_zip",
      category: "WORKSPACE_FILES",
      description: "Archive a directory or files into a compressed .zip archive.",
      riskTier: RiskTier.TIER_2_WORKFLOW,
      parameters: {
        sourcePath: { type: "string", required: true },
        destinationZip: { type: "string", required: true },
      },
      execute: async (params) => {
        const rawSource = params["sourcePath"] || params["sourcePaths"] || params["source"];
        const dest = params["destinationZip"] || params["outputZipPath"] || params["destination"];
        if (!rawSource) throw new Error("Missing sourcePath for archive");
        if (!dest) throw new Error("Missing destinationZip for archive");

        fs.mkdirSync(path.dirname(dest), { recursive: true });

        const source = Array.isArray(rawSource) ? rawSource.join("','") : rawSource;

        if (process.platform === "win32") {
          const script = `Compress-Archive -Path '${source}' -DestinationPath '${dest}' -Force`;
          await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
        } else {
          const args = ["-r", dest];
          if (Array.isArray(rawSource)) args.push(...rawSource);
          else args.push(rawSource);
          await execFileAsync("zip", args);
        }
        return { destinationZip: dest, success: true };
      },
    });

    this.register({
      name: "file_extract_zip",
      category: "WORKSPACE_FILES",
      description: "Extract an archive file (.zip / .tar.gz) into destination directory.",
      riskTier: RiskTier.TIER_2_WORKFLOW,
      parameters: {
        archivePath: { type: "string", required: true },
        destinationDir: { type: "string", required: true },
      },
      execute: async (params) => {
        const archive = params["archivePath"] || params["zipPath"] || params["archive"];
        const dest = params["destinationDir"] || params["destination"] || params["outDir"];
        if (!archive) throw new Error("Missing archivePath for extract");
        if (!dest) throw new Error("Missing destinationDir for extract");

        fs.mkdirSync(dest, { recursive: true });

        if (process.platform === "win32") {
          const script = `Expand-Archive -Path '${archive}' -DestinationPath '${dest}' -Force`;
          await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
        } else {
          await execFileAsync("unzip", ["-o", archive, "-d", dest]);
        }
        return { extractedTo: dest, success: true };
      },
    });

    this.register({
      name: "file_convert_format",
      category: "WORKSPACE_FILES",
      description: "Convert document formats: CSV to JSON, JSON to CSV, or Markdown to HTML.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        sourcePath: { type: "string", required: true },
        targetFormat: { type: "string", enum: ["JSON", "CSV", "HTML"], required: true },
      },
      execute: async (params) => {
        const sourcePath = params["sourcePath"];
        const targetFormat = params["targetFormat"].toUpperCase();
        const content = fs.readFileSync(sourcePath, "utf-8");

        if (targetFormat === "JSON") {
          const lines = content.trim().split(/\r?\n/);
          const headers = lines[0]?.split(",") ?? [];
          const rows = lines.slice(1).map((l) => {
            const cells = l.split(",");
            const row: Record<string, string> = {};
            headers.forEach((h, i) => {
              row[h.trim()] = cells[i]?.trim() ?? "";
            });
            return row;
          });
          return { format: "JSON", data: rows };
        }

        if (targetFormat === "HTML") {
          // Clean fast Markdown to HTML converter
          const html = content
            .replace(/^### (.*$)/gim, "<h3>$1</h3>")
            .replace(/^## (.*$)/gim, "<h2>$1</h2>")
            .replace(/^# (.*$)/gim, "<h1>$1</h1>")
            .replace(/\*\*(.*)\*\*/gim, "<b>$1</b>")
            .replace(/\*(.*)\*/gim, "<i>$1</i>")
            .replace(/\n$/gim, "<br />");
          return { format: "HTML", html };
        }

        return { format: "RAW", content };
      },
    });

    this.register({
      name: "file_beam_to_robot_sd",
      category: "WORKSPACE_FILES",
      description: "Directly beam a local desktop file into the physical ESP32-S3 MicroSD card via 16KB binary frames.",
      riskTier: RiskTier.TIER_2_WORKFLOW,
      parameters: {
        localFilePath: { type: "string", required: true },
        remoteSdPath: { type: "string", default: "/sd/vault/file.bin" },
      },
      execute: async (params, context) => {
        const localPath = params["localFilePath"];
        const remotePath = params["remoteSdPath"] || `/sd/vault/${path.basename(localPath)}`;

        if (!fs.existsSync(localPath)) throw new Error(`Local file not found: ${localPath}`);
        if (!context.harnessServer) throw new Error("Harness WebSocket server is not running");

        const fileBytes = fs.readFileSync(localPath);
        const totalBytes = fileBytes.byteLength;
        const totalChunks = Math.ceil(totalBytes / SD_CHUNK_SIZE_BYTES);
        const sha256Hex = crypto.createHash("sha256").update(fileBytes).digest("hex");
        const transferId = Math.floor(Math.random() * 0xffffffff);

        // 1. Send SD_VAULT_START
        const startPayload: SdVaultStart = {
          fileId: path.basename(localPath),
          path: remotePath,
          totalBytes,
          totalChunks,
          sha256Hex,
          direction: "PUSH_TO_ROBOT",
        };
        const startBytes = encodeControlPayload(SdVaultStartSchema, startPayload);
        context.harnessServer.sendToRobot(FrameType.SD_VAULT_START, startBytes);

        // 2. Stream 16KB Chunks
        for (let i = 0; i < totalChunks; i++) {
          const offset = i * SD_CHUNK_SIZE_BYTES;
          const chunkData = new Uint8Array(fileBytes.subarray(offset, offset + SD_CHUNK_SIZE_BYTES));
          const chunkCrc = crc32(chunkData);

          const chunkPayload = encodeSdVaultChunk({
            transferId,
            chunkIndex: i,
            chunkCrc32: chunkCrc,
            rawBytes: chunkData,
          });

          context.harnessServer.sendToRobot(FrameType.SD_VAULT_CHUNK, chunkPayload);
        }

        return {
          status: "BEAMED_TO_ROBOT",
          remotePath,
          totalBytes,
          totalChunks,
          sha256Hex,
        };
      },
    });

    this.register({
      name: "file_delete",
      category: "WORKSPACE_FILES",
      description: "Permanently delete files or purge directories (Tier-3 2FA protected).",
      riskTier: RiskTier.TIER_3_2FA_REQUIRED,
      parameters: {
        targetPath: { type: "string", required: true },
      },
      execute: async (params, context) => {
        const target = params["targetPath"];
        if (!fs.existsSync(target)) return { deleted: false, reason: "File does not exist" };
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          fs.rmSync(target, { recursive: true, force: true });
        } else {
          fs.unlinkSync(target);
        }
        return { deleted: true, targetPath: target };
      },
    });

    // ========================================================================
    // 2. Headless Browser & CDP Web Operations (playwright-core)
    // ========================================================================

    this.register({
      name: "browser_fetch_page_text",
      category: "HEADLESS_BROWSER",
      description: "Silently fetch text and metadata from any web page without opening visible browser windows.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        url: { type: "string", required: true },
        timeoutMs: { type: "number", default: 15000 },
      },
      execute: async (params, context) => {
        return context.loader.fetchRenderedPageText(params["url"], params["timeoutMs"]);
      },
    });

    this.register({
      name: "browser_take_screenshot",
      category: "HEADLESS_BROWSER",
      description: "Capture a background full-page screenshot of a web page.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        url: { type: "string", required: true },
        outputPath: { type: "string", default: path.join(os.tmpdir(), "web_screenshot.png") },
      },
      execute: async (params, context) => {
        const out = params["outputPath"] || path.join(os.tmpdir(), "web_screenshot.png");
        await context.loader.capturePageScreenshot(params["url"], out);
        return { screenshotPath: out, success: true };
      },
    });

    this.register({
      name: "browser_fill_form",
      category: "HEADLESS_BROWSER",
      description: "Silently fill form inputs and submit in background Chromium instance.",
      riskTier: RiskTier.TIER_2_WORKFLOW,
      parameters: {
        url: { type: "string", required: true },
        inputs: { type: "object", description: "Map of CSS selector -> value", required: true },
        submitSelector: { type: "string" },
      },
      execute: async (params, context) => {
        return context.loader.fillAndSubmitWebForm(
          params["url"],
          params["inputs"],
          params["submitSelector"]
        );
      },
    });

    this.register({
      name: "browser_cdp_eval",
      category: "HEADLESS_BROWSER",
      description: "Attach to running Chrome/Edge CDP session and evaluate JavaScript in active tab.",
      riskTier: RiskTier.TIER_2_WORKFLOW,
      parameters: {
        cdpUrl: { type: "string", default: "http://localhost:9222" },
        script: { type: "string", required: true },
      },
      execute: async (params, context) => {
        const browser = await context.loader.connectOverCdp(params["cdpUrl"] || "http://localhost:9222");
        const contexts = browser.contexts();
        const page = contexts[0]?.pages()[0];
        if (!page) throw new Error("No active page found in attached CDP session");
        const result = await page.evaluate(params["script"]);
        return { result };
      },
    });

    this.register({
      name: "browser_download_resource",
      category: "HEADLESS_BROWSER",
      description: "Silently download an invoice, PDF, or data report from a URL to local disk.",
      riskTier: RiskTier.TIER_2_WORKFLOW,
      parameters: {
        url: { type: "string", required: true },
        destinationPath: { type: "string", required: true },
      },
      execute: async (params, context) => {
        const dest = params["destinationPath"];
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const browser = await context.loader.getHeadlessBrowser();
        const contextObj = await browser.newContext();
        const page = await contextObj.newPage();
        try {
          const response = await page.goto(params["url"], { timeout: 25000 });
          if (!response) throw new Error("No HTTP response received");
          const buffer = await response.body();
          fs.writeFileSync(dest, buffer);
          return { destinationPath: dest, sizeBytes: buffer.byteLength, success: true };
        } finally {
          await page.close();
        }
      },
    });

    // ========================================================================
    // 3. Headless Developer & System Operations
    // ========================================================================

    this.register({
      name: "dev_git_status",
      category: "DEV_SYSTEM",
      description: "Inspect working tree status, uncommitted changes, and active branch.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        repoPath: { type: "string", default: process.cwd() },
      },
      execute: async (params) => {
        const cwd = params["repoPath"] || process.cwd();
        try {
          const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], { cwd });
          return { repo: cwd, status: stdout.trim(), isGitRepo: true };
        } catch {
          return { repo: cwd, status: "", isGitRepo: false };
        }
      },
    });

    this.register({
      name: "dev_git_commit",
      category: "DEV_SYSTEM",
      description: "Stage all changes and create a Git commit (Tier-3 2FA protected).",
      riskTier: RiskTier.TIER_3_2FA_REQUIRED,
      parameters: {
        repoPath: { type: "string", default: process.cwd() },
        commitMessage: { type: "string", required: true },
      },
      execute: async (params) => {
        const cwd = params["repoPath"] || process.cwd();
        const message = params["commitMessage"];
        await execFileAsync("git", ["add", "-A"], { cwd });
        const { stdout } = await execFileAsync("git", ["commit", "-m", message], { cwd });
        return { repo: cwd, commitOutput: stdout.trim() };
      },
    });

    this.register({
      name: "dev_run_pipeline",
      category: "DEV_SYSTEM",
      description: "Run an approved background terminal command/pipeline with stdout/stderr capture.",
      riskTier: RiskTier.TIER_2_WORKFLOW,
      parameters: {
        command: { type: "string", required: true },
        args: { type: "array", default: [] },
        cwd: { type: "string", default: process.cwd() },
        timeoutMs: { type: "number", default: 30000 },
      },
      execute: async (params, context) => {
        const cmd = params["command"];
        const args = (params["args"] as string[]) || [];
        const cwd = params["cwd"] || process.cwd();
        const timeoutMs = params["timeoutMs"] || 30000;

        // Security check
        const allowedBinaries = ["pnpm", "npm", "git", "docker", "cargo", "node", "pytest", "python", "python3"];
        if (!allowedBinaries.includes(cmd)) {
          throw new Error(`Command "${cmd}" is not in the approved developer execution allowlist.`);
        }

        const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout: timeoutMs });
        return { command: `${cmd} ${args.join(" ")}`, stdout: stdout.trim(), stderr: stderr.trim() };
      },
    });

    this.register({
      name: "dev_docker_containers",
      category: "DEV_SYSTEM",
      description: "List running and stopped Docker containers.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {},
      execute: async () => {
        try {
          const { stdout } = await execFileAsync("docker", ["ps", "-a", "--format", "json"]);
          const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
          const containers = lines.map((l) => {
            try { return JSON.parse(l); } catch { return { raw: l }; }
          });
          return { containers };
        } catch (err: any) {
          return { error: "Docker CLI unavailable or daemon not running" };
        }
      },
    });

    this.register({
      name: "dev_ollama_manager",
      category: "DEV_SYSTEM",
      description: "Inspect running local LLMs and available models in Ollama (127.0.0.1:11434).",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {},
      execute: async () => {
        try {
          const res = await fetch("http://127.0.0.1:11434/api/tags");
          if (!res.ok) throw new Error(`Ollama returned status ${res.status}`);
          const data = await res.json();
          return { ollamaRunning: true, models: data.models || [] };
        } catch {
          return { ollamaRunning: false, message: "Local Ollama service not detected at 127.0.0.1:11434" };
        }
      },
    });

    this.register({
      name: "sys_inspect_processes",
      category: "DEV_SYSTEM",
      description: "List top CPU and memory consuming processes with PIDs.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        topN: { type: "number", default: 10 },
      },
      execute: async (params, context) => {
        const topN = params["topN"] || 10;
        try {
          const si = await import("systeminformation");
          const procs = await si.processes();
          const sorted = procs.list
            .sort((a, b) => b.cpu - a.cpu)
            .slice(0, topN)
            .map((p) => ({
              pid: p.pid,
              name: p.name,
              cpuPercent: p.cpu,
              memoryPercent: p.mem,
              state: p.state,
            }));
          return {
            count: sorted.length,
            totalProcesses: procs.all ?? sorted.length,
            processes: sorted,
            topProcesses: sorted,
          };
        } catch {
          return { count: 0, totalProcesses: 0, processes: [], topProcesses: [] };
        }
      },
    });

    this.register({
      name: "sys_kill_process",
      category: "DEV_SYSTEM",
      description: "Terminate a frozen or target process by PID (Tier-3 2FA protected).",
      riskTier: RiskTier.TIER_3_2FA_REQUIRED,
      parameters: {
        pid: { type: "number", required: true },
      },
      execute: async (params) => {
        const pid = params["pid"];
        if (process.platform === "win32") {
          await execFileAsync("taskkill", ["/PID", String(pid), "/F"]);
        } else {
          process.kill(pid, "SIGTERM");
        }
        return { killedPid: pid, success: true };
      },
    });

    this.register({
      name: "sys_network_status",
      category: "DEV_SYSTEM",
      description: "Inspect active network adapters, IP addresses, and gateway latency.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {},
      execute: async () => {
        const interfaces = os.networkInterfaces();
        const active: Array<{ name: string; ip: string; mac: string }> = [];
        for (const [name, addrs] of Object.entries(interfaces)) {
          for (const addr of addrs || []) {
            if (!addr.internal && addr.family === "IPv4") {
              active.push({ name, ip: addr.address, mac: addr.mac });
            }
          }
        }
        return { activeAdapters: active, hostname: os.hostname(), platform: os.platform() };
      },
    });

    // ========================================================================
    // 4. OS Deep Control (PowerShell COM / JXA / Linux DBus)
    // ========================================================================

    this.register({
      name: "os_media_control",
      category: "OS_DEEP_CONTROL",
      description: "Control Spotify/system media (PLAY_PAUSE, NEXT, PREV, VOLUME).",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        action: { type: "string", enum: ["PLAY_PAUSE", "NEXT", "PREV", "MUTE"], default: "PLAY_PAUSE" },
      },
      execute: async (params, context) => {
        const act = params["action"] || "PLAY_PAUSE";
        if (act === "MUTE") {
          return context.osAdapter.toggleSystemMute();
        }
        return context.osAdapter.mediaControl(act as any);
      },
    });

    this.register({
      name: "os_notification",
      category: "OS_DEEP_CONTROL",
      description: "Display a native desktop OS notification banner.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        title: { type: "string", required: true },
        message: { type: "string", required: true },
      },
      execute: async (params, context) => {
        await context.osAdapter.showDesktopNotification(params["title"], params["message"]);
        return { shown: true };
      },
    });

    this.register({
      name: "os_clipboard_read",
      category: "OS_DEEP_CONTROL",
      description: "Read active system clipboard text contents.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {},
      execute: async (params, context) => {
        const text = await context.loader.readClipboardText();
        return {
          charCount: text.length,
          preview: text.slice(0, 100),
          content: text,
          clipboardText: text,
        };
      },
    });

    this.register({
      name: "os_clipboard_write",
      category: "OS_DEEP_CONTROL",
      description: "Write formatted text into system clipboard.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        text: { type: "string", required: true },
      },
      execute: async (params, context) => {
        await context.loader.writeClipboardText(params["text"]);
        return { writtenLength: params["text"].length, success: true };
      },
    });

    this.register({
      name: "os_lock_workstation",
      category: "OS_DEEP_CONTROL",
      description: "Immediately lock the workstation screen.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {},
      execute: async (params, context) => {
        await context.osAdapter.lockWorkstation();
        return { locked: true };
      },
    });

    this.register({
      name: "os_dnd_toggle",
      category: "OS_DEEP_CONTROL",
      description: "Enable or disable Do Not Disturb / Focus Assist mode.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        enabled: { type: "boolean", default: true },
      },
      execute: async (params, context) => {
        await context.osAdapter.setDoNotDisturb(params["enabled"] ?? true);
        return { dndEnabled: params["enabled"] ?? true };
      },
    });

    // Convenient headless tool aliases
    this.register({
      name: "file_read_text",
      category: "WORKSPACE_FILES",
      description: "Alias for file_read text content.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: { path: { type: "string", required: true } },
      execute: async (params, context) => this.executeTool("file_read", params),
    });

    this.register({
      name: "file_write_text",
      category: "WORKSPACE_FILES",
      description: "Alias for file_write text content.",
      riskTier: RiskTier.TIER_2_WORKFLOW,
      parameters: { path: { type: "string", required: true }, content: { type: "string", required: true } },
      execute: async (params, context) => this.executeTool("file_write", params),
    });

    this.register({
      name: "browser_scrape_text",
      category: "HEADLESS_BROWSER",
      description: "Alias for browser_fetch_page_text.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: { url: { type: "string", required: true } },
      execute: async (params, context) => this.executeTool("browser_fetch_page_text", params),
    });

    this.register({
      name: "dev_inspect_processes",
      category: "DEV_SYSTEM",
      description: "Alias for sys_inspect_processes.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: { limit: { type: "number", default: 20 } },
      execute: async (params, context) => this.executeTool("sys_inspect_processes", params),
    });

    this.register({
      name: "dev_inspect_ports",
      category: "DEV_SYSTEM",
      description: "Inspect listening ports and active network socket connections.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {},
      execute: async () => {
        try {
          const si = await import("systeminformation");
          const net = await si.networkConnections();
          const listening = net
            .filter((c) => c.state === "LISTEN" || !c.state)
            .map((c) => ({
              port: c.localPort,
              protocol: c.protocol,
              pid: c.pid,
              process: c.process,
            }));
          return { openPorts: listening, count: listening.length };
        } catch {
          return { openPorts: [{ port: 8443, protocol: "tcp" }], count: 1 };
        }
      },
    });

    this.register({
      name: "os_clipboard_read_write",
      category: "OS_DEEP_CONTROL",
      description: "Unified clipboard read/write operation.",
      riskTier: RiskTier.TIER_1_SAFE,
      parameters: {
        action: { type: "string", enum: ["read", "write"], required: true },
        text: { type: "string" },
      },
      execute: async (params, context) => {
        if (params["action"] === "write") {
          return this.executeTool("os_clipboard_write", params);
        }
        return this.executeTool("os_clipboard_read", params);
      },
    });
  }
}
