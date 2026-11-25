import { EventEmitter } from "node:events";
import pino from "pino";
import {
  FrameType,
  EmotionId,
  RiskTier,
  encodeControlPayload,
  encodeAudioDownlinkFrame,
  HarnessRpcReqSchema,
  type HarnessRpcReq,
} from "@petbot/protocol";
import type { HarnessServer } from "../transport/harness-server.js";
import type { HeadlessPartnerToolBus } from "./headless-tool-bus.js";
import type { OssAgentEcosystemLoader } from "../integrations/oss-loader.js";

export interface StepExecutionContext {
  stepIndex: number;
  totalSteps: number;
  loader?: OssAgentEcosystemLoader | undefined;
  toolBus?: HeadlessPartnerToolBus | undefined;
  server?: HarnessServer | undefined;
  logger: pino.Logger;
  signal?: AbortSignal | undefined;
  updateProgress: (stepPct: number, message?: string) => void;
}

export interface TaskStep {
  name: string;
  description?: string;
  riskTier?: RiskTier;
  execute: (context: StepExecutionContext) => Promise<any>;
}

export interface HudTaskDefinition {
  id?: string | undefined;
  name: string;
  description?: string | undefined;
  steps: TaskStep[];
  abortSignal?: AbortSignal | undefined;
}

export interface StepResultRecord {
  stepIndex: number;
  stepName: string;
  success: boolean;
  result?: any;
  error?: string | undefined;
  durationMs: number;
  required2Fa: boolean;
  approved2Fa?: boolean | undefined;
}

export interface HudTaskResult {
  taskId: string;
  taskName: string;
  success: boolean;
  stepsExecuted: number;
  totalSteps: number;
  stepResults: StepResultRecord[];
  durationMs: number;
  error?: string;
}

export interface HudProgressUpdate {
  taskName: string;
  currentStep: number;
  totalSteps: number;
  stepDescription: string;
  progressPercent: number; // 0..100
  state: "RUNNING" | "PAUSED_2FA" | "COMPLETED" | "FAILED" | "ABORTED";
  details?: Record<string, any>;
}

export interface RobotLiveHudBridgeOptions {
  server: HarnessServer;
  toolBus?: HeadlessPartnerToolBus | undefined;
  logger?: pino.Logger | undefined;
  default2FaTimeoutMs?: number;
}

/**
 * RobotLiveHudBridge
 *
 * Coordinates live, real-time background task monitoring and physical 2FA authorization
 * on the physical ESP32-S3's 1.8" TFT display and capacitive touch sensor.
 *
 * Capabilities:
 * - Streams compact HUD progress state (`task_progress_hud` RPC) with animated progress bar.
 * - Sets robot expression to `EmotionId.FOCUSED` during execution.
 * - Restores robot expression to `EmotionId.HAPPY` and plays `HAPPY_TRILL` sound chime on completion.
 * - Automatically pauses on `RiskTier.TIER_3_2FA_REQUIRED` steps, triggers `TOUCH_2FA_CHALLENGE`,
 *   and resumes the exact millisecond the user touches the physical robot sensor (`SINGLE_TAP`).
 */
export class RobotLiveHudBridge extends EventEmitter {
  private readonly server: HarnessServer;
  private readonly toolBus?: HeadlessPartnerToolBus | undefined;
  private readonly logger: pino.Logger;
  private readonly default2FaTimeoutMs: number;
  private isTaskRunning = false;

  constructor(options: RobotLiveHudBridgeOptions) {
    super();
    this.server = options.server;
    this.toolBus = options.toolBus;
    this.default2FaTimeoutMs = options.default2FaTimeoutMs ?? 15000;
    this.logger =
      options.logger ??
      pino({
        name: "petbot-hud-bridge",
        level: process.env["LOG_LEVEL"] ?? "info",
      });
  }

  public isBusy(): boolean {
    return this.isTaskRunning;
  }

