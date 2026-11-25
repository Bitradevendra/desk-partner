import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RiskTier } from "@petbot/protocol";
import {
  CapabilitySandbox,
  validatePathSafety,
  type HarnessRpcRequest,
} from "../src/sandbox/capability-sandbox.js";
import { AuditLogger } from "../src/sandbox/audit-logger.js";
import { createOSAdapter, type OSAutomationAdapter } from "../src/os/os-adapters.js";

describe("CapabilitySandbox & Policy Gate", () => {
  let tempDir: string;
  let logFile: string;
  let auditLogger: AuditLogger;
  let osAdapter: OSAutomationAdapter;
  let sandbox: CapabilitySandbox;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot_sandbox_test_"));
    logFile = path.join(tempDir, "audit.jsonl");
    auditLogger = new AuditLogger({
      logFilePath: logFile,
      maxRingBufferSize: 50,
    });
    osAdapter = createOSAdapter({ mock: true });
    sandbox = new CapabilitySandbox({
      osAdapter,
      auditLogger,
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Path Traversal and Security Boundaries", () => {
    it("detects and rejects directory traversal sequences (..)", () => {
      const res1 = validatePathSafety("../etc/passwd");
      expect(res1.safe).toBe(false);
      expect(res1.reason).toContain("Path traversal sequence '..' detected");

      const res2 = validatePathSafety("subfolder/../../secrets.txt");
      expect(res2.safe).toBe(false);
      expect(res2.reason).toContain("Path traversal sequence '..' detected");
    });

    it("rejects system root and OS critical directories", () => {
      const resUnix = validatePathSafety("/etc");
      expect(resUnix.safe).toBe(false);
      expect(resUnix.reason).toContain("system root directory");

      const resWin = validatePathSafety("C:\\Windows");
      expect(resWin.safe).toBe(false);
      expect(resWin.reason).toContain("system root directory");
    });

    it("rejects sensitive credential directories and files (~/.ssh, ~/.petbot, etc.)", () => {
      const resSsh = validatePathSafety("/home/user/.ssh/id_rsa");
      expect(resSsh.safe).toBe(false);
      expect(resSsh.reason).toContain("sensitive credential or configuration path");

      const resPetbot = validatePathSafety("C:\\Users\\user\\.petbot\\vault.json");
      expect(resPetbot.safe).toBe(false);
      expect(resPetbot.reason).toContain("sensitive credential or configuration path");
    });

    it("allows valid non-traversal scratch paths inside temp directory", () => {
      const safePath = path.join(os.tmpdir(), "petbot_scratch", "file.txt");
      const res = validatePathSafety(safePath);
      expect(res.safe).toBe(true);
    });
  });

  describe("Risk-Tier Policy Gate & Downgrade Prevention", () => {
    it("strictly prevents client from downgrading a Tier-3 action to Tier-1", async () => {
      // delete_temp_files is canonically Tier 3
      const req: HarnessRpcRequest = {
        callId: "req_downgrade_attempt",
        actionId: "delete_temp_files",
        riskTier: RiskTier.TIER_1_SAFE, // Attempting to bypass 2FA by claiming Tier 1!
        params: {
          targetPaths: [path.join(os.tmpdir(), "test_file.tmp")],
        },
      };

      // Without a server / robot to approve 2FA, it must enforce Tier-3 and fail hardware 2FA
      const res = await sandbox.executeSandboxedAction(req, "hacker_device");
      expect(res.ok).toBe(false);
      expect(res.error).toBe("HARDWARE_2FA_DENIED");
      expect(res.riskTier).toBe(RiskTier.TIER_3_2FA_REQUIRED);

      // Verify audit log recorded AWAITING_ROBOT_2FA and DENIED_BY_TOUCH with Tier 3
      const entry = auditLogger.getEntryById("req_downgrade_attempt");
      expect(entry).toBeDefined();
      expect(entry?.riskTier).toBe(RiskTier.TIER_3_2FA_REQUIRED);
      expect(entry?.status).toBe("DENIED_BY_TOUCH");
    });

    it("rejects unknown action IDs immediately as BLOCKED_UNAUTHORIZED", async () => {
      const req: HarnessRpcRequest = {
        callId: "req_unknown_action",
        actionId: "malicious_kernel_exploit",
        params: {},
      };

      const res = await sandbox.executeSandboxedAction(req, "test_client");
      expect(res.ok).toBe(false);
      expect(res.error).toBe("UNKNOWN_OR_UNAUTHORIZED_ACTION");

      const entry = auditLogger.getEntryById("req_unknown_action");
      expect(entry?.status).toBe("BLOCKED_UNAUTHORIZED");
      expect(entry?.humanSummary).toContain("Unknown action ID 'malicious_kernel_exploit'");
    });

    it("blocks actions attempting path traversal as BLOCKED_UNAUTHORIZED", async () => {
      const req: HarnessRpcRequest = {
        callId: "req_traversal_attack",
        actionId: "stage_vault_file",
        params: {
          filePath: "../../etc/shadow",
        },
      };

      const res = await sandbox.executeSandboxedAction(req, "test_client");
      expect(res.ok).toBe(false);
      expect(res.error).toBe("PATH_TRAVERSAL_DETECTED");

      const entry = auditLogger.getEntryById("req_traversal_attack");
      expect(entry?.status).toBe("BLOCKED_UNAUTHORIZED");
      expect(entry?.humanSummary).toContain("Path traversal sequence '..' detected");
    });
  });

  describe("Tier 1 Safe Instant Controls Execution", () => {
    it("executes Tier-1 volume change immediately and logs to audit feed", async () => {
      const req: HarnessRpcRequest = {
        callId: "call_vol_1",
        actionId: "set_volume",
        params: { level: 75 },
      };

      const res = await sandbox.executeSandboxedAction(req, "petbot-esp32-livingroom");
      expect(res.ok).toBe(true);
      expect(res.success).toBe(true);
      expect(res.result).toEqual({ volume: 75 });
      expect(res.riskTier).toBe(RiskTier.TIER_1_SAFE);
      expect(res.durationMs).toBeDefined();

      const entry = auditLogger.getEntryById("call_vol_1");
      expect(entry?.status).toBe("COMPLETED");
      expect(entry?.humanSummary).toBe("Completed: Adjusted PC volume to 75%");
    });

    it("executes Tier-1 media control and workstation lock", async () => {
      const mediaReq: HarnessRpcRequest = {
        callId: "call_media_1",
        actionId: "media_play_pause",
      };
      const mediaRes = await sandbox.executeSandboxedAction(mediaReq, "companion-app");
      expect(mediaRes.ok).toBe(true);
      expect(mediaRes.result?.["action"]).toBe("PLAY_PAUSE");

      const lockReq: HarnessRpcRequest = {
        callId: "call_lock_1",
        actionId: "lock_workstation",
      };
      const lockRes = await sandbox.executeSandboxedAction(lockReq, "companion-app");
      expect(lockRes.ok).toBe(true);
      expect(lockRes.result?.["locked"]).toBe(true);
    });
  });

  describe("Tier 2 Approved Workflow Manifest", () => {
    it("executes approved whitelisted workflow script (git_status)", async () => {
      const req: HarnessRpcRequest = {
        callId: "call_wf_approved",
        actionId: "run_workflow",
        params: {
          scriptId: "git_status",
          args: [],
        },
      };

      const res = await sandbox.executeSandboxedAction(req, "companion-app");
      expect(res.ok).toBe(true);
      expect(res.success).toBe(true);
      expect(res.result?.["exitCode"]).toBe(0);

      const entry = auditLogger.getEntryById("call_wf_approved");
      expect(entry?.status).toBe("COMPLETED");
      expect(entry?.riskTier).toBe(RiskTier.TIER_2_WORKFLOW);
    });

    it("blocks workflow scripts not registered in approved manifest", async () => {
      const req: HarnessRpcRequest = {
        callId: "call_wf_unapproved",
        actionId: "run_workflow",
        params: {
          scriptId: "format_c_drive",
        },
      };

      const res = await sandbox.executeSandboxedAction(req, "companion-app");
      expect(res.ok).toBe(false);
      expect(res.error).toBe("WORKFLOW_NOT_APPROVED_IN_MANIFEST");

      const entry = auditLogger.getEntryById("call_wf_unapproved");
      expect(entry?.status).toBe("BLOCKED_UNAUTHORIZED");
      expect(entry?.humanSummary).toContain("Blocked unapproved workflow 'run_workflow'");
    });

    it("allows dynamically registered workflows", async () => {
      sandbox.registerApprovedWorkflow("custom_backup_job");

      expect(sandbox.isWorkflowApproved("run_workflow", { scriptId: "custom_backup_job" })).toBe(true);
    });
  });

  describe("Tier 3 Hardware Physical Touch 2FA Interceptor", () => {
    it("grants execution when hardware Touch 2FA is cryptographically approved", async () => {
      const mockServer = {
        requestHardwareTouch2FA: vi.fn().mockResolvedValue(true),
        sendToRobot: vi.fn().mockReturnValue(true),
        broadcastToCompanions: vi.fn(),
        on: vi.fn(),
      } as any;

      const sandboxWith2FA = new CapabilitySandbox({
        osAdapter,
        auditLogger,
        server: mockServer,
      });

      const req: HarnessRpcRequest = {
        callId: "call_prod_deploy",
        actionId: "production_deploy",
        params: { service: "auth-gateway" },
      };

      const res = await sandboxWith2FA.executeSandboxedAction(req, "admin_companion");
      expect(res.ok).toBe(true);
      expect(mockServer.requestHardwareTouch2FA).toHaveBeenCalledWith(
        "Approve SSH Deployment to Production",
        RiskTier.TIER_3_2FA_REQUIRED,
        15000
      );

      const entry = auditLogger.getEntryById("call_prod_deploy");
      expect(entry?.status).toBe("COMPLETED");
    });

    it("strictly blocks execution when hardware Touch 2FA is denied or times out", async () => {
      const mockServer = {
        requestHardwareTouch2FA: vi.fn().mockResolvedValue(false), // User denied via Long Press
        sendToRobot: vi.fn().mockReturnValue(true),
        broadcastToCompanions: vi.fn(),
        on: vi.fn(),
      } as any;

      const sandboxWith2FA = new CapabilitySandbox({
        osAdapter,
        auditLogger,
        server: mockServer,
      });

      const req: HarnessRpcRequest = {
        callId: "call_clean_temp",
        actionId: "empty_trash",
        params: {},
      };

      const res = await sandboxWith2FA.executeSandboxedAction(req, "unknown_client");
      expect(res.ok).toBe(false);
      expect(res.error).toBe("HARDWARE_2FA_DENIED");

      const entry = auditLogger.getEntryById("call_clean_temp");
      expect(entry?.status).toBe("DENIED_BY_TOUCH");
      expect(entry?.humanSummary).toContain("Denied on Robot Touch Sensor");
    });
  });

  describe("Emergency Physical Kill-Switch", () => {
    it("aborts active in-flight tasks and logs KILLED_BY_USER", async () => {
      // Create a slow running mock workflow
      const slowOSAdapter = createOSAdapter({ mock: true });
      slowOSAdapter.executeApprovedShellWorkflow = vi.fn().mockImplementation(
        (_scriptId, _args, signal) =>
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => resolve({ exitCode: 0, stdout: "done", stderr: "" }), 2000);
            signal?.addEventListener("abort", () => {
              clearTimeout(timeout);
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      );

      const sandboxWithKill = new CapabilitySandbox({
        osAdapter: slowOSAdapter,
        auditLogger,
      });

      // Start in-flight task
      const taskPromise = sandboxWithKill.executeSandboxedAction(
        {
          callId: "task_long_running",
          actionId: "run_workflow",
          params: { scriptId: "pnpm_test" },
        },
        "robot_1"
      );

      // Verify task is registered in active tasks
      await new Promise((r) => setTimeout(r, 20));
      expect(sandboxWithKill.getActiveTasks().size).toBe(1);

      // Trigger emergency kill-switch
      const killResult = await sandboxWithKill.triggerEmergencyKillSwitch(
        "User performed LONG_PRESS on physical touch pad"
      );
      expect(killResult.abortedTasksCount).toBe(1);
      expect(sandboxWithKill.getActiveTasks().size).toBe(0);

      const res = await taskPromise;
      expect(res.ok).toBe(false);
      expect(res.error).toBe("ABORTED_BY_KILL_SWITCH");

      const entry = auditLogger.getEntryById("task_long_running");
      expect(entry?.status).toBe("KILLED_BY_USER");
      expect(entry?.humanSummary).toContain("Aborted by emergency kill-switch");
    });
  });
});
