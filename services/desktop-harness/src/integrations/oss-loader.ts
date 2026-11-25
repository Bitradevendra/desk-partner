import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { EventEmitter } from "node:events";
import pino from "pino";

// Open-source ecosystem libraries
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import chokidar, { type FSWatcher } from "chokidar";
import cron, { type ScheduledTask } from "node-cron";
import clipboardy from "clipboardy";

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpToolCallResult {
  isError?: boolean | undefined;
  content: Array<{
    type: string;
    text?: string | undefined;
    data?: string | undefined;
    mimeType?: string | undefined;
  }>;
}

export interface McpToolDefinition {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, any>;
}

export interface CronRegistration {
  id: string;
  expression: string;
  description: string;
  lastRun?: number | undefined;
  runCount: number;
  task: ScheduledTask;
}

export interface OssLoaderOptions {
  logger?: pino.Logger | undefined;
  vendorDir?: string | undefined;
}

/**
 * Open-Source Agent Ecosystem Loader & Manager
 *
 * Coordinates Model Context Protocol (MCP) clients, Playwright headless browser sessions,
 * Chokidar filesystem watchers, Node-Cron automation schedulers, Clipboardy,
 * and optional Python AI sidecars (open-interpreter / browser-use).
 */
export class OssAgentEcosystemLoader extends EventEmitter {
  private readonly logger: pino.Logger;
  private readonly vendorDir: string;
  private readonly mcpClients = new Map<string, { client: Client; transport: StdioClientTransport }>();
  private headlessBrowser: Browser | null = null;
  private browserContext: BrowserContext | null = null;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly crons = new Map<string, CronRegistration>();
  private pythonSidecarProcess: child_process.ChildProcess | null = null;

