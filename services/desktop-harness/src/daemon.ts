import pino from "pino";
import { CryptoVault, type CryptoVaultOptions } from "./security/crypto-vault.js";
import { HarnessServer, type HarnessServerOptions } from "./transport/harness-server.js";
import { TelemetryMonitor, type TelemetrySnapshot } from "./os/telemetry-monitor.js";
import { createOSAdapter, type OSAutomationAdapter, type OSAdapterOptions } from "./os/os-adapters.js";
import { AuditLogger, CapabilitySandbox } from "./sandbox/index.js";
import { WorkflowEngine } from "./workflows/index.js";
import { DEFAULT_WS_PORT } from "@petbot/protocol";
import { OssAgentEcosystemLoader, type OssLoaderOptions } from "./integrations/oss-loader.js";
import { HeadlessPartnerToolBus } from "./partner/headless-tool-bus.js";
import { RobotLiveHudBridge } from "./partner/robot-live-hud-bridge.js";
import { AutomationHostEngine } from "./automations/automation-host-engine.js";
import { AutonomousPartnerAgent } from "./partner/autonomous-partner-agent.js";

export interface DaemonOptions {
  port?: number;
  host?: string;
  vaultOptions?: CryptoVaultOptions;
  osOptions?: OSAdapterOptions;
  ossOptions?: OssLoaderOptions;
  auditLogFilePath?: string;
  workflowsFilePath?: string;
  approvedWorkflows?: string[];
  allowPairingMode?: boolean;
  bonjourEnabled?: boolean;
  enableTelemetryBroadcasting?: boolean;
  telemetryIntervalMs?: number;
  logger?: pino.Logger;
}

/**
 * Desktop Harness Daemon: Coordinates cryptographic key vault, Bonjour discovery,
 * WebSocket server, OS automation adapter, sandbox & 2FA gate, workflow engine,
 * headless partner tool bus, and real-time PC telemetry / HUD streaming.
 */
export class DesktopHarnessDaemon {
  public readonly vault: CryptoVault;
  public readonly server: HarnessServer;
  public readonly osAdapter: OSAutomationAdapter;
  public readonly auditLogger: AuditLogger;
  public readonly sandbox: CapabilitySandbox;
  public readonly workflowEngine: WorkflowEngine;
  public readonly telemetryMonitor: TelemetryMonitor;
  public readonly ossLoader: OssAgentEcosystemLoader;
  public readonly toolBus: HeadlessPartnerToolBus;
  public readonly hudBridge: RobotLiveHudBridge;
  public readonly automationEngine: AutomationHostEngine;
  public readonly partnerAgent: AutonomousPartnerAgent;
  private readonly logger: pino.Logger;
  private readonly enableTelemetryBroadcasting: boolean;

