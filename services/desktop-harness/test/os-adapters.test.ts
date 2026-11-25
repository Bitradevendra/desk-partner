import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  WindowsAdapter,
  MacAdapter,
  LinuxAdapter,
  createOSAdapter,
  type WhitelistedAppSlug,
  type MediaControlCommand,
} from "../src/os/os-adapters.js";

describe("Cross-Platform OS Control Adapters (Windows, macOS, Linux)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot-os-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe("Tier 1 Safe Instant Controls across Drivers", () => {
    const drivers = [
      { name: "Windows (win32)", adapter: new WindowsAdapter({ mock: true }) },
      { name: "macOS (darwin)", adapter: new MacAdapter({ mock: true }) },
      { name: "Linux (linux)", adapter: new LinuxAdapter({ mock: true }) },
    ];

    for (const { name, adapter } of drivers) {
      describe(`Driver: ${name}`, () => {
        beforeEach(() => {
          adapter.clearRecordedCommands();
        });

        it("adjusts system volume with parameterized execution", async () => {
          const res = await adapter.setSystemVolume(75);
          expect(res.volume).toBe(75);

          const recorded = adapter.getRecordedCommands();
          expect(recorded.length).toBeGreaterThanOrEqual(1);
          // Verify arguments are parameterized array, not unsanitized string
          expect(Array.isArray(recorded[0]?.args)).toBe(true);
        });

        it("toggles system mute and mic mute", async () => {
          const muteRes = await adapter.toggleSystemMute();
          expect(typeof muteRes.muted).toBe("boolean");

          const micRes = await adapter.toggleMicrophoneMute();
          expect(typeof micRes.micMuted).toBe("boolean");

          const recorded = adapter.getRecordedCommands();
          expect(recorded.length).toBe(2);
        });

        it("dispatches media controls (PLAY_PAUSE, NEXT, PREV)", async () => {
          const commands: MediaControlCommand[] = ["PLAY_PAUSE", "NEXT", "PREV"];
          for (const cmd of commands) {
            const res = await adapter.mediaControl(cmd);
            expect(res.action).toBe(cmd);
            expect(res.success).toBe(true);
          }
          expect(adapter.getRecordedCommands().length).toBe(3);
        });

        it("locks workstation via native secure binary", async () => {
          await adapter.lockWorkstation();
          const recorded = adapter.getRecordedCommands();
          expect(recorded.length).toBe(1);

          if (adapter.platform === "win32") {
            expect(recorded[0]?.file).toBe("rundll32.exe");
            expect(recorded[0]?.args).toContain("user32.dll,LockWorkStation");
          } else if (adapter.platform === "darwin") {
            expect(recorded[0]?.file).toBe("pmset");
            expect(recorded[0]?.args).toContain("displaysleepnow");
          } else if (adapter.platform === "linux") {
            expect(recorded[0]?.file).toBe("loginctl");
            expect(recorded[0]?.args).toContain("lock-session");
          }
        });

        it("switches virtual desktop left and right", async () => {
          const left = await adapter.switchVirtualDesktop("LEFT");
          expect(left.switched).toBe("LEFT");

          const right = await adapter.switchVirtualDesktop("RIGHT");
          expect(right.switched).toBe("RIGHT");
          expect(adapter.getRecordedCommands().length).toBe(2);
        });

        it("launches whitelisted applications safely", async () => {
          const apps: WhitelistedAppSlug[] = [
            "browser",
            "terminal",
            "notes",
            "music",
            "code",
            "calculator",
          ];
          for (const app of apps) {
            const res = await adapter.launchWhitelistedApp(app);
            expect(res.launched).toBe(app);
          }
          expect(adapter.getRecordedCommands().length).toBe(6);
        });

        it("rejects unauthorized application launch attempts", async () => {
          await expect(
            adapter.launchWhitelistedApp("malware_exe" as WhitelistedAppSlug)
          ).rejects.toThrow(/Unauthorized application/);
        });

        it("shows desktop notification with title and body", async () => {
          await adapter.showDesktopNotification("PetBot Alert", "Battery at 20%");
          const recorded = adapter.getRecordedCommands();
          expect(recorded.length).toBe(1);
        });
      });
    }
  });

  describe("Tier 2 Productivity Controls", () => {
    it("organizes loose download files into categories without deleting anything", async () => {
      // Create real folders and dummy files in temp directory
      const downloadsDir = path.join(tempDir, "Downloads");
      fs.mkdirSync(downloadsDir, { recursive: true });

      const files = [
        "photo.jpg",
        "chart.png",
        "report.pdf",
        "data.csv",
        "setup.exe",
        "bundle.zip",
        "script.ts",
      ];
      for (const f of files) {
        fs.writeFileSync(path.join(downloadsDir, f), "sample content");
      }

      // Test real organization logic (mock: false on temp directory)
      const adapter = createOSAdapter({ mock: false });
      const res = await adapter.organizeDownloadsFolder(downloadsDir);

      expect(res.movedCount).toBe(files.length);
      expect(res.categories).toContain("Images");
      expect(res.categories).toContain("Documents");
      expect(res.categories).toContain("Installers");
      expect(res.categories).toContain("Archives");
      expect(res.categories).toContain("Code");

      // Verify files now exist inside subdirectories
      expect(fs.existsSync(path.join(downloadsDir, "Images/photo.jpg"))).toBe(true);
      expect(fs.existsSync(path.join(downloadsDir, "Documents/report.pdf"))).toBe(true);
      expect(fs.existsSync(path.join(downloadsDir, "Code/script.ts"))).toBe(true);
    });

    it("captures and summarizes clipboard text preview and metrics", async () => {
      const adapter = new WindowsAdapter({ mock: true });
      adapter.setMockClipboard(
        "PetBot is an autonomous desktop AI pet robot that acts as an interactive physical widget."
      );

      const summary = await adapter.captureAndSummarizeClipboard();
      expect(summary.charCount).toBeGreaterThan(50);
      expect(summary.wordCount).toBe(15);
      expect(summary.textPreview).toContain("PetBot is an autonomous");
    });

    it("toggles Do Not Disturb mode", async () => {
      const adapter = new MacAdapter({ mock: true });
      await adapter.setDoNotDisturb(true);
      await adapter.setDoNotDisturb(false);
      expect(adapter.getRecordedCommands().length).toBe(2);
    });
  });

  describe("Tier 3 High-Privilege Controls (Sandbox & 2FA Gate)", () => {
    it("enforces strict sandbox on temp file deletion", async () => {
      const adapter = new LinuxAdapter({ mock: false });

      // Create valid temp files inside os.tmpdir()
      const safeTemp1 = path.join(tempDir, "temp1.log");
      const safeTemp2 = path.join(tempDir, "temp2.tmp");
      fs.writeFileSync(safeTemp1, "dummy data 12345");
      fs.writeFileSync(safeTemp2, "more dummy data 67890");

      const res = await adapter.emptyTrashOrDeleteTempFiles([safeTemp1, safeTemp2]);
      expect(res.freedBytes).toBeGreaterThan(0);
      expect(fs.existsSync(safeTemp1)).toBe(false);
      expect(fs.existsSync(safeTemp2)).toBe(false);
    });

    it("blocks path traversal outside system temp directory", async () => {
      const adapter = new WindowsAdapter({ mock: false });

      // Attempt deletion outside temp directory (e.g. root or user home)
      const prohibitedPath = path.resolve("/etc/passwd");
      await expect(
        adapter.emptyTrashOrDeleteTempFiles([prohibitedPath])
      ).rejects.toThrow(/Security Sandbox Violation/);
    });

    it("executes approved whitelisted shell workflows and blocks unapproved commands", async () => {
      const adapter = new WindowsAdapter({ mock: true });

      // Whitelisted workflow
      const result = await adapter.executeApprovedShellWorkflow("git_status", ["--porcelain"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("MOCK_WORKFLOW:git_status");

      // Unapproved workflow must throw
      await expect(
        adapter.executeApprovedShellWorkflow("format_hard_drive", [])
      ).rejects.toThrow(/Security Exception: Shell workflow "format_hard_drive" is not whitelisted/);
    });

    it("rejects arguments containing shell meta-characters", async () => {
      const adapter = new LinuxAdapter({ mock: true });
      await expect(
        adapter.executeApprovedShellWorkflow("git_status", ["; rm -rf /"])
      ).rejects.toThrow(/Security Exception: Argument contains prohibited characters/);
    });

    it("stages files for robot SD vault with accurate size and SHA-256 digest", async () => {
      const testFile = path.join(tempDir, "vault_test.bin");
      const data = Buffer.from("PETBOT_VAULT_TEST_DATA_BYTES_2026");
      fs.writeFileSync(testFile, data);

      const adapter = createOSAdapter({ mock: false });
      const staged = await adapter.stageFileForRobotVault(testFile);

      expect(staged.fileName).toBe("vault_test.bin");
      expect(staged.sizeBytes).toBe(data.length);
      expect(staged.sha256Hex).toHaveLength(64);
    });
  });
});
