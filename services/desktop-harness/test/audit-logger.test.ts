import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RiskTier } from "@petbot/protocol";
import { AuditLogger, type AuditLogEntry } from "../src/sandbox/audit-logger.js";

describe("AuditLogger", () => {
  let tempDir: string;
  let logFile: string;
  let logger: AuditLogger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot_audit_test_"));
    logFile = path.join(tempDir, "audit.jsonl");
    logger = new AuditLogger({
      logFilePath: logFile,
      maxRingBufferSize: 5, // Small buffer to test ring capacity
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("logs structured events with automatic ID and timestamp generation", () => {
    const entry = logger.log({
      sourceDeviceId: "petbot-esp32-livingroom",
      actionId: "toggle_mic_mute",
      riskTier: RiskTier.TIER_1_SAFE,
      status: "COMPLETED",
      humanSummary: "Muted PC microphone via Robot Tap",
      durationMs: 4,
      details: { muted: true },
    });

    expect(entry.id).toMatch(/^audit_\d+_[a-f0-9]+/);
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(entry.sourceDeviceId).toBe("petbot-esp32-livingroom");
    expect(entry.actionId).toBe("toggle_mic_mute");
    expect(entry.riskTier).toBe(RiskTier.TIER_1_SAFE);
    expect(entry.status).toBe("COMPLETED");
    expect(entry.durationMs).toBe(4);
    expect(entry.humanSummary).toBe("Muted PC microphone via Robot Tap");
    expect(entry.details?.["muted"]).toBe(true);

    const retrieved = logger.getEntryById(entry.id);
    expect(retrieved).toEqual(entry);
  });

  it("appends entries to disk JSONL file and reads them back accurately", () => {
    logger.log({
      id: "audit_1",
      sourceDeviceId: "device_a",
      actionId: "set_volume",
      riskTier: RiskTier.TIER_1_SAFE,
      status: "EXECUTING",
      humanSummary: "Adjusted PC volume to 60%",
    });

    logger.log({
      id: "audit_2",
      sourceDeviceId: "device_b",
      actionId: "delete_temp_files",
      riskTier: RiskTier.TIER_3_2FA_REQUIRED,
      status: "AWAITING_ROBOT_2FA",
      humanSummary: "Awaiting Touch 2FA for file cleanup",
    });

    expect(fs.existsSync(logFile)).toBe(true);
    const diskEntries = logger.readLogFile();
    expect(diskEntries).toHaveLength(2);
    expect(diskEntries[0]?.id).toBe("audit_1");
    expect(diskEntries[0]?.status).toBe("EXECUTING");
    expect(diskEntries[1]?.id).toBe("audit_2");
    expect(diskEntries[1]?.status).toBe("AWAITING_ROBOT_2FA");

    // Reading with maxLines slice
    const sliced = logger.readLogFile(1);
    expect(sliced).toHaveLength(1);
    expect(sliced[0]?.id).toBe("audit_2");
  });

  it("maintains a fixed ring buffer capacity and drops oldest events when full", () => {
    for (let i = 1; i <= 8; i++) {
      logger.log({
        id: `audit_event_${i}`,
        sourceDeviceId: "test_dev",
        actionId: `action_${i}`,
        riskTier: RiskTier.TIER_1_SAFE,
        status: "COMPLETED",
        humanSummary: `Event ${i}`,
      });
    }

    const ring = logger.getRingBuffer();
    expect(ring).toHaveLength(5); // Capacity is 5
    expect(ring[0]?.id).toBe("audit_event_4");
    expect(ring[4]?.id).toBe("audit_event_8");

    // Check map cleanup for dropped elements
    expect(logger.getEntryById("audit_event_1")).toBeUndefined();
    expect(logger.getEntryById("audit_event_4")).toBeDefined();

    // Query recent entries (newest first)
    const recent = logger.getRecentEntries(3);
    expect(recent).toHaveLength(3);
    expect(recent[0]?.id).toBe("audit_event_8");
    expect(recent[1]?.id).toBe("audit_event_7");
    expect(recent[2]?.id).toBe("audit_event_6");
  });

  it("updates existing event status through its lifecycle and appends transitions to disk", () => {
    const entryId = "audit_lifecycle_test";
    logger.log({
      id: entryId,
      sourceDeviceId: "robot_livingroom",
      actionId: "production_deploy",
      riskTier: RiskTier.TIER_3_2FA_REQUIRED,
      status: "AWAITING_ROBOT_2FA",
      humanSummary: "Awaiting Robot Touch 2FA for production deployment",
    });

    const step2 = logger.updateStatus(entryId, "APPROVED_BY_TOUCH", {
      humanSummary: "Approved production deploy via Robot Physical Touch",
    });
    expect(step2?.status).toBe("APPROVED_BY_TOUCH");
    expect(step2?.humanSummary).toBe("Approved production deploy via Robot Physical Touch");

    const step3 = logger.updateStatus(entryId, "COMPLETED", {
      durationMs: 1420,
      humanSummary: "Completed production deployment",
      details: { exitCode: 0 },
    });
    expect(step3?.status).toBe("COMPLETED");
    expect(step3?.durationMs).toBe(1420);
    expect(step3?.details?.["exitCode"]).toBe(0);

    // Verify ring buffer holds final updated state
    const current = logger.getEntryById(entryId);
    expect(current?.status).toBe("COMPLETED");
    expect(current?.durationMs).toBe(1420);

    // Verify disk has full lifecycle entries appended (3 lines)
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("emits events for real-time subscribers", async () => {
    const events: AuditLogEntry[] = [];
    logger.on("audit", (entry) => {
      events.push(entry);
    });

    logger.log({
      sourceDeviceId: "companion_app",
      actionId: "lock_workstation",
      riskTier: RiskTier.TIER_1_SAFE,
      status: "COMPLETED",
      humanSummary: "Workstation locked from companion app",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.actionId).toBe("lock_workstation");
  });

  it("safely handles non-existent or corrupted files without throwing", () => {
    const nonExistent = new AuditLogger({
      logFilePath: path.join(tempDir, "does_not_exist", "log.jsonl"),
      disabled: false,
    });

    expect(nonExistent.readLogFile()).toEqual([]);

    // Write a corrupt line to log file
    fs.appendFileSync(logFile, "INVALID_JSON_CORRUPTED\n", "utf8");
    const valid = logger.readLogFile();
    expect(Array.isArray(valid)).toBe(true);
  });
});