  constructor(options?: OssLoaderOptions) {
    super();
    this.logger =
      options?.logger ??
      pino({
        name: "petbot-oss-loader",
        level: process.env["LOG_LEVEL"] ?? "info",
      });

    this.vendorDir =
      options?.vendorDir ??
      path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "../../vendor");
  }

  // ============================================================================
  // 1. Model Context Protocol (MCP) Integration
  // ============================================================================

  /**
   * Connects to an external or reference MCP server over stdio.
   */
  public async connectMcpServer(
    name: string,
    config: McpServerConfig
  ): Promise<Client> {
    if (this.mcpClients.has(name)) {
      return this.mcpClients.get(name)!.client;
    }

    this.logger.info({ server: name, command: config.command }, "[MCP] Launching stdio MCP client");

    const envMap: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (val !== undefined) {
        envMap[key] = val;
      }
    }
    if (config.env) {
      Object.assign(envMap, config.env);
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: envMap,
    });

    const client = new Client(
      {
        name: `petbot-partner-${name}`,
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    try {
      await client.connect(transport);
      this.mcpClients.set(name, { client, transport });
      this.logger.info({ server: name }, "[MCP] Connected successfully to MCP server");
      return client;
    } catch (err: any) {
      this.logger.warn(
        { server: name, err: err?.message || err },
        "[MCP] Failed to connect to external stdio MCP server. Native fallback will handle calls."
      );
      throw err;
    }
  }

  /**
   * Lists available tools from a registered MCP server.
   */
  public async listMcpTools(serverName: string): Promise<McpToolDefinition[]> {
    const entry = this.mcpClients.get(serverName);
    if (!entry) {
      return this.getNativeFallbackTools(serverName);
    }

    try {
      const response = await entry.client.listTools();
      return response.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, any>) || {},
      }));
    } catch (err: any) {
      this.logger.warn({ server: serverName, err: err?.message }, "[MCP] Failed listing remote tools, using fallback");
      return this.getNativeFallbackTools(serverName);
    }
  }

  /**
   * Invokes an MCP tool with structured arguments.
   */
  public async callMcpTool(
    serverName: string,
    toolName: string,
    args: Record<string, any>
  ): Promise<McpToolCallResult> {
    const entry = this.mcpClients.get(serverName);
    if (entry) {
      try {
        const result = await entry.client.callTool({
          name: toolName,
          arguments: args,
        });
        return {
          isError: Boolean(result.isError),
          content: result.content as McpToolCallResult["content"],
        };
      } catch (err: any) {
        this.logger.warn({ server: serverName, tool: toolName, err: err?.message }, "[MCP] Remote call failed, using native fallback");
      }
    }

    // Native in-process zero-GUI fallback execution for core MCP tools
    return this.executeNativeFallbackTool(serverName, toolName, args);
  }

  private getNativeFallbackTools(serverName: string): McpToolDefinition[] {
    if (serverName === "filesystem") {
      return [
        { name: "read_file", description: "Read complete text file content", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
        { name: "write_file", description: "Write text content to file", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
        { name: "list_directory", description: "List files and subdirectories", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
        { name: "search_files", description: "Search files matching pattern", inputSchema: { type: "object", properties: { directory: { type: "string" }, pattern: { type: "string" } }, required: ["directory", "pattern"] } },
      ];
    }
    if (serverName === "sequential-thinking") {
      return [
        { name: "sequentialthinking", description: "Step-by-step reasoning thought trace", inputSchema: { type: "object", properties: { thought: { type: "string" }, thoughtNumber: { type: "number" } } } },
      ];
    }
    return [];
  }

  private async executeNativeFallbackTool(
    serverName: string,
    toolName: string,
    args: Record<string, any>
  ): Promise<McpToolCallResult> {
    try {
      if (serverName === "filesystem") {
        if (toolName === "read_file" && typeof args["path"] === "string") {
          const content = fs.readFileSync(args["path"], "utf-8");
          return { content: [{ type: "text", text: content }] };
        }
        if (toolName === "write_file" && typeof args["path"] === "string" && typeof args["content"] === "string") {
          fs.mkdirSync(path.dirname(args["path"]), { recursive: true });
          fs.writeFileSync(args["path"], args["content"], "utf-8");
          return { content: [{ type: "text", text: `Successfully wrote ${args["content"].length} bytes to ${args["path"]}` }] };
        }
        if (toolName === "list_directory" && typeof args["path"] === "string") {
          const items = fs.readdirSync(args["path"], { withFileTypes: true }).map((d) => `${d.isDirectory() ? "[DIR]" : "[FILE]"} ${d.name}`);
          return { content: [{ type: "text", text: items.join("\n") }] };
        }
      }

      if (serverName === "sequential-thinking" && toolName === "sequentialthinking") {
        return { content: [{ type: "text", text: `[Thought ${args["thoughtNumber"] ?? 1}] ${args["thought"] ?? "Processed"}` }] };
      }

      return {
        isError: true,
        content: [{ type: "text", text: `Tool ${serverName}::${toolName} not supported in native fallback.` }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Native fallback execution failed: ${err?.message || err}` }],
      };
    }
  }

  // ============================================================================
  // 2. Headless Browser & CDP Web Automation (playwright-core)
  // ============================================================================

  /**
   * Lazily launches a background headless Chromium instance.
   * Runs completely headless with no foreground GUI window or mouse cursor takeover.
   */
  public async getHeadlessBrowser(): Promise<Browser> {
    if (!this.headlessBrowser) {
      this.logger.info("[Browser] Launching background headless Chromium instance");
      this.headlessBrowser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--disable-gpu",
        ],
      });
      this.browserContext = await this.headlessBrowser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
      });
    }
    return this.headlessBrowser;
  }

  /**
   * Connects to an existing Chrome/Edge profile via Chrome DevTools Protocol (CDP).
   */
  public async connectOverCdp(cdpUrl = "http://localhost:9222"): Promise<Browser> {
    this.logger.info({ cdpUrl }, "[Browser] Attaching to existing browser session via CDP");
    return chromium.connectOverCDP(cdpUrl);
  }

  /**
   * Fetches text content and rendered elements from any web page silently in background.
   */
  public async fetchRenderedPageText(url: string, timeoutMs = 15000): Promise<{ title: string; content: string }> {
    await this.getHeadlessBrowser();
    const page = await this.browserContext!.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      const title = await page.title();
      const content = await page.evaluate(() => {
        const body = document.body;
        return body ? body.innerText.slice(0, 50000) : "";
      });
      return { title, content };
    } finally {
      await page.close();
    }
  }

  /**
   * Captures a silent full-page screenshot in the background.
   */
  public async capturePageScreenshot(url: string, outputPath: string): Promise<string> {
    await this.getHeadlessBrowser();
    const page = await this.browserContext!.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      await page.screenshot({ path: outputPath, fullPage: true });
      return outputPath;
    } finally {
      await page.close();
    }
  }

  /**
   * Executes a headless fill-and-submit workflow on web forms (e.g., invoices, searches).
   */
  public async fillAndSubmitWebForm(
    url: string,
    inputs: Record<string, string>,
    submitSelector?: string
  ): Promise<{ status: string; currentUrl: string }> {
    await this.getHeadlessBrowser();
    const page = await this.browserContext!.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      for (const [selector, value] of Object.entries(inputs)) {
        await page.fill(selector, value);
      }
      if (submitSelector) {
        await page.click(submitSelector);
        await page.waitForLoadState("domcontentloaded");
      }
      return { status: "COMPLETED", currentUrl: page.url() };
    } finally {
      await page.close();
    }
  }

  // ============================================================================
  // 3. Real-Time Filesystem Watcher (chokidar)
  // ============================================================================

  /**
   * Watches a directory for file additions, mutations, or deletions.
   */
  public watchDirectory(
    dirPath: string,
    callback: (event: "add" | "change" | "unlink", filePath: string) => void
  ): FSWatcher {
    if (this.watchers.has(dirPath)) {
      return this.watchers.get(dirPath)!;
    }

    this.logger.info({ dirPath }, "[Watcher] Starting real-time filesystem monitor");
    const watcher = chokidar.watch(dirPath, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
      depth: 3,
    });

    watcher.on("add", (fp) => callback("add", fp));
    watcher.on("change", (fp) => callback("change", fp));
    watcher.on("unlink", (fp) => callback("unlink", fp));

    this.watchers.set(dirPath, watcher);
    return watcher;
  }

  public async unwatchDirectory(dirPath: string): Promise<void> {
    const watcher = this.watchers.get(dirPath);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(dirPath);
      this.logger.info({ dirPath }, "[Watcher] Stopped filesystem monitor");
    }
  }

  // ============================================================================
  // 4. Persistent Automation Scheduler (node-cron)
  // ============================================================================

  /**
   * Registers a persistent cron automation task.
   */
  public scheduleAutomation(
    id: string,
    expression: string,
    description: string,
    taskFn: () => Promise<void>
  ): boolean {
    if (this.crons.has(id)) {
      this.crons.get(id)!.task.stop();
    }

    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression format: ${expression}`);
    }

    const registration: CronRegistration = {
      id,
      expression,
      description,
      runCount: 0,
      task: cron.schedule(expression, async () => {
        registration.lastRun = Date.now();
        registration.runCount++;
        this.logger.info({ id, runCount: registration.runCount }, "[Cron] Executing scheduled automation");
        try {
          await taskFn();
        } catch (err: any) {
          this.logger.error({ id, err: err?.message }, "[Cron] Error during scheduled automation");
        }
      }),
    };

    this.crons.set(id, registration);
    this.logger.info({ id, expression, description }, "[Cron] Registered automation task");
    return true;
  }

  public listAutomations(): Array<{ id: string; expression: string; description: string; runCount: number; lastRun?: number | undefined }> {
    return Array.from(this.crons.values()).map((c) => ({
      id: c.id,
      expression: c.expression,
      description: c.description,
      runCount: c.runCount,
      ...(c.lastRun !== undefined ? { lastRun: c.lastRun } : {}),
    }));
  }

  public stopAutomation(id: string): boolean {
    const reg = this.crons.get(id);
    if (reg) {
      reg.task.stop();
      this.crons.delete(id);
      return true;
    }
    return false;
  }

  // ============================================================================
  // 5. System Clipboard Access (clipboardy)
  // ============================================================================

  public async readClipboardText(): Promise<string> {
    try {
      return await clipboardy.read();
    } catch {
      return "";
    }
  }

  public async writeClipboardText(text: string): Promise<void> {
    try {
      await clipboardy.write(text);
    } catch (err: any) {
      this.logger.warn({ err: err?.message }, "[Clipboard] Failed to write clipboard text");
    }
  }

  // ============================================================================
  // 6. Python Sidecar Bridge (open-interpreter / browser-use)
  // ============================================================================

  /**
   * Dispatches command to optional Python sidecar bridge if available.
   */
  public async executePythonSidecarCommand(
    action: string,
    params: Record<string, any> = {}
  ): Promise<any> {
    const bridgeScript = path.join(this.vendorDir, "python-sidecar", "sidecar_bridge.py");
    if (!fs.existsSync(bridgeScript)) {
      return { status: "not_installed", message: "Python sidecar bridge script not found" };
    }

    return new Promise((resolve) => {
      const pythonExe = process.platform === "win32" ? "python.exe" : "python3";
      const proc = child_process.spawn(pythonExe, [bridgeScript], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let responseBuffer = "";
      let hasResolved = false;

      const timeout = setTimeout(() => {
        if (!hasResolved) {
          hasResolved = true;
          proc.kill();
          resolve({ status: "timeout", message: "Python sidecar command timed out" });
        }
      }, 10000);

      proc.stdout.on("data", (chunk) => {
        responseBuffer += chunk.toString("utf-8");
      });

      proc.on("close", () => {
        clearTimeout(timeout);
        if (hasResolved) return;
        hasResolved = true;
        try {
          const parsed = JSON.parse(responseBuffer.trim());
          resolve(parsed);
        } catch {
          resolve({ status: "ok", raw: responseBuffer.trim() });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        if (!hasResolved) {
          hasResolved = true;
          resolve({ status: "error", message: err.message });
        }
      });

      proc.stdin.write(JSON.stringify({ action, params }) + "\n");
      proc.stdin.end();
    });
  }

  // ============================================================================
  // Cleanup & Teardown
  // ============================================================================

  public async dispose(): Promise<void> {
    // 1. Close MCP clients
    for (const [name, entry] of this.mcpClients.entries()) {
      try {
        await entry.client.close();
      } catch {}
    }
    this.mcpClients.clear();

    // 2. Close Playwright browser
    if (this.browserContext) {
      await this.browserContext.close().catch(() => {});
      this.browserContext = null;
    }
    if (this.headlessBrowser) {
      await this.headlessBrowser.close().catch(() => {});
      this.headlessBrowser = null;
    }

    // 3. Stop Chokidar watchers
    for (const watcher of this.watchers.values()) {
      await watcher.close().catch(() => {});
    }
    this.watchers.clear();

    // 4. Stop crons
    for (const reg of this.crons.values()) {
      reg.task.stop();
    }
    this.crons.clear();

    // 5. Kill python sidecar
    if (this.pythonSidecarProcess) {
      this.pythonSidecarProcess.kill();
      this.pythonSidecarProcess = null;
    }
  }
}
