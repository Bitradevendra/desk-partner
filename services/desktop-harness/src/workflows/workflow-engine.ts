import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import pino from "pino";
import { z } from "zod";
import {
  EmotionId,
  FrameType,
  HarnessRpcReqSchema,
  encodeControlPayload,
  type HarnessRpcReq,
} from "@petbot/protocol";
import type { CapabilitySandbox } from "../sandbox/capability-sandbox.js";
import type { AuditLogger } from "../sandbox/audit-logger.js";
import type { HarnessServer } from "../transport/harness-server.js";
import type { TelemetryMonitor, TelemetrySnapshot } from "../os/telemetry-monitor.js";

// ============================================================================
// No-Code Workflow Zod Schemas
// ============================================================================

export const RobotWidgetTriggerSchema = z.object({
  type: z.literal("ROBOT_WIDGET_ACTION"),
  actionId: z.string().min(1),
});
export type RobotWidgetTrigger = z.infer<typeof RobotWidgetTriggerSchema>;

export const DesktopEventTriggerSchema = z.object({
  type: z.literal("DESKTOP_EVENT"),
  event: z.enum([
    "ON_MEETING_STARTED",
    "ON_MEETING_ENDED",
    "ON_HIGH_CPU_LOAD",
    "ON_IDLE_15MIN",
    "ON_SCHEDULE_TIME",
  ]),
  threshold: z.number().optional(),
  scheduleTime: z.string().optional(),
});
export type DesktopEventTrigger = z.infer<typeof DesktopEventTriggerSchema>;

export const VoiceIntentTriggerSchema = z.object({
  type: z.literal("VOICE_COMMAND_INTENT"),
  intentSlug: z.string().min(1),
});
export type VoiceIntentTrigger = z.infer<typeof VoiceIntentTriggerSchema>;

export const WorkflowTriggerSchema = z.discriminatedUnion("type", [
  RobotWidgetTriggerSchema,
  DesktopEventTriggerSchema,
  VoiceIntentTriggerSchema,
]);
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

export const OsActionStepSchema = z.object({
  type: z.literal("OS_ACTION"),
  actionId: z.string().min(1),
  params: z.record(z.string(), z.any()).optional(),
});
export type OsActionStep = z.infer<typeof OsActionStepSchema>;

export const RobotSetExpressionStepSchema = z.object({
  type: z.literal("ROBOT_SET_EXPRESSION"),
  emotion: z.union([z.nativeEnum(EmotionId), z.string()]),
});
export type RobotSetExpressionStep = z.infer<typeof RobotSetExpressionStepSchema>;

export const RobotPlaySoundStepSchema = z.object({
  type: z.literal("ROBOT_PLAY_SOUND"),
  soundId: z.string().min(1),
});
export type RobotPlaySoundStep = z.infer<typeof RobotPlaySoundStepSchema>;

export const RobotShowToastStepSchema = z.object({
  type: z.literal("ROBOT_SHOW_TOAST"),
  message: z.string().min(1),
  durationMs: z.number().int().positive().optional(),
});
export type RobotShowToastStep = z.infer<typeof RobotShowToastStepSchema>;

export const DelayMsStepSchema = z.object({
  type: z.literal("DELAY_MS"),
  delayMs: z.number().int().nonnegative(),
});
export type DelayMsStep = z.infer<typeof DelayMsStepSchema>;

export const WorkflowStepSchema = z.discriminatedUnion("type", [
  OsActionStepSchema,
  RobotSetExpressionStepSchema,
  RobotPlaySoundStepSchema,
  RobotShowToastStepSchema,
  DelayMsStepSchema,
]);
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const NoCodeWorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  trigger: WorkflowTriggerSchema,
  steps: z.array(WorkflowStepSchema).min(1),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
});
export type NoCodeWorkflow = z.infer<typeof NoCodeWorkflowSchema>;

// ============================================================================
// 4 Pre-Seeded Built-In Productivity Workflows
// ============================================================================

