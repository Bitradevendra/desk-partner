import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EmotionId, RiskTier } from "@petbot/protocol";
import {
  WorkflowEngine,
  BUILTIN_WORKFLOWS,
  type NoCodeWorkflow,
} from "../src/workflows/workflow-engine.js";
import { CapabilitySandbox } from "../src/sandbox/capability-sandbox.js";
import { AuditLogger } from "../src/sandbox/audit-logger.js";
import { createOSAdapter } from "../src/os/os-adapters.js";

describe("WorkflowEngine - No-Code Multi-Step Automations", () => {
  let tempDir: string;
  let logFile: string;
  let workflowsFile: string;
  let sandbox: CapabilitySandbox;
  let auditLogger: AuditLogger;
  let engine: WorkflowEngine;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot_wf_test_"));
    logFile = path.join(tempDir, "audit.jsonl");
    workflowsFile = path.join(tempDir, "workflows.json");

    auditLogger = new AuditLogger({
      logFilePath: logFile,
      maxRingBufferSize: 50,
    });
    const osAdapter = createOSAdapter({ mock: true });
    sandbox = new CapabilitySandbox({
      osAdapter,
      auditLogger,
    });
    engine = new WorkflowEngine({
      sandbox,
      auditLogger,
      workflowsFilePath: workflowsFile,
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("initializes and persists the 4 built-in productivity workflows", () => {
    const list = engine.listWorkflows();
    expect(list.length).toBeGreaterThanOrEqual(4);

    const ids = list.map((w) => w.id);
    expect(ids).toContain("wf_meeting_shield");
    expect(ids).toContain("wf_privacy_lock");
    expect(ids).toContain("wf_downloads_sweep");
    expect(ids).toContain("wf_secure_purge_2fa");

    expect(fs.existsSync(workflowsFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(workflowsFile, "utf8"));
    expect(content.length).toBeGreaterThanOrEqual(4);
  });

  it("supports saving, updating, and deleting custom workflows", () => {
    const custom: NoCodeWorkflow = {
      id: "wf_coffee_break",
      name: "Coffee Break Alert",
      enabled: true,
      trigger: {
        type: "ROBOT_WIDGET_ACTION",
        actionId: "coffee_break_tap",
      },
      steps: [
        {
          type: "ROBOT_SET_EXPRESSION",
          emotion: EmotionId.HAPPY,
        },
        {
          type: "ROBOT_SHOW_TOAST",
          message: "Time for coffee!",
          durationMs: 3000,
        },
      ],
    };

    engine.saveWorkflow(custom);
    expect(engine.getWorkflow("wf_coffee_break")).toBeDefined();

    const deleted = engine.deleteWorkflow("wf_coffee_break");
    expect(deleted).toBe(true);
    expect(engine.getWorkflow("wf_coffee_break")).toBeUndefined();
  });

  it("executes the '1-Tap Instant Privacy Lock' workflow cleanly through CapabilitySandbox", async () => {
    const result = await engine.executeWorkflow("wf_privacy_lock", {
      sourceDeviceId: "robot-desk-1",
    });

    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(5);
    expect(result.stepResults).toHaveLength(5);
    expect(result.stepResults[0]?.type).toBe("OS_ACTION");
    expect(result.stepResults[1]?.type).toBe("OS_ACTION");
    expect(result.stepResults[2]?.type).toBe("ROBOT_SET_EXPRESSION");
    expect(result.stepResults[3]?.type).toBe("OS_ACTION");
    expect(result.stepResults[4]?.type).toBe("ROBOT_SHOW_TOAST");
  });

  it("triggers workflows on desktop event (ON_MEETING_STARTED)", async () => {
    const results = await engine.handleDesktopEvent("ON_MEETING_STARTED");
    expect(results.length).toBeGreaterThanOrEqual(1);

    const shieldRes = results.find((r) => r.workflowId === "wf_meeting_shield");
    expect(shieldRes).toBeDefined();
    expect(shieldRes?.success).toBe(true);
    expect(shieldRes?.stepsExecuted).toBe(3);
  });

  it("halts execution when aborted mid-delay step", async () => {
    const slowWorkflow: NoCodeWorkflow = {
      id: "wf_slow_timer",
      name: "Slow Timer Workflow",
      enabled: true,
      trigger: {
        type: "ROBOT_WIDGET_ACTION",
        actionId: "start_timer",
      },
      steps: [
        {
          type: "ROBOT_SHOW_TOAST",
          message: "Starting 5s delay",
        },
        {
          type: "DELAY_MS",
          delayMs: 2000,
        },
        {
          type: "ROBOT_SHOW_TOAST",
          message: "Finished delay",
        },
      ],
    };

    engine.saveWorkflow(slowWorkflow);

    const abortController = new AbortController();

    const execPromise = engine.executeWorkflow(slowWorkflow, {
      abortSignal: abortController.signal,
    });

    // Abort after 50ms while in DELAY_MS
    setTimeout(() => {
      abortController.abort();
    }, 50);

    const res = await execPromise;
    expect(res.success).toBe(false);
    expect(res.error).toContain("aborted");
    expect(res.stepsExecuted).toBeLessThan(3);
  });
});
