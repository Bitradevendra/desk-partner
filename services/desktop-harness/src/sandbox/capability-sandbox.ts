import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import pino from "pino";
import { z } from "zod";
import {
  RiskTier,
  FrameType,
  HarnessRpcReqSchema,
  encodeControlPayload,
  type HarnessRpcReq,
} from "@petbot/protocol";
import type { OSAutomationAdapter } from "../os/os-adapters.js";
import type { HarnessServer } from "../transport/harness-server.js";
import { AuditLogger, type AuditStatus } from "./audit-logger.js";

/**
 * Zod schema for capability definitions.
 */
export const CapabilityDefinitionSchema = z.object({
  actionId: z.string().min(1),
  minimumTier: z.nativeEnum(RiskTier),
  description: z.string(),
  category: z.enum([
    "SYSTEM_AUDIO",
    "MEDIA",
    "SESSION",
    "WORKSPACE",
    "APP_LAUNCH",
    "NOTIFICATION",
    "WORKFLOW",
    "FILESYSTEM",
    "SECURITY_ADMIN",
  ]),
});
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema> & {
  humanSummaryTemplate?: ((params: Record<string, any>, callerDeviceId: string) => string) | undefined;
};

/**
 * Universal RPC request envelope accepted by CapabilitySandbox.
 */
export interface HarnessRpcRequest {
  callId: string;
  actionId?: string | undefined;
  method?: string | undefined;
  params?: Record<string, any> | undefined;
  riskTier?: RiskTier | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Universal RPC response envelope returned by CapabilitySandbox.
 */
export interface HarnessRpcResponse {
  callId: string;
  ok: boolean;
  success: boolean;
  result?: Record<string, any>;
  error?: string;
  durationMs?: number;
  riskTier?: RiskTier;
}

export interface ActiveTaskRecord {
  callId: string;
  actionId: string;
  callerDeviceId: string;
  riskTier: RiskTier;
  abortController: AbortController;
  startedAt: number;
  humanSummary: string;
}

export interface KillSwitchResult {
  abortedTasksCount: number;
  reason: string;
  timestamp: number;
}

export interface CapabilitySandboxOptions {
  osAdapter: OSAutomationAdapter;
  auditLogger?: AuditLogger;
  server?: HarnessServer;
  logger?: pino.Logger;
  approvedWorkflows?: string[];
}

/**
 * Default whitelisted workflows permitted in Tier-2 execution.
 */
export const DEFAULT_APPROVED_WORKFLOWS = [
  "git_status",
  "pnpm_test",
  "npm_test",
  "system_info",
  "cargo_check",
  "docker_ps",
  "organize_downloads",
  "organizeDownloadsFolder",
  "clipboard_summarize",
];

/**
 * Validates path security against directory traversal, system roots, and sensitive dotfiles.
 */
export function validatePathSafety(candidatePath: string): { safe: boolean; reason?: string } {
  if (typeof candidatePath !== "string") {
    return { safe: false, reason: "Path must be a string" };
  }

  // 1. Check for null bytes or illegal control characters
  if (/[\0\r\n]/.test(candidatePath)) {
    return { safe: false, reason: "Path contains illegal null bytes or line breaks" };
  }

  // 2. Reject parent directory traversal sequences: '..'
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(candidatePath) || candidatePath.includes("..")) {
    return { safe: false, reason: "Path traversal sequence '..' detected" };
  }

  const normalized = path.normalize(candidatePath);

  // 3. Reject system root directories
  const lowerNorm = normalized.toLowerCase().replace(/\\/g, "/");
  const dangerousRoots = [
    "/",
    "c:/",
    "c:",
    "c:/windows",
    "c:/program files",
    "c:/program files (x86)",
    "c:/system volume information",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/var",
    "/root",
    "/boot",
    "/dev",
    "/system",
    "/library",
  ];