export const BUILTIN_WORKFLOWS: NoCodeWorkflow[] = [
  {
    id: "wf_meeting_shield",
    name: "Deep Focus & Meeting Shield",
    enabled: true,
    description:
      "When a Zoom/Meet call starts -> Set Robot Expression to FOCUSED, enable Desktop Do-Not-Disturb, and show 'Meeting Mode Active' on the 1.8\" TFT.",
    trigger: {
      type: "DESKTOP_EVENT",
      event: "ON_MEETING_STARTED",
    },
    steps: [
      {
        type: "ROBOT_SET_EXPRESSION",
        emotion: EmotionId.FOCUSED,
      },
      {
        type: "OS_ACTION",
        actionId: "dnd_toggle",
        params: { enabled: true },
      },
      {
        type: "ROBOT_SHOW_TOAST",
        message: "Meeting Mode Active",
        durationMs: 4000,
      },
    ],
  },
  {
    id: "wf_privacy_lock",
    name: "1-Tap Instant Privacy Lock",
    enabled: true,
    description:
      "Triggered from Robot -> Mute PC Microphone, pause media playback, set Robot Expression to SLEEPY, and lock workstation.",
    trigger: {
      type: "ROBOT_WIDGET_ACTION",
      actionId: "instant_privacy_lock",
    },
    steps: [
      {
        type: "OS_ACTION",
        actionId: "toggle_mic_mute",
      },
      {
        type: "OS_ACTION",
        actionId: "media_play_pause",
      },
      {
        type: "ROBOT_SET_EXPRESSION",
        emotion: EmotionId.SLEEPY,
      },
      {
        type: "OS_ACTION",
        actionId: "lock_workstation",
      },
      {
        type: "ROBOT_SHOW_TOAST",
        message: "Privacy Locked",
        durationMs: 3000,
      },
    ],
  },
  {
    id: "wf_downloads_sweep",
    name: "Tidy Desk & Downloads Sweep",
    enabled: true,
    description:
      "Triggered from Robot -> Sort Downloads folder into categorized folders, play HAPPY_TRILL on robot, and display count of organized files on the 1.8\" screen.",
    trigger: {
      type: "ROBOT_WIDGET_ACTION",
      actionId: "sweep_downloads",
    },
    steps: [
      {
        type: "ROBOT_SET_EXPRESSION",
        emotion: EmotionId.CURIOUS,
      },
      {
        type: "OS_ACTION",
        actionId: "organize_downloads",
      },
      {
        type: "ROBOT_PLAY_SOUND",
        soundId: "HAPPY_TRILL",
      },
      {
        type: "ROBOT_SET_EXPRESSION",
        emotion: EmotionId.HAPPY,
      },
      {
        type: "ROBOT_SHOW_TOAST",
        message: "Downloads Swept & Organized",
        durationMs: 3000,
      },
    ],
  },
  {
    id: "wf_secure_purge_2fa",
    name: "Secure Temp & Trash Purge (Hardware 2FA)",
    enabled: true,
    description:
      "Tier-3 workflow that prompts 'Tap Robot to Purge Temp & Trash' on the 1.8\" TFT, waits for physical tap signature, cleans temp directory, and reports freed MB.",
    trigger: {
      type: "ROBOT_WIDGET_ACTION",
      actionId: "purge_temp_2fa",
    },
    steps: [
      {
        type: "ROBOT_SHOW_TOAST",
        message: "Tap Robot to Purge Temp & Trash",
        durationMs: 5000,
      },
      {
        type: "OS_ACTION",
        actionId: "delete_temp_files",
      },
      {
        type: "ROBOT_PLAY_SOUND",
        soundId: "CHIME",
      },
      {
        type: "ROBOT_SET_EXPRESSION",
        emotion: EmotionId.HAPPY,
      },
      {
        type: "ROBOT_SHOW_TOAST",
        message: "Temp Files Purged Clean",
        durationMs: 3000,
      },
    ],
  },
];

// ============================================================================
// Workflow Execution Interfaces
// ============================================================================

export interface StepResult {
  stepIndex: number;
  type: WorkflowStep["type"];
  success: boolean;
  result?: any;
  error?: string;
  durationMs: number;
}

