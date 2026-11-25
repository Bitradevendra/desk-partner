import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WhitelistedAppSlug =
  | "browser"
  | "terminal"
  | "notes"
  | "music"
  | "code"
  | "calculator";

export type MediaControlCommand = "PLAY_PAUSE" | "NEXT" | "PREV";

export interface RecordedCommand {
  file: string;
  args: string[];
  timestamp: number;
}

export interface OSAdapterOptions {
  mock?: boolean;
}

/**
 * Unified cross-platform OS automation adapter interface.
 */
export interface OSAutomationAdapter {
  readonly platform: NodeJS.Platform;
  readonly isMock: boolean;

  // Tier 1 Safe Instant Controls
  setSystemVolume(levelPct: number): Promise<{ volume: number }>;
  toggleSystemMute(): Promise<{ muted: boolean }>;
  toggleMicrophoneMute(): Promise<{ micMuted: boolean }>;
  mediaControl(cmd: MediaControlCommand): Promise<{ action: string; success: boolean }>;
  lockWorkstation(): Promise<void>;
  switchVirtualDesktop(direction: "LEFT" | "RIGHT"): Promise<{ switched: string }>;
  launchWhitelistedApp(appSlug: WhitelistedAppSlug): Promise<{ launched: string; pid?: number }>;
  showDesktopNotification(title: string, body: string): Promise<void>;

  // Tier 2 Productivity Controls
  organizeDownloadsFolder(targetDir?: string): Promise<{ movedCount: number; categories: string[] }>;
  captureAndSummarizeClipboard(): Promise<{ textPreview: string; charCount: number; wordCount: number }>;
  setDoNotDisturb(enabled: boolean): Promise<void>;

  // Tier 3 High-Privilege Controls (Strictly gated by Sandbox + Physical Robot Touch 2FA)
  emptyTrashOrDeleteTempFiles(targetPaths: string[]): Promise<{ freedBytes: number }>;
  executeApprovedShellWorkflow(
    scriptId: string,
    args: string[],
    abortSignal?: AbortSignal
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  stageFileForRobotVault(filePath: string): Promise<{ fileName: string; sizeBytes: number; sha256Hex: string }>;

  getRecordedCommands(): RecordedCommand[];
  clearRecordedCommands(): void;
}

/**
 * Base adapter holding common state, mock recording, and platform-independent utilities.
 */
abstract class BaseOSAdapter implements OSAutomationAdapter {
  public abstract readonly platform: NodeJS.Platform;
  public readonly isMock: boolean;
  protected recordedCommands: RecordedCommand[] = [];

  // Internal state for deterministic mock mode
  protected currentVolume = 50;
  protected isMuted = false;
  protected isMicMuted = false;
  protected isDndEnabled = false;
  protected mockClipboardContent = "https://github.com/petbot/ecosystem - Desktop Pet Robot";

  constructor(options?: OSAdapterOptions) {
    this.isMock = options?.mock ?? process.env["PETBOT_OS_MOCK"] === "1";
  }

  public getRecordedCommands(): RecordedCommand[] {
    return [...this.recordedCommands];
  }

  public clearRecordedCommands(): void {
    this.recordedCommands = [];
  }

  public setMockClipboard(content: string): void {
    this.mockClipboardContent = content;
  }

  protected recordCommand(file: string, args: string[]): void {
    this.recordedCommands.push({
      file,
      args,
      timestamp: Date.now(),
    });
  }

  /**
   * Executes a command using parameterized execFile (never unsanitized shell strings).
   * In mock mode, records command without spawning process.
   */
  protected async runParameterized(
    file: string,
    args: string[],
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ stdout: string; stderr: string }> {
    this.recordCommand(file, args);

    if (this.isMock) {
      return { stdout: "MOCK_SUCCESS", stderr: "" };
    }

    try {
      const res = await execFileAsync(file, args, {
        timeout: options?.timeoutMs ?? 10000,
        signal: options?.signal,
      });
      return {
        stdout: String(res.stdout),
        stderr: String(res.stderr),
      };
    } catch (err: unknown) {
      const error = err as Error & { stdout?: string; stderr?: string };
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message,
      };
    }
  }