  /**
   * Executes a multi-step task in the background while streaming progress and 2FA prompts
   * to the physical robot's 1.8" TFT display.
   */
  public async executeTaskWithHud(task: HudTaskDefinition): Promise<HudTaskResult> {
    const taskId = task.id ?? `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startTime = Date.now();
    this.isTaskRunning = true;

    this.logger.info(
      { taskId, taskName: task.name, stepCount: task.steps.length },
      "[RobotLiveHudBridge] Starting multi-step background task"
    );

    this.emit("taskStart", { taskId, taskName: task.name, totalSteps: task.steps.length });

    // 1. Initial State: Set robot to FOCUSED emotion and display starting HUD
    this.sendExpression(EmotionId.FOCUSED);
    this.showToast(task.name, 2500);

    this.streamHudProgress({
      taskName: task.name,
      currentStep: 0,
      totalSteps: task.steps.length,
      stepDescription: `Starting: ${task.name}`,
      progressPercent: 0,
      state: "RUNNING",
    });

    const stepResults: StepResultRecord[] = [];

    try {
      for (let i = 0; i < task.steps.length; i++) {
        const step = task.steps[i]!;
        const stepIndex = i + 1;
        const stepStartTime = Date.now();

        // Check if aborted
        if (task.abortSignal?.aborted) {
          const abortError = new Error(`Task "${task.name}" was cancelled by abort signal.`);
          this.handleTaskAborted(task, i, stepResults, startTime);
          throw abortError;
        }

        const isTier3 = step.riskTier === RiskTier.TIER_3_2FA_REQUIRED;
        const stepBasePct = Math.round((i / task.steps.length) * 100);

        this.emit("stepStart", {
          taskId,
          stepIndex,
          stepName: step.name,
          riskTier: step.riskTier ?? RiskTier.TIER_1_SAFE,
        });

        // 2. Hardware 2FA Interception Gate for Tier 3 Actions
        let approved2Fa: boolean | undefined = undefined;

        if (isTier3) {
          this.logger.warn(
            { taskId, stepIndex, stepName: step.name },
            "[RobotLiveHudBridge] Tier-3 action detected. Requesting physical hardware touch 2FA..."
          );

          this.emit("2faPrompt", {
            taskId,
            stepIndex,
            stepName: step.name,
            riskTier: RiskTier.TIER_3_2FA_REQUIRED,
          });

          // Update HUD to show 2FA prompt
          this.streamHudProgress({
            taskName: task.name,
            currentStep: stepIndex,
            totalSteps: task.steps.length,
            stepDescription: `Authorize on Robot: ${step.name}`,
            progressPercent: stepBasePct,
            state: "PAUSED_2FA",
            details: { action: step.name, riskTier: "TIER_3_2FA_REQUIRED" },
          });

          this.sendExpression(EmotionId.ALERT);
          this.showToast(`Tap Robot: ${step.name}`, this.default2FaTimeoutMs);

          const approved = await this.server.requestHardwareTouch2FA(
            step.name,
            RiskTier.TIER_3_2FA_REQUIRED,
            this.default2FaTimeoutMs
          );

          approved2Fa = approved;
          this.emit("2faResult", { taskId, stepIndex, approved });

          if (!approved) {
            const errReason = `Hardware 2FA confirmation rejected or timed out for step "${step.name}".`;
            this.logger.error({ taskId, stepIndex }, `[RobotLiveHudBridge] ${errReason}`);

            this.streamHudProgress({
              taskName: task.name,
              currentStep: stepIndex,
              totalSteps: task.steps.length,
              stepDescription: `2FA Rejected: ${step.name}`,
              progressPercent: stepBasePct,
              state: "FAILED",
            });

            this.sendExpression(EmotionId.ALERT);
            this.showToast("2FA Denied / Timed Out", 3000);

            const failedRecord: StepResultRecord = {
              stepIndex,
              stepName: step.name,
              success: false,
              error: errReason,
              durationMs: Date.now() - stepStartTime,
              required2Fa: true,
              approved2Fa: false,
            };
            stepResults.push(failedRecord);

            const failureResult: HudTaskResult = {
              taskId,
              taskName: task.name,
              success: false,
              stepsExecuted: i,
              totalSteps: task.steps.length,
              stepResults,
              durationMs: Date.now() - startTime,
              error: errReason,
            };

            this.emit("taskComplete", failureResult);
            return failureResult;
          }

          // 2FA Approved: Return to FOCUSED expression and notify user
          this.logger.info(
            { taskId, stepIndex },
            "[RobotLiveHudBridge] Hardware 2FA approved! Resuming execution..."
          );
          this.sendExpression(EmotionId.FOCUSED);
        }

        // 3. Update HUD to running status for current step
        const stepProgressDesc = `Step ${stepIndex}/${task.steps.length}: ${step.name}`;
        this.streamHudProgress({
          taskName: task.name,
          currentStep: stepIndex,
          totalSteps: task.steps.length,
          stepDescription: stepProgressDesc,
          progressPercent: stepBasePct,
          state: "RUNNING",
        });

        // 4. Execute step logic with contextual progress updates
        let stepOutput: any;
        const subContext: StepExecutionContext = {
          stepIndex,
          totalSteps: task.steps.length,
          loader: this.toolBus?.getLoader(),
          toolBus: this.toolBus,
          server: this.server,
          logger: this.logger,
          signal: task.abortSignal,
          updateProgress: (stepPct: number, msg?: string) => {
            const boundedStepPct = Math.min(100, Math.max(0, stepPct));
            const overallPct = Math.round(
              ((i + boundedStepPct / 100) / task.steps.length) * 100
            );
            this.streamHudProgress({
              taskName: task.name,
              currentStep: stepIndex,
              totalSteps: task.steps.length,
              stepDescription: msg ?? `Step ${stepIndex}/${task.steps.length}: ${step.name}`,
              progressPercent: overallPct,
              state: "RUNNING",
            });
          },
        };

        stepOutput = await step.execute(subContext);

        const stepDurationMs = Date.now() - stepStartTime;
        const successRecord: StepResultRecord = {
          stepIndex,
          stepName: step.name,
          success: true,
          result: stepOutput,
          durationMs: stepDurationMs,
          required2Fa: isTier3,
          approved2Fa,
        };
        stepResults.push(successRecord);

        this.emit("stepComplete", successRecord);

        // Update progress bar after completing step
        const completedPct = Math.round((stepIndex / task.steps.length) * 100);
        this.streamHudProgress({
          taskName: task.name,
          currentStep: stepIndex,
          totalSteps: task.steps.length,
          stepDescription: `Completed: ${step.name}`,
          progressPercent: completedPct,
          state: "RUNNING",
        });
      }

      // 5. Task Successful Completion:
      // Stream 100% progress, set EmotionId.HAPPY, and play HAPPY_TRILL chime sound
      const totalDurationMs = Date.now() - startTime;
      this.streamHudProgress({
        taskName: task.name,
        currentStep: task.steps.length,
        totalSteps: task.steps.length,
        stepDescription: "Task Finished Successfully!",
        progressPercent: 100,
        state: "COMPLETED",
      });

      this.sendExpression(EmotionId.HAPPY);
      this.playSound("HAPPY_TRILL");
      this.showToast(`Completed: ${task.name}`, 3500);

      const finalResult: HudTaskResult = {
        taskId,
        taskName: task.name,
        success: true,
        stepsExecuted: task.steps.length,
        totalSteps: task.steps.length,
        stepResults,
        durationMs: totalDurationMs,
      };

      this.logger.info(
        { taskId, taskName: task.name, durationMs: totalDurationMs },
        "[RobotLiveHudBridge] Multi-step task finished successfully"
      );

      this.emit("taskComplete", finalResult);
      return finalResult;
    } catch (err: unknown) {
      const error = err as Error;
      const totalDurationMs = Date.now() - startTime;

      this.logger.error(
        { taskId, taskName: task.name, err: error.message },
        "[RobotLiveHudBridge] Task execution encountered an error"
      );

      this.streamHudProgress({
        taskName: task.name,
        currentStep: stepResults.length + 1,
        totalSteps: task.steps.length,
        stepDescription: `Error: ${error.message}`,
        progressPercent: Math.round((stepResults.length / task.steps.length) * 100),
        state: "FAILED",
      });

      this.sendExpression(EmotionId.ALERT);
      this.showToast(`Failed: ${error.message}`, 4000);

      const failureResult: HudTaskResult = {
        taskId,
        taskName: task.name,
        success: false,
        stepsExecuted: stepResults.length,
        totalSteps: task.steps.length,
        stepResults,
        durationMs: totalDurationMs,
        error: error.message,
      };

      this.emit("taskComplete", failureResult);
      return failureResult;
    } finally {
      this.isTaskRunning = false;
    }
  }

  /**
   * Helper to execute a sequence of TaskSteps.
   */
  public async executeSteps(
    taskName: string,
    steps: TaskStep[],
    abortSignal?: AbortSignal
  ): Promise<HudTaskResult> {
    return this.executeTaskWithHud({
      name: taskName,
      steps,
      ...(abortSignal !== undefined ? { abortSignal } : {}),
    });
  }

  /**
   * Helper to execute a single HeadlessPartnerToolBus tool wrapped in a HUD progress cycle.
   */
  public async executeToolWithHud(
    taskName: string,
    toolName: string,
    params: Record<string, any> = {},
    riskTierOverride?: RiskTier
  ): Promise<any> {
    if (!this.toolBus) {
      throw new Error("Cannot executeToolWithHud: HeadlessPartnerToolBus is not configured.");
    }

    const toolDef = this.toolBus.getTool(toolName);
    if (!toolDef) {
      throw new Error(`Tool "${toolName}" is not registered on HeadlessPartnerToolBus.`);
    }

    const effectiveRisk = riskTierOverride ?? toolDef.riskTier;

    const result = await this.executeTaskWithHud({
      name: taskName,
      steps: [
        {
          name: toolDef.name,
          description: toolDef.description,
          riskTier: effectiveRisk,
          execute: async (_ctx) => {
            return this.toolBus!.executeTool(toolName, params);
          },
        },
      ],
    });

    if (!result.success) {
      throw new Error(result.error ?? `Failed to execute tool "${toolName}".`);
    }

    return result.stepResults[0]?.result;
  }

  /**
   * Streams a compact progress update frame (FrameType.HARNESS_RPC_REQ -> task_progress_hud)
   * to the connected physical ESP32-S3 robot.
   */
  public streamHudProgress(progress: HudProgressUpdate): boolean {
    if (!this.server) {
      return false;
    }

    try {
      const rpcReq: HarnessRpcReq = {
        callId: `hud_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        method: "task_progress_hud",
        params: {
          taskName: progress.taskName,
          currentStep: progress.currentStep,
          totalSteps: progress.totalSteps,
          stepDescription: progress.stepDescription,
          progressPercent: progress.progressPercent,
          state: progress.state,
          activeWindow: progress.taskName,
          mediaState: `[${progress.currentStep}/${progress.totalSteps}] ${progress.stepDescription} (${progress.progressPercent}%)`,
          timestamp: Date.now(),
          ...(progress.details ? { details: progress.details } : {}),
        },
      };