export interface WorkflowExecutionResult {
  workflowId: string;
  workflowName: string;
  success: boolean;
  stepsExecuted: number;
  totalSteps: number;
  durationMs: number;
  stepResults: StepResult[];
  error?: string;
}

export interface WorkflowTriggerContext {
  sourceDeviceId?: string | undefined;
  triggerType?: string | undefined;
  params?: Record<string, any> | undefined;
  abortSignal?: AbortSignal | undefined;
}

export interface WorkflowEngineOptions {
  sandbox: CapabilitySandbox;
  auditLogger?: AuditLogger;
  server?: HarnessServer;
  telemetryMonitor?: TelemetryMonitor;
  workflowsFilePath?: string;
  logger?: pino.Logger;
  autoBindEvents?: boolean;
}

/**
 * No-Code Multi-Step Workflow Automation Engine
 * Coordinates triggers, step execution through the CapabilitySandbox,
 * hardware robot feedback, and emergency kill-switch integration.
 */
export class WorkflowEngine extends EventEmitter {
  private readonly sandbox: CapabilitySandbox;
  private readonly auditLogger: AuditLogger;
  private server: HarnessServer | null;
  private telemetryMonitor: TelemetryMonitor | null;
  private readonly logger: pino.Logger;
  public readonly workflowsFilePath: string;

  private readonly workflows = new Map<string, NoCodeWorkflow>();
  private prevInMeeting = false;

  constructor(options: WorkflowEngineOptions) {
    super();
    this.sandbox = options.sandbox;
    this.auditLogger = options.auditLogger ?? options.sandbox.auditLogger;
    this.server = options.server ?? null;
    this.telemetryMonitor = options.telemetryMonitor ?? null;

    this.logger =
      options.logger ??
      pino({
        name: "workflow-engine",
        level: process.env["LOG_LEVEL"] ?? "info",
      });

    this.workflowsFilePath =
      options.workflowsFilePath ??
      path.join(os.homedir(), ".petbot", "workflows.json");

    this.loadWorkflows();

    if (options.autoBindEvents !== false) {
      this.bindTriggers();
    }
  }

  public setServer(server: HarnessServer): void {
    this.server = server;
  }

  public setTelemetryMonitor(monitor: TelemetryMonitor): void {
    this.telemetryMonitor = monitor;
    this.bindTelemetryEvents();
  }

  // ============================================================================
  // Workflow CRUD Operations
  // ============================================================================

  public listWorkflows(): NoCodeWorkflow[] {
    return Array.from(this.workflows.values());
  }

  public getWorkflow(id: string): NoCodeWorkflow | undefined {
    return this.workflows.get(id);
  }

  public saveWorkflow(workflow: NoCodeWorkflow): NoCodeWorkflow {
    const validated = NoCodeWorkflowSchema.parse({
      ...workflow,
      updatedAt: Date.now(),
      createdAt: workflow.createdAt ?? Date.now(),
    });

    this.workflows.set(validated.id, validated);
    this.persistWorkflows();

    this.logger.info({ id: validated.id, name: validated.name }, "[WorkflowEngine] Saved workflow");
    this.emit("workflowSaved", validated);
    return validated;
  }

  public deleteWorkflow(id: string): boolean {
    if (this.workflows.has(id)) {
      this.workflows.delete(id);
      this.persistWorkflows();
      this.logger.info({ id }, "[WorkflowEngine] Deleted workflow");
      this.emit("workflowDeleted", id);
      return true;
    }
    return false;
  }

  public resetToDefaults(): NoCodeWorkflow[] {
    this.workflows.clear();
    for (const wf of BUILTIN_WORKFLOWS) {
      this.workflows.set(wf.id, wf);
    }
    this.persistWorkflows();
    return this.listWorkflows();
  }

  // ============================================================================
  // Multi-Step Workflow Execution
  // ============================================================================