  // --- Abstract methods to implement per platform ---
  public abstract setSystemVolume(levelPct: number): Promise<{ volume: number }>;
  public abstract toggleSystemMute(): Promise<{ muted: boolean }>;
  public abstract toggleMicrophoneMute(): Promise<{ micMuted: boolean }>;
  public abstract mediaControl(cmd: MediaControlCommand): Promise<{ action: string; success: boolean }>;
  public abstract lockWorkstation(): Promise<void>;
  public abstract switchVirtualDesktop(direction: "LEFT" | "RIGHT"): Promise<{ switched: string }>;
  public abstract launchWhitelistedApp(appSlug: WhitelistedAppSlug): Promise<{ launched: string; pid?: number }>;
  public abstract showDesktopNotification(title: string, body: string): Promise<void>;
  public abstract setDoNotDisturb(enabled: boolean): Promise<void>;
  protected abstract getSystemClipboardText(): Promise<string>;

  // --- Common Tier 2 & Tier 3 Implementations ---

  public async organizeDownloadsFolder(
    targetDir?: string
  ): Promise<{ movedCount: number; categories: string[] }> {
    const dir = targetDir ?? path.join(os.homedir(), "Downloads");

    if (this.isMock) {
      this.recordCommand("organizeDownloadsFolder", [dir]);
      return {
        movedCount: 7,
        categories: ["Images", "Documents", "Archives", "Code"],
      };
    }

    if (!fs.existsSync(dir)) {
      return { movedCount: 0, categories: [] };
    }

    const categoriesMap: Record<string, string[]> = {
      Images: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"],
      Documents: [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".txt", ".csv", ".md"],
      Archives: [".zip", ".tar", ".gz", ".7z", ".rar", ".bz2", ".xz"],
      Installers: [".exe", ".msi", ".dmg", ".pkg", ".deb", ".rpm", ".iso"],
      Code: [".ts", ".js", ".py", ".cpp", ".c", ".h", ".rs", ".go", ".json", ".yaml", ".yml"],
    };

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let movedCount = 0;
    const affectedCategories = new Set<string>();

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      let matchedCategory: string | null = null;

      for (const [category, exts] of Object.entries(categoriesMap)) {
        if (exts.includes(ext)) {
          matchedCategory = category;
          break;
        }
      }

      if (!matchedCategory) continue;

      const categoryDir = path.join(dir, matchedCategory);
      if (!fs.existsSync(categoryDir)) {
        fs.mkdirSync(categoryDir, { recursive: true });
      }

      const sourcePath = path.join(dir, entry.name);
      let targetPath = path.join(categoryDir, entry.name);

      // Handle collision safely without deleting
      if (fs.existsSync(targetPath)) {
        const parsed = path.parse(entry.name);
        let counter = 1;
        while (fs.existsSync(targetPath)) {
          targetPath = path.join(categoryDir, `${parsed.name} (${counter})${parsed.ext}`);
          counter++;
        }
      }

      fs.renameSync(sourcePath, targetPath);
      movedCount++;
      affectedCategories.add(matchedCategory);
    }

