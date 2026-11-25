/**
 * High-Speed Serial Port Auto-Detector for Physical ESP32-S3 N16R8 Circuits
 * Supports Windows (COM*), Linux (/dev/ttyACM*, /dev/ttyUSB*), and macOS (/dev/cu.usbmodem*).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SerialPortInfo {
  port: string;
  caption: string;
  deviceId: string;
  manufacturer: string;
  isEsp32: boolean;
  matchScore: number;
}

/**
 * Known Espressif USB Hardware Identifiers
 */
const ESP_VID_HEX = "303A"; // Espressif Systems
const ESP32S3_JTAG_PID_HEX = "1001"; // ESP32-S3 USB JTAG / Serial Debug Unit
const ESP32S3_CDC_PID_HEX = "1002";  // ESP32-S3 USB CDC

/**
 * List all serial ports detected on the host OS with hardware metadata.
 */
export function listSerialPorts(): SerialPortInfo[] {
  const platform = process.platform;
  const ports: SerialPortInfo[] = [];

  if (platform === "win32") {
    // Windows: Query PnP Ports via PowerShell / CIM
    try {
      const psCmd = `Get-CimInstance Win32_PnPEntity | Where-Object PNPClass -eq 'Ports' | ForEach-Object { "$($_.Caption)@@$($_.DeviceID)@@$($_.Manufacturer)" }`;
      const raw = execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`, {
        encoding: "utf-8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });

      const lines = raw.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
      for (const line of lines) {
        const parts = line.split("@@");
        const caption = parts[0]?.trim() ?? "";
        const deviceId = parts[1]?.trim() ?? "";
        const manufacturer = parts[2]?.trim() ?? "";

        const match = caption.match(/\((COM\d+)\)/i) || caption.match(/(COM\d+)/i);
        if (match && match[1]) {
          const portName = match[1].toUpperCase();
          const score = calculateMatchScore(portName, caption, deviceId, manufacturer);
          ports.push({
            port: portName,
            caption,
            deviceId,
            manufacturer,
            isEsp32: score >= 50,
            matchScore: score,
          });
        }
      }
    } catch {
      // Fallback: Query [System.IO.Ports.SerialPort]::getportnames()
      try {
        const raw = execSync(`powershell.exe -NoProfile -Command "[System.IO.Ports.SerialPort]::getportnames()"`, {
          encoding: "utf-8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const portNames = raw.trim().split(/\r?\n/).filter((p) => p.trim().length > 0);
        for (const p of portNames) {
          const cleanPort = p.trim().toUpperCase();
          if (!ports.some((existing) => existing.port === cleanPort)) {
            ports.push({
              port: cleanPort,
              caption: `Serial Device (${cleanPort})`,
              deviceId: "",
              manufacturer: "Generic",
              isEsp32: false,
              matchScore: 10,
            });
          }
        }
      } catch {
        // Fallback exhausted
      }
    }
  } else if (platform === "linux") {
    // Linux: Scan /dev/serial/by-id/ and /dev/ttyACM* / /dev/ttyUSB*
    const byIdDir = "/dev/serial/by-id";
    if (fs.existsSync(byIdDir)) {
      try {
        const entries = fs.readdirSync(byIdDir);
        for (const entry of entries) {
          const fullPath = path.join(byIdDir, entry);
          try {
            const realPath = fs.realpathSync(fullPath);
            const score = calculateMatchScore(realPath, entry, entry, "");
            ports.push({
              port: realPath,
              caption: entry,
              deviceId: entry,
              manufacturer: entry.includes("Espressif") ? "Espressif" : "",
              isEsp32: score >= 50,
              matchScore: score,
            });
          } catch {
            // Ignore broken symlinks
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // Direct /dev scan if by-id was empty or missing
    if (ports.length === 0 && fs.existsSync("/dev")) {
      const devFiles = fs.readdirSync("/dev");
      for (const file of devFiles) {
        if (file.startsWith("ttyACM") || file.startsWith("ttyUSB")) {
          const portPath = `/dev/${file}`;
          const isAcm = file.startsWith("ttyACM");
          const score = isAcm ? 60 : 30;
          ports.push({
            port: portPath,
            caption: file,
            deviceId: `/sys/class/tty/${file}`,
            manufacturer: isAcm ? "Espressif USB JTAG/CDC" : "Generic USB-to-UART",
            isEsp32: isAcm,
            matchScore: score,
          });
        }
      }
    }
  } else if (platform === "darwin") {
    // macOS: Scan /dev/cu.usbmodem* and /dev/cu.usbserial*
    if (fs.existsSync("/dev")) {
      const devFiles = fs.readdirSync("/dev");
      for (const file of devFiles) {
        if (file.startsWith("cu.usbmodem") || file.startsWith("cu.usbserial")) {
          const portPath = `/dev/${file}`;
          const isModem = file.startsWith("cu.usbmodem");
          const score = isModem ? 70 : 35;
          ports.push({
            port: portPath,
            caption: file,
            deviceId: file,
            manufacturer: isModem ? "Espressif USB JTAG CDC" : "USB Serial Bridge",
            isEsp32: isModem,
            matchScore: score,
          });
        }
      }
    }
  }

  // Sort descending by match score
  return ports.sort((a, b) => b.matchScore - a.matchScore);
}

/**
 * Calculate match confidence score for ESP32-S3 hardware detection
 */
function calculateMatchScore(
  port: string,
  caption: string,
  deviceId: string,
  manufacturer: string
): number {
  let score = 0;
  const combined = `${port} ${caption} ${deviceId} ${manufacturer}`.toUpperCase();

  // Negative filter: Ignore Bluetooth serial ports
  if (combined.includes("BTHENUM") || combined.includes("BLUETOOTH")) {
    return 1;
  }

  // Direct Espressif VID/PID matching
  if (combined.includes(`VID_${ESP_VID_HEX}`) || combined.includes(`VID:${ESP_VID_HEX}`)) {
    score += 100;
  }
  if (combined.includes(`PID_${ESP32S3_JTAG_PID_HEX}`) || combined.includes(`PID_${ESP32S3_CDC_PID_HEX}`)) {
    score += 50;
  }
  if (combined.includes("ESPRESSIF") || combined.includes("ESP32")) {
    score += 60;
  }
  if (combined.includes("JTAG") || combined.includes("USB JTAG/SERIAL")) {
    score += 40;
  }

  // Common USB-UART bridge chips (CP210x, CH340, CH343)
  if (combined.includes("CP210") || combined.includes("SILICON LABS") || combined.includes("VID_10C4")) {
    score += 35;
  }
  if (combined.includes("CH340") || combined.includes("CH343") || combined.includes("VID_1A86")) {
    score += 35;
  }
  if (combined.includes("USB SERIAL DEVICE") || combined.includes("USB-ENHANCED-SERIAL")) {
    score += 25;
  }

  return score;
}

/**
 * Auto-detect the best connected physical ESP32-S3 port.
 * @param overridePort Optional manual port specified by user (e.g., "COM5" or "/dev/ttyACM0")
 */
export function autoDetectEsp32Port(overridePort?: string): SerialPortInfo | undefined {
  const ports = listSerialPorts();

  if (overridePort) {
    const cleanOverride = overridePort.trim().toUpperCase();
    const found = ports.find(
      (p) => p.port.toUpperCase() === cleanOverride || p.port.toUpperCase().endsWith(cleanOverride)
    );
    if (found) return found;

    // Return custom port descriptor even if not enumerated in list
    return {
      port: overridePort.trim(),
      caption: `User Override (${overridePort.trim()})`,
      deviceId: "MANUAL_OVERRIDE",
      manufacturer: "Manual",
      isEsp32: true,
      matchScore: 999,
    };
  }

  if (ports.length === 0) {
    return undefined;
  }

  // Pick highest scoring non-bluetooth port
  const candidate = ports[0];
  if (candidate && candidate.matchScore > 1) {
    return candidate;
  }

  return ports[0];
}