  constructor(options?: DaemonOptions) {
    this.logger =
      options?.logger ??
      pino({
        name: "petbot-daemon",
        level: process.env["LOG_LEVEL"] ?? "info",
      });

    this.vault = new CryptoVault(options?.vaultOptions);
    this.osAdapter = createOSAdapter(options?.osOptions);

    const serverOptions: HarnessServerOptions = {
      port: options?.port ?? DEFAULT_WS_PORT,
      host: options?.host ?? "0.0.0.0",
      cryptoVault: this.vault,
      allowPairingMode: options?.allowPairingMode ?? true,
      bonjourEnabled: options?.bonjourEnabled ?? true,
      logger: this.logger,
    };
    this.server = new HarnessServer(serverOptions);

    this.auditLogger = new AuditLogger({
      ...(options?.auditLogFilePath !== undefined ? { logFilePath: options.auditLogFilePath } : {}),
      server: this.server,
      logger: this.logger,
    });

    this.sandbox = new CapabilitySandbox({
      osAdapter: this.osAdapter,
      auditLogger: this.auditLogger,
      server: this.server,
      logger: this.logger,
      ...(options?.approvedWorkflows !== undefined ? { approvedWorkflows: options.approvedWorkflows } : {}),
    });

    this.enableTelemetryBroadcasting = options?.enableTelemetryBroadcasting ?? true;
    this.telemetryMonitor = new TelemetryMonitor({
      pollingIntervalMs: options?.telemetryIntervalMs ?? 1000,
      server: this.server,
      logger: this.logger,
      ...(options?.osOptions?.mock !== undefined ? { mock: options.osOptions.mock } : {}),
    });

    this.workflowEngine = new WorkflowEngine({
      sandbox: this.sandbox,
      auditLogger: this.auditLogger,
      server: this.server,
      telemetryMonitor: this.telemetryMonitor,
      ...(options?.workflowsFilePath !== undefined ? { workflowsFilePath: options.workflowsFilePath } : {}),
      logger: this.logger,
    });

    // Initialize headless open-source agent tools and live robot HUD streaming
    this.ossLoader = new OssAgentEcosystemLoader(options?.ossOptions);
    this.toolBus = new HeadlessPartnerToolBus(
      this.ossLoader,
      this.osAdapter,
      this.server,
      this.logger
    );
    this.hudBridge = new RobotLiveHudBridge({
      server: this.server,
      toolBus: this.toolBus,
      logger: this.logger,
    });
    this.automationEngine = new AutomationHostEngine({
      toolBus: this.toolBus,
      hudBridge: this.hudBridge,
      server: this.server,
      telemetryMonitor: this.telemetryMonitor,
      logger: this.logger,
    });
    this.partnerAgent = new AutonomousPartnerAgent({
      toolBus: this.toolBus,
      hudBridge: this.hudBridge,
      server: this.server,
      osAdapter: this.osAdapter,
      telemetryMonitor: this.telemetryMonitor,
      logger: this.logger,
    });

    // Wire physical robot single-tap media control to OS automation adapter
    this.server.on("mediaControl", async ({ action }) => {
      this.logger.info({ action }, "[Daemon] Executing media control from robot physical touch");
      try {
        await this.osAdapter.mediaControl("PLAY_PAUSE");
      } catch (err) {
        this.logger.error({ err }, "[Daemon] Failed to execute media control");
      }
    });

    // Route incoming RPC actions from robot/companions through WorkflowEngine and CapabilitySandbox
    this.server.on("rpcRequest", async ({ req, session, reply }) => {
      const callerDeviceId = session?.device?.deviceId ?? session?.id ?? "unknown-device";
      this.logger.info(
        { method: req.method, callId: req.callId, callerDeviceId },
        "[Daemon] Handling RPC request"
      );

      try {
        if (req.method === "trigger_workflow" || req.method === "run_automation" || req.method === "trigger_automation") {
          const requestedId = String(req.params["workflowId"] ?? req.params["automationId"] ?? "");
          const scriptName = String(req.params["scriptName"] ?? req.params["name"] ?? requestedId);
          const wfList = this.workflowEngine.listWorkflows();
          const matchedWf =
            wfList.find((w) => w.id === requestedId) ??
            wfList.find((w) => scriptName && w.name.toLowerCase().includes(scriptName.toLowerCase()));

          if (matchedWf) {
            const wfResult = await this.workflowEngine.executeWorkflow(matchedWf.id, {
              sourceDeviceId: callerDeviceId,
            });
            reply({
              callId: req.callId,
              success: wfResult.success,
              result: wfResult as unknown as Record<string, unknown>,
              ...(wfResult.error ? { error: wfResult.error } : {}),
            });
            return;
          }

          // Fallback: execute via AutonomousPartnerAgent for open-ended automation scripts
          const execRes = await this.partnerAgent.planAndExecute(scriptName || "Execute automation");
          reply({
            callId: req.callId,
            success: execRes.success,
            result: {
              planId: execRes.planId,
              goal: execRes.goal,
              stepsExecuted: execRes.stepsExecuted,
              totalSteps: execRes.totalSteps,
              spokenConfirmation: execRes.spokenConfirmation,
            },
          });
          return;
        }

        if (req.method === "list_workflows") {
          reply({
            callId: req.callId,
            success: true,
            result: { workflows: this.workflowEngine.listWorkflows() },
          });
          return;
        }

        // --- Partner Tools & Live HUD RPC Endpoints ---
        if (req.method === "list_partner_tools") {
          reply({
            callId: req.callId,
            success: true,
            result: { tools: this.toolBus.listTools() },
          });
          return;
        }

        if (req.method === "execute_partner_tool") {
          const toolName = String(req.params["toolName"] ?? "");
          const toolParams = (req.params["params"] as Record<string, any>) ?? {};
          const useHud = Boolean(req.params["useHud"]);
          const taskName = String(req.params["taskName"] ?? toolName);

          let output: any;
          if (useHud) {
            output = await this.hudBridge.executeToolWithHud(taskName, toolName, toolParams);
          } else {
            output = await this.toolBus.executeTool(toolName, toolParams);
          }

          reply({
            callId: req.callId,
            success: true,
            result: { output },
          });
          return;
        }

        if (req.method === "execute_hud_task") {
          const taskDef = req.params as any;
          const hudRes = await this.hudBridge.executeTaskWithHud(taskDef);
          reply({
            callId: req.callId,
            success: hudRes.success,
            result: hudRes as unknown as Record<string, any>,
            ...(hudRes.error ? { error: hudRes.error } : {}),
          });
          return;
        }

        // --- Autonomous Partner Agent RPC Endpoints ---
        if (req.method === "partner_agent_execute") {
          const command = String(req.params["command"] ?? "");
          const execRes = await this.partnerAgent.planAndExecute(command);
          const sanitizedResult = {
            success: execRes.success,
            planId: execRes.planId,
            goal: execRes.goal,
            stepsExecuted: execRes.stepsExecuted,
            totalSteps: execRes.totalSteps,
            spokenConfirmation: execRes.spokenConfirmation,
            spokenEmotion: execRes.spokenEmotion,
            audioFramesCount: execRes.audioDownlinkFrames?.length ?? 0,
            durationMs: execRes.durationMs,
            stepResults: execRes.stepResults,
          };
          reply({
            callId: req.callId,
            success: execRes.success,
            result: sanitizedResult as unknown as Record<string, any>,
            ...(execRes.error ? { error: execRes.error } : {}),
          });
          return;
        }

        if (req.method === "partner_agent_context") {
          const ctx = await this.partnerAgent.gatherLiveContext();
          reply({
            callId: req.callId,
            success: true,
            result: ctx as unknown as Record<string, any>,
          });
          return;
        }

        // Direct tool execution fallback if tool is registered on HeadlessPartnerToolBus
        const matchedTool = this.toolBus.getTool(req.method);
        if (matchedTool) {
          const output = await this.toolBus.executeTool(req.method, req.params);
          reply({
            callId: req.callId,
            success: true,
            result: { output },
          });
          return;
        }

        if (this.workflowEngine.hasWorkflowForRobotAction(req.method)) {
          const wfResults = await this.workflowEngine.handleRobotAction(req.method, callerDeviceId);
          const lastRes = wfResults[wfResults.length - 1];
          reply({
            callId: req.callId,
            success: lastRes ? lastRes.success : true,
            result: { workflowResults: wfResults },
            ...(lastRes && !lastRes.success && lastRes.error ? { error: lastRes.error } : {}),
          });
          return;
        }

        const response = await this.sandbox.executeSandboxedAction(
          {
            callId: req.callId,
            actionId: req.method,
            method: req.method,
            params: req.params,
          },
          callerDeviceId
        );

        reply({
          callId: response.callId,
          success: response.success,
          ...(response.result !== undefined ? { result: response.result } : {}),
          ...(response.error !== undefined ? { error: response.error } : {}),
        });
      } catch (err: unknown) {
        const error = err as Error;
        reply({
          callId: req.callId,
          success: false,
          error: error.message,
        });
      }
    });
  }

  public async start(): Promise<void> {
    const identity = this.vault.getIdentity();
    this.logger.info(
      {
        deviceId: identity.deviceId,
        publicKey: identity.ed25519PublicKeyHex,
        port: this.server.port,
        platform: this.osAdapter.platform,
        mockMode: this.osAdapter.isMock,
      },
      "[Daemon] Starting PetBot Desktop Harness Daemon"
    );

    await this.server.start();

    if (this.enableTelemetryBroadcasting) {
      this.telemetryMonitor.start();
    }
  }

  public async stop(): Promise<void> {
    this.automationEngine.destroy();
    this.telemetryMonitor.stop();
    await this.ossLoader.dispose();
    await this.server.stop();
    this.logger.info("[Daemon] Desktop Harness Daemon stopped");
  }

  public getBoundPort(): number {
    return this.server.getBoundPort();
  }

  public getPartnerAgent(): AutonomousPartnerAgent {
    return this.partnerAgent;
  }
}