  for (const root of dangerousRoots) {
    if (lowerNorm === root || lowerNorm === `${root}/`) {
      return {
        safe: false,
        reason: `Direct access to system root directory "${candidatePath}" is prohibited`,
      };
    }
  }

  // 4. Reject sensitive dotfiles and credential directories in user home or paths
  const sensitivePatterns = [
    /\.ssh(?:\/|\\|$)/i,
    /\.petbot(?:\/|\\|$)/i,
    /\.aws(?:\/|\\|$)/i,
    /\.gnupg(?:\/|\\|$)/i,
    /\.config(?:\/|\\|$)/i,
    /\.bashrc/i,
    /\.zshrc/i,
    /\.profile/i,
    /\.env/i,
    /id_rsa/i,
    /id_ed25519/i,
  ];

  for (const pattern of sensitivePatterns) {
    if (pattern.test(candidatePath)) {
      return {
        safe: false,
        reason: `Access to sensitive credential or configuration path "${candidatePath}" is prohibited`,
      };
    }
  }

  return { safe: true };
}

/**
 * Capability-Based Action Sandbox, Risk-Tier Policy Gate, Physical Touch 2FA Interceptor,
 * and Emergency Physical Kill-Switch.
 */
export class CapabilitySandbox extends EventEmitter {
  private readonly osAdapter: OSAutomationAdapter;
  public readonly auditLogger: AuditLogger;
  private server: HarnessServer | null = null;
  private readonly logger: pino.Logger;

  private readonly capabilities = new Map<string, CapabilityDefinition>();
  private readonly approvedWorkflows = new Set<string>();
  private readonly activeTasks = new Map<string, ActiveTaskRecord>();

  constructor(options: CapabilitySandboxOptions) {
    super();
    this.osAdapter = options.osAdapter;
    this.auditLogger = options.auditLogger ?? new AuditLogger({ disabled: false });
    this.server = options.server ?? null;

    this.logger =
      options.logger ??
      pino({
        name: "capability-sandbox",
        level: process.env["LOG_LEVEL"] ?? "info",
      });

    // Initialize approved workflow manifest
    const workflows = options.approvedWorkflows ?? DEFAULT_APPROVED_WORKFLOWS;
    for (const wf of workflows) {
      this.approvedWorkflows.add(wf);
    }

    this.registerStandardCapabilities();

    if (this.server) {
      this.bindServer(this.server);
    }
  }

  /**
   * Binds to the WebSocket harness server to listen for physical touch/abort events.
   */
  public bindServer(server: HarnessServer): void {
    this.server = server;
    this.auditLogger.setServer(server);

    // If robot sends an emergency stop or abort frame, trigger kill-switch immediately
    server.on("mediaControl", ({ action }) => {
      // Long press during active workflow can trigger emergency kill switch
      if (action === "emergency_stop" || action === "long_press") {
        if (this.activeTasks.size > 0) {
          this.triggerEmergencyKillSwitch("Robot physical capacitive long-press");
        }
      }
    });
  }

  /**
   * Registers or updates a capability in the canonical capability registry.
   */
  public registerCapability(def: CapabilityDefinition): void {
    const validated = CapabilityDefinitionSchema.parse(def);
    this.capabilities.set(validated.actionId, {
      ...validated,
      ...(def.humanSummaryTemplate !== undefined
        ? { humanSummaryTemplate: def.humanSummaryTemplate }
        : {}),
    });
  }

  /**
   * Retrieves a capability definition from the registry.
   */
  public getCapability(actionId: string): CapabilityDefinition | undefined {
    return this.capabilities.get(actionId);
  }

  /**
   * Lists all registered capabilities.
   */
  public listCapabilities(): CapabilityDefinition[] {
    return Array.from(this.capabilities.values());
  }

  /**
   * Returns the canonical minimum RiskTier for an action, or undefined if unregistered.
   */
  public getCanonicalRiskTier(actionId: string): RiskTier | undefined {
    return this.capabilities.get(actionId)?.minimumTier;
  }