  /**
   * Executes a multi-step workflow sequentially with sandbox validation and cancellation support.
   */
  public async executeWorkflow(
    workflowIdOrWorkflow: string | NoCodeWorkflow,
    context?: WorkflowTriggerContext
  ): Promise<WorkflowExecutionResult> {
    const startTime = Date.now();
    const workflow =
      typeof workflowIdOrWorkflow === "string"
        ? this.workflows.get(workflowIdOrWorkflow)
        : workflowIdOrWorkflow;

    if (!workflow) {
      const err = `Workflow not found: ${String(workflowIdOrWorkflow)}`;
      this.logger.warn({ workflowId: workflowIdOrWorkflow }, `[WorkflowEngine] ${err}`);
      return {
        workflowId: typeof workflowIdOrWorkflow === "string" ? workflowIdOrWorkflow : "unknown",
        workflowName: "Unknown",
        success: false,
        stepsExecuted: 0,
        totalSteps: 0,
        durationMs: 0,
        stepResults: [],
        error: err,
      };
    }

    if (!workflow.enabled) {
      this.logger.info({ id: workflow.id }, "[WorkflowEngine] Skipping disabled workflow");
      return {
        workflowId: workflow.id,
        workflowName: workflow.name,
        success: false,
        stepsExecuted: 0,
        totalSteps: workflow.steps.length,
        durationMs: 0,
        stepResults: [],
        error: "WORKFLOW_DISABLED",
      };
    }

    const callerDevice = context?.sourceDeviceId ?? "desktop-harness";
    this.logger.info(
      { id: workflow.id, name: workflow.name, stepsCount: workflow.steps.length, callerDevice },
      "[WorkflowEngine] Starting multi-step workflow execution"
    );

    const stepResults: StepResult[] = [];
    const abortSignal = context?.abortSignal;

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i]!;
      const stepStartTime = Date.now();

      // Check if workflow was cancelled mid-execution by emergency kill-switch
      if (abortSignal?.aborted) {
        const abortedErr = "WORKFLOW_ABORTED_BY_USER";
        this.logger.warn(
          { id: workflow.id, stepIndex: i },
          "[WorkflowEngine] Execution halted by emergency abort signal"
        );
        return {
          workflowId: workflow.id,
          workflowName: workflow.name,
          success: false,
          stepsExecuted: i,
          totalSteps: workflow.steps.length,
          durationMs: Date.now() - startTime,
          stepResults,
          error: abortedErr,
        };
      }