    return {
      movedCount,
      categories: Array.from(affectedCategories),
    };
  }

  public async captureAndSummarizeClipboard(): Promise<{
    textPreview: string;
    charCount: number;
    wordCount: number;
  }> {
    let text = "";
    if (this.isMock) {
      this.recordCommand("captureAndSummarizeClipboard", []);
      text = this.mockClipboardContent;
    } else {
      text = await this.getSystemClipboardText();
    }

    const trimmed = text.trim();
    const sanitized = trimmed.replace(/[\r\n\t]+/g, " ");
    const textPreview = sanitized.length > 60 ? `${sanitized.slice(0, 57)}...` : sanitized;
    const charCount = text.length;
    const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).filter(Boolean).length;

    return {
      textPreview,
      charCount,
      wordCount,
    };
  }

  public async emptyTrashOrDeleteTempFiles(targetPaths: string[]): Promise<{ freedBytes: number }> {
    this.recordCommand("emptyTrashOrDeleteTempFiles", targetPaths);

    if (this.isMock) {
      return { freedBytes: targetPaths.length * 1024 * 1024 };
    }

    const tempRoot = os.tmpdir();
    let freedBytes = 0;

    for (const target of targetPaths) {
      const resolved = path.resolve(target);

      // Strict Sandbox: Target path MUST be strictly inside os.tmpdir()
      const rel = path.relative(tempRoot, resolved);
      const isInsideTemp = !rel.startsWith("..") && !path.isAbsolute(rel);

      if (!isInsideTemp) {
        throw new Error(
          `Security Sandbox Violation: Path "${target}" is outside system temp directory.`
        );
      }

      if (!fs.existsSync(resolved)) continue;

      try {
        const stat = fs.statSync(resolved);
        freedBytes += stat.size;
        if (stat.isDirectory()) {
          fs.rmSync(resolved, { recursive: true, force: true });
        } else {
          fs.unlinkSync(resolved);
        }
      } catch {
        // Continue cleaning other paths
      }
    }

    return { freedBytes };
  }

  public async executeApprovedShellWorkflow(
    scriptId: string,
    args: string[],
    abortSignal?: AbortSignal
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    // Whitelist of approved workflow scripts
    const approvedWorkflows: Record<string, { cmd: string; defaultArgs: string[] }> = {
      git_status: { cmd: "git", defaultArgs: ["status", "--short"] },
      pnpm_test: { cmd: "pnpm", defaultArgs: ["test"] },
      npm_test: { cmd: "npm", defaultArgs: ["test"] },
      system_info: { cmd: "node", defaultArgs: ["-v"] },
      cargo_check: { cmd: "cargo", defaultArgs: ["check"] },
      docker_ps: { cmd: "docker", defaultArgs: ["ps", "--format", "json"] },
    };

    const workflow = approvedWorkflows[scriptId];
    if (!workflow) {
      throw new Error(`Security Exception: Shell workflow "${scriptId}" is not whitelisted.`);
    }

    // Sanitize arguments: no shell control characters allowed in parameterized invocation
    for (const arg of args) {
      if (/[;&|`$\n\r]/.test(arg)) {
        throw new Error(`Security Exception: Argument contains prohibited characters: ${arg}`);
      }
    }

    const finalArgs = [...workflow.defaultArgs, ...args];
    this.recordCommand(workflow.cmd, finalArgs);

    if (this.isMock) {
      return {
        exitCode: 0,
        stdout: `[MOCK_WORKFLOW:${scriptId}] Executed successfully with args: ${args.join(" ")}`,
        stderr: "",
      };
    }

    try {
      const res = await execFileAsync(workflow.cmd, finalArgs, {
        signal: abortSignal,
        timeout: 30000,
      });
      return {
        exitCode: 0,
        stdout: String(res.stdout),
        stderr: String(res.stderr),
      };
    } catch (err: unknown) {
      const error = err as Error & { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message,
      };
    }
  }

  public async stageFileForRobotVault(
    filePath: string
  ): Promise<{ fileName: string; sizeBytes: number; sha256Hex: string }> {
    this.recordCommand("stageFileForRobotVault", [filePath]);

    if (this.isMock) {
      return {
        fileName: path.basename(filePath),
        sizeBytes: 16384,
        sha256Hex: crypto.createHash("sha256").update(filePath).digest("hex"),
      };
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const sizeBytes = stat.size;

    const fileBuffer = fs.readFileSync(filePath);
    const sha256Hex = crypto.createHash("sha256").update(fileBuffer).digest("hex");

    return {
      fileName,
      sizeBytes,
      sha256Hex,
    };
  }
}

// ============================================================================
// Windows Driver (win32)
// ============================================================================
export class WindowsAdapter extends BaseOSAdapter {
  public readonly platform: NodeJS.Platform = "win32";

  public async setSystemVolume(levelPct: number): Promise<{ volume: number }> {
    const clamped = Math.max(0, Math.min(100, Math.round(levelPct)));
    this.currentVolume = clamped;
    this.isMuted = false;

    // SendKeys virtual keys via PowerShell for volume adjustments
    const script = `
      $obj = New-Object -ComObject WScript.Shell;
      for ($i=0; $i -lt 50; $i++) { $obj.SendKeys([char]174) } # 174 = VK_VOLUME_DOWN
      $steps = [math]::Round(${clamped} / 2);
      for ($i=0; $i -lt $steps; $i++) { $obj.SendKeys([char]175) } # 175 = VK_VOLUME_UP
    `;
    await this.runParameterized("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);

    return { volume: clamped };
  }

  public async toggleSystemMute(): Promise<{ muted: boolean }> {
    this.isMuted = !this.isMuted;
    // 173 = VK_VOLUME_MUTE
    const script = `$obj = New-Object -ComObject WScript.Shell; $obj.SendKeys([char]173)`;
    await this.runParameterized("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return { muted: this.isMuted };
  }

  public async toggleMicrophoneMute(): Promise<{ micMuted: boolean }> {
    this.isMicMuted = !this.isMicMuted;
    // CoreAudio mic toggle script via PowerShell
    const script = `
      try {
        $Audio = Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);' -Name "AudioKey" -PassThru;
        [AudioKey]::keybd_event(173, 0, 0, 0); # Toggle audio/mic state
      } catch {}
    `;
    await this.runParameterized("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return { micMuted: this.isMicMuted };
  }

  public async mediaControl(cmd: MediaControlCommand): Promise<{ action: string; success: boolean }> {
    // 179 = VK_MEDIA_PLAY_PAUSE, 176 = VK_MEDIA_NEXT_TRACK, 177 = VK_MEDIA_PREV_TRACK
    const keyMap: Record<MediaControlCommand, number> = {
      PLAY_PAUSE: 179,
      NEXT: 176,
      PREV: 177,
    };
    const code = keyMap[cmd];
    const script = `$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]${code})`;
    await this.runParameterized("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return { action: cmd, success: true };
  }

  public async lockWorkstation(): Promise<void> {
    await this.runParameterized("rundll32.exe", ["user32.dll,LockWorkStation"]);
  }

  public async switchVirtualDesktop(direction: "LEFT" | "RIGHT"): Promise<{ switched: string }> {
    // Win + Ctrl + Left/Right key combination
    const script = `
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.SendKeys]::SendWait("^%{${direction === "LEFT" ? "LEFT" : "RIGHT"}}");
    `;
    await this.runParameterized("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return { switched: direction };
  }

  public async launchWhitelistedApp(
    appSlug: WhitelistedAppSlug
  ): Promise<{ launched: string; pid?: number }> {
    const appMap: Record<WhitelistedAppSlug, { exe: string; args: string[] }> = {
      browser: { exe: "explorer.exe", args: ["https://www.google.com"] },
      terminal: { exe: "cmd.exe", args: ["/c", "start", "powershell.exe"] },
      notes: { exe: "notepad.exe", args: [] },
      music: { exe: "explorer.exe", args: ["ms-windows-store://"] },
      code: { exe: "cmd.exe", args: ["/c", "code"] },
      calculator: { exe: "calc.exe", args: [] },
    };

    const target = appMap[appSlug];
    if (!target) {
      throw new Error(`Unauthorized application slug: ${appSlug}`);
    }

    await this.runParameterized(target.exe, target.args);
    return { launched: appSlug };
  }

  public async showDesktopNotification(title: string, body: string): Promise<void> {
    const script = `
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;
      [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlCommands, ContentType = WindowsRuntime] | Out-Null;
      $template = "<toast><visual><binding template='ToastGeneric'><text>${title}</text><text>${body}</text></binding></visual></toast>";
      $xml = New-Object Windows.Data.Xml.Dom.XmlDocument;
      $xml.LoadXml($template);
      $toast = [Windows.UI.Notifications.ToastNotification]::new($xml);
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("PetBot Desktop").Show($toast);
    `;
    await this.runParameterized("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
  }

  public async setDoNotDisturb(enabled: boolean): Promise<void> {
    this.isDndEnabled = enabled;
    // Set Windows Focus Assist state
    const regValue = enabled ? 1 : 0;
    const script = `
      try {
        Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings" -Name "NOC_GLOBAL_SETTING_TOASTS_ENABLED" -Value ${regValue ? 0 : 1};
      } catch {}
    `;
    await this.runParameterized("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
  }

  protected async getSystemClipboardText(): Promise<string> {
    const res = await this.runParameterized("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Clipboard",
    ]);
    return res.stdout;
  }
}

// ============================================================================
// macOS Driver (darwin)
// ============================================================================
export class MacAdapter extends BaseOSAdapter {
  public readonly platform: NodeJS.Platform = "darwin";

  public async setSystemVolume(levelPct: number): Promise<{ volume: number }> {
    const clamped = Math.max(0, Math.min(100, Math.round(levelPct)));
    this.currentVolume = clamped;
    this.isMuted = false;
    await this.runParameterized("osascript", ["-e", `set volume output volume ${clamped}`]);
    return { volume: clamped };
  }

  public async toggleSystemMute(): Promise<{ muted: boolean }> {
    this.isMuted = !this.isMuted;
    await this.runParameterized("osascript", [
      "-e",
      "set volume output muted (not (output muted of (get volume settings)))",
    ]);
    return { muted: this.isMuted };
  }

  public async toggleMicrophoneMute(): Promise<{ micMuted: boolean }> {
    this.isMicMuted = !this.isMicMuted;
    const vol = this.isMicMuted ? 0 : 75;
    await this.runParameterized("osascript", ["-e", `set volume input volume ${vol}`]);
    return { micMuted: this.isMicMuted };
  }

  public async mediaControl(cmd: MediaControlCommand): Promise<{ action: string; success: boolean }> {
    const scriptMap: Record<MediaControlCommand, string> = {
      PLAY_PAUSE: 'tell application "Music" to playpause',
      NEXT: 'tell application "Music" to next track',
      PREV: 'tell application "Music" to previous track',
    };
    await this.runParameterized("osascript", ["-e", scriptMap[cmd]]);
    return { action: cmd, success: true };
  }

  public async lockWorkstation(): Promise<void> {
    await this.runParameterized("pmset", ["displaysleepnow"]);
  }

  public async switchVirtualDesktop(direction: "LEFT" | "RIGHT"): Promise<{ switched: string }> {
    const keyCode = direction === "LEFT" ? 123 : 124;
    const script = `tell application "System Events" to key code ${keyCode} using control down`;
    await this.runParameterized("osascript", ["-e", script]);
    return { switched: direction };
  }

  public async launchWhitelistedApp(
    appSlug: WhitelistedAppSlug
  ): Promise<{ launched: string; pid?: number }> {
    const appMap: Record<WhitelistedAppSlug, string> = {
      browser: "Safari",
      terminal: "Terminal",
      notes: "Notes",
      music: "Music",
      code: "Visual Studio Code",
      calculator: "Calculator",
    };

    const appName = appMap[appSlug];
    if (!appName) {
      throw new Error(`Unauthorized application slug: ${appSlug}`);
    }

    await this.runParameterized("open", ["-a", appName]);
    return { launched: appSlug };
  }

  public async showDesktopNotification(title: string, body: string): Promise<void> {
    const script = `display notification "${body}" with title "${title}"`;
    await this.runParameterized("osascript", ["-e", script]);
  }

  public async setDoNotDisturb(enabled: boolean): Promise<void> {
    this.isDndEnabled = enabled;
    const script = `
      tell application "System Events"
        -- Toggles Focus / Do Not Disturb
        keystroke "d" using {command down, control down}
      end tell
    `;
    await this.runParameterized("osascript", ["-e", script]);
  }

  protected async getSystemClipboardText(): Promise<string> {
    const res = await this.runParameterized("pbpaste", []);
    return res.stdout;
  }
}

// ============================================================================
// Linux Driver (linux)
// ============================================================================
export class LinuxAdapter extends BaseOSAdapter {
  public readonly platform: NodeJS.Platform = "linux";

  public async setSystemVolume(levelPct: number): Promise<{ volume: number }> {
    const clamped = Math.max(0, Math.min(100, Math.round(levelPct)));
    this.currentVolume = clamped;
    this.isMuted = false;
    await this.runParameterized("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${clamped}%`]);
    return { volume: clamped };
  }

  public async toggleSystemMute(): Promise<{ muted: boolean }> {
    this.isMuted = !this.isMuted;
    await this.runParameterized("pactl", ["set-sink-mute", "@DEFAULT_SINK@", "toggle"]);
    return { muted: this.isMuted };
  }

  public async toggleMicrophoneMute(): Promise<{ micMuted: boolean }> {
    this.isMicMuted = !this.isMicMuted;
    await this.runParameterized("pactl", ["set-source-mute", "@DEFAULT_SOURCE@", "toggle"]);
    return { micMuted: this.isMicMuted };
  }

  public async mediaControl(cmd: MediaControlCommand): Promise<{ action: string; success: boolean }> {
    const cmdMap: Record<MediaControlCommand, string> = {
      PLAY_PAUSE: "play-pause",
      NEXT: "next",
      PREV: "previous",
    };
    await this.runParameterized("playerctl", [cmdMap[cmd]]);
    return { action: cmd, success: true };
  }

  public async lockWorkstation(): Promise<void> {
    await this.runParameterized("loginctl", ["lock-session"]);
  }

  public async switchVirtualDesktop(direction: "LEFT" | "RIGHT"): Promise<{ switched: string }> {
    const step = direction === "LEFT" ? "-1" : "+1";
    await this.runParameterized("xdotool", ["set_desktop", "--relative", step]);
    return { switched: direction };
  }

  public async launchWhitelistedApp(
    appSlug: WhitelistedAppSlug
  ): Promise<{ launched: string; pid?: number }> {
    const appMap: Record<WhitelistedAppSlug, { cmd: string; args: string[] }> = {
      browser: { cmd: "xdg-open", args: ["https://www.google.com"] },
      terminal: { cmd: "x-terminal-emulator", args: [] },
      notes: { cmd: "gedit", args: [] },
      music: { cmd: "rhythmbox", args: [] },
      code: { cmd: "code", args: [] },
      calculator: { cmd: "gnome-calculator", args: [] },
    };

    const target = appMap[appSlug];
    if (!target) {
      throw new Error(`Unauthorized application slug: ${appSlug}`);
    }

    await this.runParameterized(target.cmd, target.args);
    return { launched: appSlug };
  }

  public async showDesktopNotification(title: string, body: string): Promise<void> {
    await this.runParameterized("notify-send", [title, body]);
  }

  public async setDoNotDisturb(enabled: boolean): Promise<void> {
    this.isDndEnabled = enabled;
    await this.runParameterized("dunstctl", ["set-paused", enabled ? "true" : "false"]);
  }

  protected async getSystemClipboardText(): Promise<string> {
    const res = await this.runParameterized("xclip", ["-selection", "clipboard", "-o"]);
    return res.stdout;
  }
}

/**
 * Factory function creating the appropriate OS automation driver for the current system.
 */
export function createOSAdapter(options?: OSAdapterOptions): OSAutomationAdapter {
  const currentPlatform = os.platform();

  if (currentPlatform === "win32") {
    return new WindowsAdapter(options);
  } else if (currentPlatform === "darwin") {
    return new MacAdapter(options);
  } else {
    return new LinuxAdapter(options);
  }
}
