import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
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
import type { HarnessServer } from "../transport/harness-server.js";

/**
 * Audit status states representing the lifecycle of sandboxed actions.
 */
export const AuditStatusSchema = z.enum([
  "EXECUTING",
  "AWAITING_ROBOT_2FA",
  "APPROVED_BY_TOUCH",
  "DENIED_BY_TOUCH",
  "KILLED_BY_USER",
  "COMPLETED",
  "BLOCKED_UNAUTHORIZED",
]);
export type AuditStatus = z.infer<typeof AuditStatusSchema>;

/**
 * Structured schema for an audit log entry.
 */
export const AuditLogEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number().int().nonnegative(),
  sourceDeviceId: z.string(),
  actionId: z.string(),
  riskTier: z.nativeEnum(RiskTier),
  status: AuditStatusSchema,
  durationMs: z.number().nonnegative().optional(),
  humanSummary: z.string(),
  details: z.record(z.string(), z.any()).optional(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export interface AuditLoggerOptions {
  logFilePath?: string;
  maxRingBufferSize?: number;
  server?: HarnessServer;
  logger?: pino.Logger;
  disabled?: boolean;
}

export const DEFAULT_RING_BUFFER_CAPACITY = 200;

/**
 * AuditLogger: Maintains an append-only JSONL log on disk and an in-memory ring buffer
 * of the last 200 events, broadcasting real-time audit updates to connected Companion apps.
 */
export class AuditLogger extends EventEmitter {
  public readonly logFilePath: string;
  public readonly maxRingBufferSize: number;
  private readonly ringBuffer: AuditLogEntry[] = [];
  private readonly entryMap = new Map<string, AuditLogEntry>();
  private server: HarnessServer | null = null;
  private readonly logger: pino.Logger;
  private readonly disabled: boolean;

  constructor(options?: AuditLoggerOptions) {
    super();
    this.disabled = options?.disabled ?? false;
    this.maxRingBufferSize = options?.maxRingBufferSize ?? DEFAULT_RING_BUFFER_CAPACITY;
    this.server = options?.server ?? null;

    this.logger =
      options?.logger ??
      pino({
        name: "audit-logger",
        level: process.env["LOG_LEVEL"] ?? "info",
      });

    this.logFilePath =
      options?.logFilePath ??
      path.join(os.homedir(), ".petbot", "audit-log.jsonl");

    if (!this.disabled) {
      this.ensureLogDirectory();
    }
  }

  /**
   * Attaches or updates the active HarnessServer instance for companion broadcasting.
   */
  public setServer(server: HarnessServer | null): void {
    this.server = server;
  }

  /**
   * Logs a new audit event, records it in the in-memory ring buffer,
   * appends it to the disk JSONL file, and broadcasts it to connected companions.
   */
  public log(
    entryData: Omit<AuditLogEntry, "id" | "timestamp"> & {
      id?: string;
      timestamp?: number;
    }
  ): AuditLogEntry {
    const id = entryData.id ?? `audit_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const timestamp = entryData.timestamp ?? Date.now();

    const entry: AuditLogEntry = {
      id,
      timestamp,
      sourceDeviceId: entryData.sourceDeviceId,
      actionId: entryData.actionId,
      riskTier: entryData.riskTier,
      status: entryData.status,
      humanSummary: entryData.humanSummary,
      ...(entryData.durationMs !== undefined ? { durationMs: entryData.durationMs } : {}),
      ...(entryData.details !== undefined ? { details: entryData.details } : {}),
    };

    // Store in ring buffer (maintains max capacity)
    if (this.ringBuffer.length >= this.maxRingBufferSize) {
      const removed = this.ringBuffer.shift();
      if (removed) {
        this.entryMap.delete(removed.id);
      }
    }

    this.ringBuffer.push(entry);
    this.entryMap.set(entry.id, entry);

    // Append to disk JSONL
    if (!this.disabled) {
      this.appendEntryToDisk(entry);
    }

    this.logger.debug(
      { id: entry.id, actionId: entry.actionId, status: entry.status },
      "[AuditLogger] Event logged"
    );

    // Emit local event
    this.emit("audit", entry);
    this.emit("change", entry);

    // Broadcast in real-time to connected companion apps
    this.broadcastToCompanions(entry);

    return entry;
  }

  /**
   * Updates the status and optional metrics of an existing audit event.
   */
  public updateStatus(
    id: string,
    status: AuditStatus,
    extra?: {
      durationMs?: number;
      humanSummary?: string;
      details?: Record<string, unknown>;
    }
  ): AuditLogEntry | undefined {
    const existing = this.entryMap.get(id);
    if (!existing) {
      // If not in ring buffer, create a fresh entry with this id
      return undefined;
    }

    const updated: AuditLogEntry = {
      ...existing,
      status,
      timestamp: Date.now(),
      ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
      ...(extra?.humanSummary !== undefined ? { humanSummary: extra.humanSummary } : {}),
      details: {
        ...(existing.details ?? {}),
        ...(extra?.details ?? {}),
      },
    };

    // Update in-memory map and buffer
    const idx = this.ringBuffer.findIndex((e) => e.id === id);
    if (idx !== -1) {
      this.ringBuffer[idx] = updated;
    }
    this.entryMap.set(id, updated);

    // Append updated state to disk to preserve full event lifecycle history
    if (!this.disabled) {
      this.appendEntryToDisk(updated);
    }

    this.logger.debug(
      { id: updated.id, actionId: updated.actionId, status: updated.status },
      "[AuditLogger] Event updated"
    );

    this.emit("audit", updated);
    this.emit("change", updated);

    this.broadcastToCompanions(updated);

    return updated;
  }

  /**
   * Returns a copy of the in-memory ring buffer (oldest to newest).
   */
  public getRingBuffer(): AuditLogEntry[] {
    return [...this.ringBuffer];
  }

  /**
   * Returns the most recent audit entries up to limit (newest first).
   */
  public getRecentEntries(limit: number = 50): AuditLogEntry[] {
    const count = Math.min(limit, this.ringBuffer.length);
    return this.ringBuffer.slice(-count).reverse();
  }

  /**
   * Retrieves an audit entry by its unique ID from the ring buffer.
   */
  public getEntryById(id: string): AuditLogEntry | undefined {
    return this.entryMap.get(id);
  }

  /**
   * Clears in-memory buffer (primarily for test resets).
   */
  public clearInMemoryBuffer(): void {
    this.ringBuffer.length = 0;
    this.entryMap.clear();
  }

  /**
   * Reads and parses lines from the JSONL log file on disk.
   */
  public readLogFile(maxLines?: number): AuditLogEntry[] {
    if (!fs.existsSync(this.logFilePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.logFilePath, "utf8");
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const parsed: AuditLogEntry[] = [];

      for (const line of lines) {
        try {
          const raw = JSON.parse(line);
          const validated = AuditLogEntrySchema.safeParse(raw);
          if (validated.success) {
            parsed.push(validated.data);
          }
        } catch {
          // Skip corrupt lines
        }
      }

      if (maxLines !== undefined && maxLines > 0) {
        return parsed.slice(-maxLines);
      }
      return parsed;
    } catch (err) {
      this.logger.warn({ err }, "[AuditLogger] Failed to read log file");
      return [];
    }
  }

  private ensureLogDirectory(): void {
    try {
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      this.logger.warn({ err, dir: path.dirname(this.logFilePath) }, "[AuditLogger] Failed to create log directory");
    }
  }

  private appendEntryToDisk(entry: AuditLogEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      fs.appendFileSync(this.logFilePath, line, "utf8");
    } catch (err) {
      this.logger.warn({ err, id: entry.id }, "[AuditLogger] Failed to append entry to disk");
    }
  }

  private broadcastToCompanions(entry: AuditLogEntry): void {
    if (!this.server) {
      return;
    }

    try {
      const rpcReq: HarnessRpcReq = {
        callId: entry.id,
        method: "audit_feed_event",
        params: {
          entry,
        },
      };

      const payload = encodeControlPayload(HarnessRpcReqSchema, rpcReq);
      this.server.broadcastToCompanions(FrameType.HARNESS_RPC_REQ, payload);
    } catch (err) {
      this.logger.debug({ err }, "[AuditLogger] Could not broadcast audit entry to companions");
    }
  }
}