  /**
   * Checks if an action is registered in the capability catalog.
   */
  public isActionRegistered(actionId: string): boolean {
    return this.capabilities.has(actionId);
  }

  /**
   * Registers a workflow into the approved manifest.
   */
  public registerApprovedWorkflow(workflowId: string): void {
    this.approvedWorkflows.add(workflowId);
  }

  /**
   * Verifies if a workflow is present in the approved manifest.
   */
  public isWorkflowApproved(actionId: string, params?: Record<string, any>): boolean {
    if (actionId === "run_workflow" || actionId === "execute_workflow") {
      const scriptId = String(params?.["scriptId"] ?? "");
      return this.approvedWorkflows.has(scriptId);
    }
    return this.approvedWorkflows.has(actionId);
  }

  /**
   * Returns a map of currently active running tasks.
   */
  public getActiveTasks(): Map<string, ActiveTaskRecord> {
    return new Map(this.activeTasks);
  }

  /**
   * Emergency Physical Kill-Switch:
   * Immediately aborts all active Tier-2 and Tier-3 tasks, logs 'KILLED_BY_USER',
   * and notifies the robot.
   */
  public async triggerEmergencyKillSwitch(reason: string): Promise<KillSwitchResult> {
    const now = Date.now();
    const count = this.activeTasks.size;

    this.logger.warn({ reason, activeTasksCount: count }, "[CapabilitySandbox] EMERGENCY KILL-SWITCH TRIGGERED");

    for (const [callId, task] of this.activeTasks.entries()) {
      task.abortController.abort(new Error(`Emergency Kill-Switch: ${reason}`));

      this.auditLogger.updateStatus(callId, "KILLED_BY_USER", {
        humanSummary: `Killed by user emergency stop (${reason}): ${task.humanSummary}`,
        details: { killReason: reason, abortedAt: now },
      });
    }

    this.activeTasks.clear();

    // Flash confirmation to robot if connected
    if (this.server) {
      try {
        const req: HarnessRpcReq = {
          callId: `kill_${now}`,
          method: "kill_switch_activated",
          params: {
            reason,
            abortedCount: count,
            timestamp: now,
          },
        };
        const payload = encodeControlPayload(HarnessRpcReqSchema, req);
        this.server.sendToRobot(FrameType.HARNESS_RPC_REQ, payload);
      } catch (err) {
        this.logger.debug({ err }, "[CapabilitySandbox] Failed to send kill switch frame to robot");
      }
    }

    const result: KillSwitchResult = {
      abortedTasksCount: count,
      reason,
      timestamp: now,
    };

    this.emit("emergencyKillSwitch", result);
    return result;
  }