      const payload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
      const sent = this.server.sendToRobot(FrameType.HARNESS_RPC_REQ, payload);

      this.emit("progress", progress);
      return sent;
    } catch (err) {
      this.logger.warn({ err }, "[RobotLiveHudBridge] Failed to stream HUD progress frame");
      return false;
    }
  }

  /**
   * Dispatches target emotion to the robot screen via both RPC and zero-copy audio downlink subheader.
   */
  public sendExpression(emotionId: EmotionId): boolean {
    if (!this.server) {
      return false;
    }

    let sent = false;
    try {
      // 1. RPC method set_expression
      const rpcReq: HarnessRpcReq = {
        callId: `exp_${Date.now()}`,
        method: "set_expression",
        params: { emotionId },
      };
      const payload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
      sent = this.server.sendToRobot(FrameType.HARNESS_RPC_REQ, payload);

      // 2. Real-time visual expression fast-path via AUDIO_DOWNLINK_FRAME
      const downlinkPayload = encodeAudioDownlinkFrame({
        emotionId,
        visemeMouthOpen: 0,
        eyeGazeX: 0,
        eyeGazeY: 0,
        audioData: new Uint8Array(0),
      });
      this.server.sendToRobot(FrameType.AUDIO_DOWNLINK_FRAME, downlinkPayload);
    } catch (err) {
      this.logger.warn({ err }, "[RobotLiveHudBridge] Failed to send expression update");
    }

    return sent;
  }

  /**
   * Plays a robotic procedural audio chime (e.g. HAPPY_TRILL, SUCCESS, CHIRP) on the ESP32-S3.
   */
  public playSound(soundId: string = "HAPPY_TRILL"): boolean {
    if (!this.server) {
      return false;
    }

    try {
      const rpcReq: HarnessRpcReq = {
        callId: `snd_${Date.now()}`,
        method: "play_sound",
        params: { soundId },
      };
      const payload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
      return this.server.sendToRobot(FrameType.HARNESS_RPC_REQ, payload);
    } catch (err) {
      this.logger.warn({ err }, "[RobotLiveHudBridge] Failed to send play_sound RPC");
      return false;
    }
  }

  /**
   * Shows a friendly toast notification on the 1.8" TFT display.
   */
  public showToast(message: string, durationMs: number = 3000): boolean {
    if (!this.server) {
      return false;
    }

    try {
      const rpcReq: HarnessRpcReq = {
        callId: `tst_${Date.now()}`,
        method: "show_toast",
        params: { message, durationMs },
      };
      const payload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
      return this.server.sendToRobot(FrameType.HARNESS_RPC_REQ, payload);
    } catch (err) {
      this.logger.warn({ err }, "[RobotLiveHudBridge] Failed to send show_toast RPC");
      return false;
    }
  }

  private handleTaskAborted(
    task: HudTaskDefinition,
    stepIndex: number,
    stepResults: StepResultRecord[],
    startTime: number
  ): void {
    this.logger.warn({ taskName: task.name, stepIndex }, "[RobotLiveHudBridge] Task aborted by user");
    this.streamHudProgress({
      taskName: task.name,
      currentStep: stepIndex,
      totalSteps: task.steps.length,
      stepDescription: "Task Cancelled",
      progressPercent: Math.round((stepIndex / task.steps.length) * 100),
      state: "ABORTED",
    });
    this.sendExpression(EmotionId.IDLE);
    this.showToast("Task Cancelled", 2500);

    const abortResult: HudTaskResult = {
      taskId: task.id ?? `aborted_${Date.now()}`,
      taskName: task.name,
      success: false,
      stepsExecuted: stepIndex,
      totalSteps: task.steps.length,
      stepResults,
      durationMs: Date.now() - startTime,
      error: "TASK_ABORTED",
    };
    this.emit("taskComplete", abortResult);
  }
}
