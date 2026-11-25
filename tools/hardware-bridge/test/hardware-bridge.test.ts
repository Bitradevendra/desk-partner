import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  listSerialPorts,
  autoDetectEsp32Port,
} from "../src/serial-detector.js";
import {
  MockSerialCommunicator,
  NativeSerialCommunicator,
} from "../src/serial-communicator.js";
import {
  HardwareVerifier,
  type DiagnosticResult,
} from "../src/hardware-verifier.js";
import {
  getOrCreatePairingKeys,
  detectLocalHostIp,
  executeProvisioning,
  parseCliArgs,
} from "../src/provision-physical-robot.js";

describe("Hardware Bridge Suite: ESP32-S3 Physical Circuit Integration", () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = path.join(os.tmpdir(), `petbot_hw_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(tempBaseDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Serial Port Auto-Detection & PnP Matching", () => {
    it("enumerates serial ports on the host platform", () => {
      const ports = listSerialPorts();
      expect(Array.isArray(ports)).toBe(true);
      // Each port has required fields
      for (const p of ports) {
        expect(p.port).toBeDefined();
        expect(typeof p.matchScore).toBe("number");
      }
    });

    it("correctly identifies manual override port", () => {
      const detected = autoDetectEsp32Port("COM99");
      expect(detected).toBeDefined();
      expect(detected?.port).toBe("COM99");
      expect(detected?.matchScore).toBe(999);
    });

    it("detects local machine LAN IP address", () => {
      const ip = detectLocalHostIp();
      expect(typeof ip).toBe("string");
      expect(ip.length).toBeGreaterThan(0);
      expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    });
  });

  describe("Cryptographic Pairing Keys & NVS Vault Integration", () => {
    it("generates and persists Ed25519 and 32-byte shared HMAC pairing secrets", () => {
      const keys = getOrCreatePairingKeys(tempBaseDir);
      expect(keys.sharedHmacSecretHex).toHaveLength(64); // 32 bytes in hex
      expect(keys.ed25519PublicKeyHex).toHaveLength(64); // 32 bytes in hex
      expect(keys.deviceId).toMatch(/^harness-/);

      // Verify files persisted to disk
      const keysPath = path.join(tempBaseDir, "harness-keys.json");
      const pairedPath = path.join(tempBaseDir, "paired-devices.json");
      expect(fs.existsSync(keysPath)).toBe(true);
      expect(fs.existsSync(pairedPath)).toBe(true);

      const pairedData = JSON.parse(fs.readFileSync(pairedPath, "utf-8"));
      expect(pairedData.devices["petbot-esp32s3-physical"]).toBeDefined();
      expect(pairedData.devices["petbot-esp32s3-physical"].sharedHmacSecretHex).toBe(keys.sharedHmacSecretHex);
    });

    it("re-uses existing pairing keys on subsequent runs", () => {
      const keys1 = getOrCreatePairingKeys(tempBaseDir);
      const keys2 = getOrCreatePairingKeys(tempBaseDir);
      expect(keys2.sharedHmacSecretHex).toBe(keys1.sharedHmacSecretHex);
      expect(keys2.ed25519PublicKeyHex).toBe(keys1.ed25519PublicKeyHex);
    });
  });

  describe("Serial Communicator & RPC Provisioning", () => {
    it("handles duplex MockSerialCommunicator commands", async () => {
      const comm = new MockSerialCommunicator();
      await comm.open();
      expect(comm.isOpen()).toBe(true);

      const resp = await comm.sendRpcCommand("status", 2000, /System Status/);
      expect(resp).toContain("System Status");

      await comm.close();
      expect(comm.isOpen()).toBe(false);
    });

    it("successfully runs executeProvisioning with mock communicator and pin overrides", async () => {
      const result = await executeProvisioning({
        action: "provision",
        mockMode: true,
        ssid: "Test_Lab_WiFi",
        password: "SuperSecretPassword123",
        host: "192.168.1.42",
        wsPort: 8443,
        pinOverrides: {
          tft_mosi: 11,
          touch: 1,
        },
      });

      expect(result.success).toBe(true);
      expect(result.ssid).toBe("Test_Lab_WiFi");
      expect(result.host).toBe("192.168.1.42");
      expect(result.portNum).toBe(8443);
    });
  });

  describe("Live Hardware Diagnostic Suite Verification", () => {
    it("verifies ESP32-S3 firmware HMAC-SHA256 signature expansion algorithm", () => {
      const secret = crypto.randomBytes(32);
      const secretHex = secret.toString("hex");

      const verifier = new HardwareVerifier({
        robotHost: "127.0.0.1",
        robotPort: 8443,
        sharedHmacSecretHex: secretHex,
        interactiveTouch: false,
      });

      const challengeId = "chal_unit_test_001";
      const nonce = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";
      const decision = "APPROVED_SINGLE_TAP";
      const touchTimestampMs = 1234567;

      // Emulate firmware side signature computation
      const msg = `${challengeId}|${nonce}|${decision}|${touchTimestampMs}`;
      const part1 = crypto.createHmac("sha256", secret).update(msg).digest();
      const expMsg = Buffer.concat([part1, Buffer.from("PETBOT_2FA_SIG_EXPANSION_OK_2026")]);
      const part2 = crypto.createHmac("sha256", secret).update(expMsg).digest();
      const firmwareSignatureHex = Buffer.concat([part1, part2]).toString("hex");

      expect(firmwareSignatureHex).toHaveLength(128); // 64 bytes = 128 hex chars

      const isValid = verifier.verifyFirmwareSignature(
        challengeId,
        nonce,
        decision,
        touchTimestampMs,
        firmwareSignatureHex
      );

      expect(isValid).toBe(true);

      // Verify tampered decision or nonce fails immediately
      const tamperedDecision = verifier.verifyFirmwareSignature(
        challengeId,
        nonce,
        "DENIED_LONG_PRESS",
        touchTimestampMs,
        firmwareSignatureHex
      );
      expect(tamperedDecision).toBe(false);

      const tamperedNonce = verifier.verifyFirmwareSignature(
        challengeId,
        "tampered_nonce_0000000000000000000000000000000000000000000000000000000000",
        decision,
        touchTimestampMs,
        firmwareSignatureHex
      );
      expect(tamperedNonce).toBe(false);
    });

    it("parses CLI arguments accurately", () => {
      const config = parseCliArgs([
        "--action",
        "verify",
        "--port",
        "COM5",
        "--ssid",
        "HomeOffice",
        "--password",
        "pass123",
        "--host",
        "192.168.1.10",
        "--ws-port",
        "9000",
        "--pin",
        "tft_cs=10",
        "--pin",
        "touch=1",
        "--mock",
      ]);

      expect(config.action).toBe("verify");
      expect(config.port).toBe("COM5");
      expect(config.ssid).toBe("HomeOffice");
      expect(config.password).toBe("pass123");
      expect(config.host).toBe("192.168.1.10");
      expect(config.wsPort).toBe(9000);
      expect(config.mockMode).toBe(true);
      expect(config.pinOverrides).toEqual({
        tft_cs: 10,
        touch: 1,
      });
    });
  });
});