      try {
        let stepOutput: any;

        switch (step.type) {
          case "OS_ACTION": {
            const rpcReq = {
              callId: `${workflow.id}_step_${i}_${Date.now()}`,
              actionId: step.actionId,
              params: step.params,
            };
            const res = await this.sandbox.executeSandboxedAction(rpcReq, callerDevice);
            if (!res.ok) {
              throw new Error(res.error ?? "OS action failed");
            }
            stepOutput = res.result;
            break;
          }

          case "ROBOT_SET_EXPRESSION": {
            const emotionId = this.resolveEmotionId(step.emotion);
            stepOutput = this.sendRobotExpression(emotionId);
            break;
          }

          case "ROBOT_PLAY_SOUND": {
            stepOutput = this.sendRobotSound(step.soundId);
            break;
          }

          case "ROBOT_SHOW_TOAST": {
            stepOutput = this.sendRobotToast(step.message, step.durationMs);
            break;
          }

          case "DELAY_MS": {
            stepOutput = await this.cancellableDelay(step.delayMs, abortSignal);
            break;
          }
        }

        const stepDuration = Date.now() - stepStartTime;
        const resultItem: StepResult = {
          stepIndex: i,
          type: step.type,
          success: true,
          result: stepOutput,
          durationMs: stepDuration,
        };
        stepResults.push(resultItem);

        this.emit("stepExecuted", {
          workflowId: workflow.id,
          stepIndex: i,
          step,
          result: resultItem,
        });
      } catch (err: unknown) {
        const error = err as Error;
        const stepDuration = Date.now() - stepStartTime;
        const failedItem: StepResult = {
          stepIndex: i,
          type: step.type,
          success: false,
          error: error.message,
          durationMs: stepDuration,
        };
        stepResults.push(failedItem);

        this.logger.error(
          { id: workflow.id, stepIndex: i, err: error.message },
          "[WorkflowEngine] Step execution failed"
        );

        return {
          workflowId: workflow.id,
          workflowName: workflow.name,
          success: false,
          stepsExecuted: i,
          totalSteps: workflow.steps.length,
          durationMs: Date.now() - startTime,
          stepResults,
          error: error.message,
        };
      }
    }

    const totalDuration = Date.now() - startTime;
    const finalResult: WorkflowExecutionResult = {
      workflowId: workflow.id,
      workflowName: workflow.name,
      success: true,
      stepsExecuted: workflow.steps.length,
      totalSteps: workflow.steps.length,
      durationMs: totalDuration,
      stepResults,
    };

    this.logger.info(
      { id: workflow.id, durationMs: totalDuration },
      "[WorkflowEngine] Workflow completed successfully"
    );

    this.emit("workflowCompleted", finalResult);
    return finalResult;
  }

  // ============================================================================
  // Event & Trigger Dispatchers
  // ============================================================================

  /**
   * Handles desktop events (e.g. meeting started/ended, high CPU load).
   */
  public async handleDesktopEvent(
    event: DesktopEventTrigger["event"],
    data?: Record<string, any>
  ): Promise<WorkflowExecutionResult[]> {
    this.logger.info({ event }, "[WorkflowEngine] Handling desktop event trigger");

    const matched = Array.from(this.workflows.values()).filter(
      (wf) => wf.enabled && wf.trigger.type === "DESKTOP_EVENT" && wf.trigger.event === event
    );

    const results: WorkflowExecutionResult[] = [];
    for (const wf of matched) {
      const res = await this.executeWorkflow(wf, {
        triggerType: "DESKTOP_EVENT",
        params: data,
      });
      results.push(res);
    }
    return results;
  }

  /**
   * Handles action triggers originating from the ESP32-S3 robot's touch pad / WidgetVM.
   */
  public async handleRobotAction(
    actionId: string,
    callerDeviceId: string = "esp32-robot"
  ): Promise<WorkflowExecutionResult[]> {
    this.logger.info({ actionId, callerDeviceId }, "[WorkflowEngine] Handling robot widget action trigger");

    const matched = Array.from(this.workflows.values()).filter(
      (wf) => wf.enabled && wf.trigger.type === "ROBOT_WIDGET_ACTION" && wf.trigger.actionId === actionId
    );

    const results: WorkflowExecutionResult[] = [];
    for (const wf of matched) {
      const res = await this.executeWorkflow(wf, {
        sourceDeviceId: callerDeviceId,
        triggerType: "ROBOT_WIDGET_ACTION",
      });
      results.push(res);
    }
    return results;
  }

  /**
   * Handles voice command intent triggers from the Cloud Voice Gateway.
   */
  public async handleVoiceIntent(
    intentSlug: string,
    callerDeviceId: string = "voice-gateway"
  ): Promise<WorkflowExecutionResult[]> {
    this.logger.info({ intentSlug, callerDeviceId }, "[WorkflowEngine] Handling voice intent trigger");

    const matched = Array.from(this.workflows.values()).filter(
      (wf) =>
        wf.enabled &&
        wf.trigger.type === "VOICE_COMMAND_INTENT" &&
        wf.trigger.intentSlug === intentSlug
    );

    const results: WorkflowExecutionResult[] = [];
    for (const wf of matched) {
      const res = await this.executeWorkflow(wf, {
        sourceDeviceId: callerDeviceId,
        triggerType: "VOICE_COMMAND_INTENT",
      });
      results.push(res);
    }
    return results;
  }

  public hasWorkflowForRobotAction(actionId: string): boolean {
    return Array.from(this.workflows.values()).some(
      (wf) => wf.enabled && wf.trigger.type === "ROBOT_WIDGET_ACTION" && wf.trigger.actionId === actionId
    );
  }

  // ============================================================================
  // Robot Hardware Action Senders
  // ============================================================================

  private resolveEmotionId(emotion: EmotionId | string): EmotionId {
    if (typeof emotion === "number") {
      return emotion as EmotionId;
    }
    const name = String(emotion).toUpperCase();
    if (name in EmotionId) {
      return (EmotionId as any)[name];
    }
    return EmotionId.IDLE;
  }

  private sendRobotExpression(emotionId: EmotionId): { emotionId: EmotionId; sent: boolean } {
    if (!this.server) {
      return { emotionId, sent: false };
    }

    try {
      const rpcReq: HarnessRpcReq = {
        callId: `exp_${Date.now()}`,
        method: "set_expression",
        params: { emotionId },
      };
      const payload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
      const sent = this.server.sendToRobot(FrameType.HARNESS_RPC_REQ, payload);
      return { emotionId, sent };
    } catch {
      return { emotionId, sent: false };
    }
  }

  private sendRobotSound(soundId: string): { soundId: string; sent: boolean } {
    if (!this.server) {
      return { soundId, sent: false };
    }

    try {
      const rpcReq: HarnessRpcReq = {
        callId: `snd_${Date.now()}`,
        method: "play_sound",
        params: { soundId },
      };
      const payload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
      const sent = this.server.sendToRobot(FrameType.HARNESS_RPC_REQ, payload);
      return { soundId, sent };
    } catch {
      return { soundId, sent: false };
    }
  }

  private sendRobotToast(
    message: string,
    durationMs: number = 3000
  ): { message: string; durationMs: number; sent: boolean } {
    if (!this.server) {
      return { message, durationMs, sent: false };
    }

    try {
      const rpcReq: HarnessRpcReq = {
        callId: `tst_${Date.now()}`,
        method: "show_toast",
        params: { message, durationMs },
      };
      const payload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
      const sent = this.server.sendToRobot(FrameType.HARNESS_RPC_REQ, payload);
      return { message, durationMs, sent };
    } catch {
      return { message, durationMs, sent: false };
    }
  }

  private async cancellableDelay(ms: number, signal?: AbortSignal): Promise<{ delayedMs: number }> {
    if (ms <= 0) return { delayedMs: 0 };
    if (signal?.aborted) {
      const err = new Error("Workflow delay aborted");
      err.name = "AbortError";
      throw err;
    }

    return new Promise<{ delayedMs: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({ delayedMs: ms });
      }, ms);

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const err = new Error("Workflow delay aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true }
        );
      }
    });
  }

  // ============================================================================
  // Persistence & Lifecycle
  // ============================================================================

  private loadWorkflows(): void {
    try {
      if (fs.existsSync(this.workflowsFilePath)) {
        const raw = fs.readFileSync(this.workflowsFilePath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const validated = NoCodeWorkflowSchema.safeParse(item);
            if (validated.success) {
              this.workflows.set(validated.data.id, validated.data);
            }
          }
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "[WorkflowEngine] Failed to load workflows, using defaults");
    }

    // Pre-seed built-ins if missing
    for (const builtin of BUILTIN_WORKFLOWS) {
      if (!this.workflows.has(builtin.id)) {
        this.workflows.set(builtin.id, builtin);
      }
    }

    this.persistWorkflows();
  }

  private persistWorkflows(): void {
    try {
      const dir = path.dirname(this.workflowsFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const list = Array.from(this.workflows.values());
      fs.writeFileSync(this.workflowsFilePath, JSON.stringify(list, null, 2), "utf8");
    } catch (err) {
      this.logger.warn({ err }, "[WorkflowEngine] Failed to persist workflows to disk");
    }
  }

  private bindTriggers(): void {
    if (this.telemetryMonitor) {
      this.bindTelemetryEvents();
    }
  }

  private bindTelemetryEvents(): void {
    if (!this.telemetryMonitor) return;

    this.telemetryMonitor.on("telemetry", (snapshot: TelemetrySnapshot) => {
      // 1. Meeting state transitions
      const isMeeting = Boolean(snapshot.inMeeting || snapshot.meetingActive);
      if (isMeeting && !this.prevInMeeting) {
        this.handleDesktopEvent("ON_MEETING_STARTED", snapshot);
      } else if (!isMeeting && this.prevInMeeting) {
        this.handleDesktopEvent("ON_MEETING_ENDED", snapshot);
      }
      this.prevInMeeting = isMeeting;

      // 2. High CPU load
      if (snapshot.cpuLoadPct >= 85) {
        this.handleDesktopEvent("ON_HIGH_CPU_LOAD", snapshot);
      }
    });
  }
}