  /**
   * Executes an RPC action strictly through the capability sandbox and risk-tier gate.
   */
  public async executeSandboxedAction(
    request: HarnessRpcRequest,
    callerDeviceId: string
  ): Promise<HarnessRpcResponse> {
    const startTime = Date.now();
    const actionId = request.actionId ?? request.method;

    if (!actionId) {
      const res: HarnessRpcResponse = {
        callId: request.callId,
        ok: false,
        success: false,
        error: "MISSING_ACTION_ID",
      };
      return res;
    }

    // 1. Canonical RiskTier Lookup (Prevent Client Downgrade)
    const canonicalDef = this.capabilities.get(actionId);
    if (!canonicalDef) {
      this.auditLogger.log({
        id: request.callId,
        sourceDeviceId: callerDeviceId,
        actionId,
        riskTier: RiskTier.TIER_3_2FA_REQUIRED,
        status: "BLOCKED_UNAUTHORIZED",
        humanSummary: `Blocked unauthorized action: Unknown action ID '${actionId}'`,
        details: { callerDeviceId },
      });

      return {
        callId: request.callId,
        ok: false,
        success: false,
        error: "UNKNOWN_OR_UNAUTHORIZED_ACTION",
      };
    }

    // Enforce minimum RiskTier: client CANNOT downgrade below canonical minimum
    const clientRequestedTier = request.riskTier ?? canonicalDef.minimumTier;
    const effectiveRiskTier = Math.max(canonicalDef.minimumTier, clientRequestedTier) as RiskTier;

    // 2. Validate Path Traversal Guards
    const pathViolation = this.detectPathViolations(request.params);
    if (pathViolation) {
      this.auditLogger.log({
        id: request.callId,
        sourceDeviceId: callerDeviceId,
        actionId,
        riskTier: effectiveRiskTier,
        status: "BLOCKED_UNAUTHORIZED",
        humanSummary: `Blocked path security violation in '${actionId}': ${pathViolation}`,
        details: { violation: pathViolation, params: request.params },
      });

      return {
        callId: request.callId,
        ok: false,
        success: false,
        error: "PATH_TRAVERSAL_DETECTED",
        riskTier: effectiveRiskTier,
      };
    }

    // Tier 2: Check Approved Workflow Manifest
    if (effectiveRiskTier === RiskTier.TIER_2_WORKFLOW) {
      if (!this.isWorkflowApproved(actionId, request.params)) {
        this.auditLogger.log({
          id: request.callId,
          sourceDeviceId: callerDeviceId,
          actionId,
          riskTier: effectiveRiskTier,
          status: "BLOCKED_UNAUTHORIZED",
          humanSummary: `Blocked unapproved workflow '${actionId}'`,
          details: { params: request.params },
        });

        return {
          callId: request.callId,
          ok: false,
          success: false,
          error: "WORKFLOW_NOT_APPROVED_IN_MANIFEST",
          riskTier: effectiveRiskTier,
        };
      }
    }

    const humanPrompt = canonicalDef.humanSummaryTemplate
      ? canonicalDef.humanSummaryTemplate(request.params ?? {}, callerDeviceId)
      : `${canonicalDef.description} (${actionId})`;

    // 3. Tier 3: HARD CRYPTOGRAPHIC GATE (Physical Touch 2FA)
    if (effectiveRiskTier === RiskTier.TIER_3_2FA_REQUIRED) {
      this.auditLogger.log({
        id: request.callId,
        sourceDeviceId: callerDeviceId,
        actionId,
        riskTier: effectiveRiskTier,
        status: "AWAITING_ROBOT_2FA",
        humanSummary: `Awaiting Robot Touch 2FA for: ${humanPrompt}`,
        details: { prompt: humanPrompt },
      });

      if (!this.server) {
        this.auditLogger.updateStatus(request.callId, "DENIED_BY_TOUCH", {
          humanSummary: `Blocked ${actionId}: No active WebSocket server to request 2FA`,
        });
        return {
          callId: request.callId,
          ok: false,
          success: false,
          error: "HARDWARE_2FA_DENIED",
          riskTier: effectiveRiskTier,
        };
      }

      const timeoutMs = request.timeoutMs ?? 15000;
      const isApproved = await this.server.requestHardwareTouch2FA(
        humanPrompt,
        RiskTier.TIER_3_2FA_REQUIRED,
        timeoutMs
      );

      if (!isApproved) {
        this.auditLogger.updateStatus(request.callId, "DENIED_BY_TOUCH", {
          humanSummary: `Blocked ${actionId}: Denied on Robot Touch Sensor or timed out`,
        });
        return {
          callId: request.callId,
          ok: false,
          success: false,
          error: "HARDWARE_2FA_DENIED",
          riskTier: effectiveRiskTier,
        };
      }

      this.auditLogger.updateStatus(request.callId, "APPROVED_BY_TOUCH", {
        humanSummary: `Approved ${actionId} via Robot Physical Touch`,
      });
    }

    // 4. Execution via OSAutomationAdapter with Kill-Switch AbortSignal
    const abortController = new AbortController();
    this.activeTasks.set(request.callId, {
      callId: request.callId,
      actionId,
      callerDeviceId,
      riskTier: effectiveRiskTier,
      abortController,
      startedAt: Date.now(),
      humanSummary: humanPrompt,
    });

    if (effectiveRiskTier !== RiskTier.TIER_3_2FA_REQUIRED) {
      this.auditLogger.log({
        id: request.callId,
        sourceDeviceId: callerDeviceId,
        actionId,
        riskTier: effectiveRiskTier,
        status: "EXECUTING",
        humanSummary: humanPrompt,
        details: { params: request.params },
      });
    } else {
      this.auditLogger.updateStatus(request.callId, "EXECUTING", {
        humanSummary: humanPrompt,
      });
    }

    try {
      const result = await this.dispatchOSAction(
        actionId,
        request.params ?? {},
        abortController.signal
      );

      const durationMs = Date.now() - startTime;
      this.activeTasks.delete(request.callId);

      this.auditLogger.updateStatus(request.callId, "COMPLETED", {
        durationMs,
        humanSummary: `Completed: ${humanPrompt}`,
        details: { result },
      });

      return {
        callId: request.callId,
        ok: true,
        success: true,
        result,
        durationMs,
        riskTier: effectiveRiskTier,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      this.activeTasks.delete(request.callId);

      const error = err as Error;
      if (abortController.signal.aborted || error.name === "AbortError") {
        this.auditLogger.updateStatus(request.callId, "KILLED_BY_USER", {
          durationMs,
          humanSummary: `Aborted by emergency kill-switch: ${humanPrompt}`,
        });

        return {
          callId: request.callId,
          ok: false,
          success: false,
          error: "ABORTED_BY_KILL_SWITCH",
          durationMs,
          riskTier: effectiveRiskTier,
        };
      }

      this.auditLogger.updateStatus(request.callId, "COMPLETED", {
        durationMs,
        humanSummary: `Failed: ${humanPrompt} (${error.message})`,
        details: { error: error.message },
      });

      return {
        callId: request.callId,
        ok: false,
        success: false,
        error: error.message,
        durationMs,
        riskTier: effectiveRiskTier,
      };
    }
  }

  private detectPathViolations(params?: Record<string, any>): string | null {
    if (!params || typeof params !== "object") {
      return null;
    }

    const checkValue = (val: unknown): string | null => {
      if (typeof val === "string") {
        // Only run path checks if string looks like a path or argument containing separators
        if (val.includes("/") || val.includes("\\") || val.includes("..") || val.startsWith(".")) {
          const res = validatePathSafety(val);
          if (!res.safe) {
            return res.reason ?? "Invalid path";
          }
        }
      } else if (Array.isArray(val)) {
        for (const item of val) {
          const res = checkValue(item);
          if (res) return res;
        }
      } else if (typeof val === "object" && val !== null) {
        for (const child of Object.values(val)) {
          const res = checkValue(child);
          if (res) return res;
        }
      }
      return null;
    };

    return checkValue(params);
  }

  private async dispatchOSAction(
    actionId: string,
    params: Record<string, any>,
    signal: AbortSignal
  ): Promise<Record<string, any>> {
    switch (actionId) {
      case "set_volume":
      case "setSystemVolume": {
        const level = typeof params["level"] === "number" ? params["level"] : (params["levelPct"] ?? 50);
        return await this.osAdapter.setSystemVolume(level);
      }
      case "toggle_system_mute":
      case "toggleSystemMute": {
        return await this.osAdapter.toggleSystemMute();
      }
      case "toggle_mic_mute":
      case "toggleMicrophoneMute": {
        return await this.osAdapter.toggleMicrophoneMute();
      }
      case "media_control":
      case "mediaControl": {
        const cmd = (params["cmd"] ?? params["command"] ?? "PLAY_PAUSE") as any;
        return await this.osAdapter.mediaControl(cmd);
      }
      case "media_play_pause": {
        return await this.osAdapter.mediaControl("PLAY_PAUSE");
      }
      case "media_next": {
        return await this.osAdapter.mediaControl("NEXT");
      }
      case "media_prev": {
        return await this.osAdapter.mediaControl("PREV");
      }
      case "lock_workstation":
      case "lockWorkstation": {
        await this.osAdapter.lockWorkstation();
        return { locked: true };
      }
      case "switch_desktop":
      case "switchVirtualDesktop": {
        const dir = (params["direction"] as "LEFT" | "RIGHT") ?? "RIGHT";
        return await this.osAdapter.switchVirtualDesktop(dir);
      }
      case "launch_app":
      case "launchWhitelistedApp": {
        const appSlug = params["appSlug"] as any;
        return await this.osAdapter.launchWhitelistedApp(appSlug);
      }
      case "show_notification":
      case "showDesktopNotification": {
        const title = String(params["title"] ?? "PetBot Notification");
        const body = String(params["body"] ?? "");
        await this.osAdapter.showDesktopNotification(title, body);
        return { displayed: true };
      }
      case "dnd_toggle":
      case "setDoNotDisturb": {
        const enabled = Boolean(params["enabled"]);
        await this.osAdapter.setDoNotDisturb(enabled);
        return { dnd: enabled };
      }
      case "organize_downloads":
      case "organizeDownloadsFolder": {
        const targetDir = typeof params["targetDir"] === "string" ? params["targetDir"] : undefined;
        return await this.osAdapter.organizeDownloadsFolder(targetDir);
      }
      case "clipboard_summarize":
      case "captureAndSummarizeClipboard": {
        return await this.osAdapter.captureAndSummarizeClipboard();
      }
      case "empty_trash":
      case "delete_temp_files":
      case "emptyTrashOrDeleteTempFiles": {
        const targetPaths = Array.isArray(params["targetPaths"])
          ? params["targetPaths"]
          : [path.join(os.tmpdir(), "petbot_scratch")];
        return await this.osAdapter.emptyTrashOrDeleteTempFiles(targetPaths);
      }
      case "run_workflow":
      case "execute_shell_workflow": {
        const scriptId = String(params["scriptId"] ?? "git_status");
        const args = Array.isArray(params["args"]) ? params["args"] : [];
        return await this.osAdapter.executeApprovedShellWorkflow(scriptId, args, signal);
      }
      case "stage_vault_file": {
        const filePath = String(params["filePath"] ?? "");
        return await this.osAdapter.stageFileForRobotVault(filePath);
      }
      case "production_deploy":
      case "system_shutdown":
      case "system_reboot": {
        return { action: actionId, status: "simulated_success", timestamp: Date.now() };
      }
      default:
        throw new Error(`Unhandled dispatch action: ${actionId}`);
    }
  }

  private registerStandardCapabilities(): void {
    // --- Tier 1 Safe Instant Controls (<5ms) ---
    this.registerCapability({
      actionId: "toggle_mic_mute",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Toggle PC microphone mute",
      category: "SYSTEM_AUDIO",
      humanSummaryTemplate: () => "Muted/Unmuted PC microphone via Robot Tap",
    });

    this.registerCapability({
      actionId: "toggleMicrophoneMute",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Toggle PC microphone mute",
      category: "SYSTEM_AUDIO",
      humanSummaryTemplate: () => "Muted/Unmuted PC microphone via Robot Tap",
    });

    this.registerCapability({
      actionId: "toggle_system_mute",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Toggle master audio output mute",
      category: "SYSTEM_AUDIO",
      humanSummaryTemplate: () => "Toggled PC master audio mute",
    });

    this.registerCapability({
      actionId: "toggleSystemMute",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Toggle master audio output mute",
      category: "SYSTEM_AUDIO",
      humanSummaryTemplate: () => "Toggled PC master audio mute",
    });

    this.registerCapability({
      actionId: "set_volume",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Set PC master audio volume level",
      category: "SYSTEM_AUDIO",
      humanSummaryTemplate: (p) => `Adjusted PC volume to ${p["level"] ?? 50}%`,
    });

    this.registerCapability({
      actionId: "setSystemVolume",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Set PC master audio volume level",
      category: "SYSTEM_AUDIO",
      humanSummaryTemplate: (p) => `Adjusted PC volume to ${p["level"] ?? 50}%`,
    });

    this.registerCapability({
      actionId: "media_control",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Dispatch media playback control",
      category: "MEDIA",
      humanSummaryTemplate: (p) => `Dispatched media control '${p["cmd"] ?? "PLAY_PAUSE"}'`,
    });

    this.registerCapability({
      actionId: "mediaControl",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Dispatch media playback control",
      category: "MEDIA",
      humanSummaryTemplate: (p) => `Dispatched media control '${p["cmd"] ?? "PLAY_PAUSE"}'`,
    });

    this.registerCapability({
      actionId: "media_play_pause",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Toggle media play/pause",
      category: "MEDIA",
      humanSummaryTemplate: () => "Toggled media playback",
    });

    this.registerCapability({
      actionId: "media_next",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Skip to next media track",
      category: "MEDIA",
      humanSummaryTemplate: () => "Skipped to next track",
    });

    this.registerCapability({
      actionId: "media_prev",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Return to previous media track",
      category: "MEDIA",
      humanSummaryTemplate: () => "Returned to previous track",
    });

    this.registerCapability({
      actionId: "lock_workstation",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Immediately lock PC desktop session",
      category: "SESSION",
      humanSummaryTemplate: () => "Locked workstation session from Robot",
    });

    this.registerCapability({
      actionId: "lockWorkstation",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Immediately lock PC desktop session",
      category: "SESSION",
      humanSummaryTemplate: () => "Locked workstation session from Robot",
    });

    this.registerCapability({
      actionId: "switch_desktop",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Switch virtual desktop left or right",
      category: "WORKSPACE",
      humanSummaryTemplate: (p) => `Switched virtual desktop ${p["direction"] ?? "RIGHT"}`,
    });

    this.registerCapability({
      actionId: "switchVirtualDesktop",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Switch virtual desktop left or right",
      category: "WORKSPACE",
      humanSummaryTemplate: (p) => `Switched virtual desktop ${p["direction"] ?? "RIGHT"}`,
    });

    this.registerCapability({
      actionId: "launch_app",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Launch pre-approved whitelisted application",
      category: "APP_LAUNCH",
      humanSummaryTemplate: (p) => `Launched app '${p["appSlug"]}'`,
    });

    this.registerCapability({
      actionId: "launchWhitelistedApp",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Launch pre-approved whitelisted application",
      category: "APP_LAUNCH",
      humanSummaryTemplate: (p) => `Launched app '${p["appSlug"]}'`,
    });

    this.registerCapability({
      actionId: "show_notification",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Display native OS notification banner",
      category: "NOTIFICATION",
      humanSummaryTemplate: (p) => `Displayed notification '${p["title"] ?? "PetBot"}'`,
    });

    this.registerCapability({
      actionId: "dnd_toggle",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Toggle OS Do Not Disturb / Focus Mode",
      category: "SESSION",
      humanSummaryTemplate: (p) => `Toggled Do Not Disturb (${p["enabled"] ? "ON" : "OFF"})`,
    });

    this.registerCapability({
      actionId: "setDoNotDisturb",
      minimumTier: RiskTier.TIER_1_SAFE,
      description: "Toggle OS Do Not Disturb / Focus Mode",
      category: "SESSION",
      humanSummaryTemplate: (p) => `Toggled Do Not Disturb (${p["enabled"] ? "ON" : "OFF"})`,
    });

    // --- Tier 2 Productivity & Approved Workflows ---
    this.registerCapability({
      actionId: "organize_downloads",
      minimumTier: RiskTier.TIER_2_WORKFLOW,
      description: "Organize files in downloads directory into categories",
      category: "FILESYSTEM",
      humanSummaryTemplate: () => "Organized Downloads folder into categorized directories",
    });

    this.registerCapability({
      actionId: "organizeDownloadsFolder",
      minimumTier: RiskTier.TIER_2_WORKFLOW,
      description: "Organize files in downloads directory into categories",
      category: "FILESYSTEM",
      humanSummaryTemplate: () => "Organized Downloads folder into categorized directories",
    });

    this.registerCapability({
      actionId: "clipboard_summarize",
      minimumTier: RiskTier.TIER_2_WORKFLOW,
      description: "Read, preview, and compute word metrics of clipboard",
      category: "WORKFLOW",
      humanSummaryTemplate: () => "Inspected and summarized clipboard contents",
    });

    this.registerCapability({
      actionId: "run_workflow",
      minimumTier: RiskTier.TIER_2_WORKFLOW,
      description: "Run an approved workflow script from manifest",
      category: "WORKFLOW",
      humanSummaryTemplate: (p) => `Executed approved workflow '${p["scriptId"]}'`,
    });

    // --- Tier 3 High-Privilege & Hardware 2FA Gated Actions ---
    this.registerCapability({
      actionId: "empty_trash",
      minimumTier: RiskTier.TIER_3_2FA_REQUIRED,
      description: "Clean temporary files and emptied cache",
      category: "FILESYSTEM",
      humanSummaryTemplate: () => "Empty trash and clean temporary cache files",
    });

    this.registerCapability({
      actionId: "delete_temp_files",
      minimumTier: RiskTier.TIER_3_2FA_REQUIRED,
      description: "Delete temporary scratch files in sandbox",
      category: "FILESYSTEM",
      humanSummaryTemplate: () => "Clean temporary files in sandbox",
    });

    this.registerCapability({
      actionId: "emptyTrashOrDeleteTempFiles",
      minimumTier: RiskTier.TIER_3_2FA_REQUIRED,
      description: "Clean temporary files and emptied cache",
      category: "FILESYSTEM",
      humanSummaryTemplate: () => "Empty trash and clean temporary cache files",
    });

    this.registerCapability({
      actionId: "execute_shell_workflow",
      minimumTier: RiskTier.TIER_3_2FA_REQUIRED,
      description: "Execute privileged shell workflow",
      category: "WORKFLOW",
      humanSummaryTemplate: (p) => `Execute privileged workflow: ${p["scriptId"] ?? "unknown"}`,
    });

    this.registerCapability({
      actionId: "stage_vault_file",
      minimumTier: RiskTier.TIER_3_2FA_REQUIRED,
      description: "Stage desktop file for Robot SD Vault transfer",
      category: "FILESYSTEM",
      humanSummaryTemplate: (p) => `Stage file for SD Vault: ${path.basename(String(p["filePath"] ?? ""))}`,
    });

    this.registerCapability({
      actionId: "production_deploy",
      minimumTier: RiskTier.TIER_3_2FA_REQUIRED,
      description: "Trigger production deployment",
      category: "SECURITY_ADMIN",
      humanSummaryTemplate: () => "Approve SSH Deployment to Production",
    });

    this.registerCapability({
      actionId: "system_shutdown",
      minimumTier: RiskTier.TIER_3_2FA_REQUIRED,
      description: "Initiate system power shutdown",
      category: "SESSION",
      humanSummaryTemplate: () => "Initiate PC system shutdown",
    });

    this.registerCapability({
      actionId: "system_reboot",
      minimumTier: RiskTier.TIER_3_2FA_REQUIRED,
      description: "Initiate system reboot",
      category: "SESSION",
      humanSummaryTemplate: () => "Initiate PC system reboot",
    });
  }
}
