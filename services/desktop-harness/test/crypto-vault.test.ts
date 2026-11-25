import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { CryptoVault } from "../src/security/crypto-vault.js";
import {
  RiskTier,
  Touch2FADecision,
  type Touch2FaResponse,
} from "@petbot/protocol";

describe("CryptoVault Security & 2FA Engine", () => {
  let tempDir: string;
  let vault: CryptoVault;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "petbot-vault-test-"));
    vault = new CryptoVault({ baseDir: tempDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("generates and persists Ed25519 identity keypair and self-signed certificate", () => {
    const identity = vault.getIdentity();
    expect(identity.deviceId).toMatch(/^harness-[a-f0-9]{12}$/);
    expect(identity.ed25519PrivateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(identity.ed25519PublicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(identity.ed25519PublicKeyHex).toHaveLength(64);
    expect(identity.certificatePem).toContain("BEGIN CERTIFICATE");
    expect(identity.certificateFingerprintSha256).toHaveLength(64);

    // Verify persisted files
    const keysPath = path.join(tempDir, "harness-keys.json");
    expect(fs.existsSync(keysPath)).toBe(true);

    const reloadedVault = new CryptoVault({ baseDir: tempDir });
    expect(reloadedVault.getIdentity().deviceId).toBe(identity.deviceId);
    expect(reloadedVault.getIdentity().ed25519PublicKeyHex).toBe(identity.ed25519PublicKeyHex);
  });

  it("registers, lists, and queries paired devices", () => {
    const mockRobot = {
      deviceId: "petbot-a1b2c3",
      deviceName: "Living Room Pet Robot",
      role: "ROBOT" as const,
      ed25519PublicKeyHex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      sharedHmacSecretHex: crypto.randomBytes(32).toString("hex"),
    };

    const registered = vault.registerPairedDevice(mockRobot);
    expect(registered.deviceId).toBe(mockRobot.deviceId);
    expect(registered.pairedAt).toBeGreaterThan(0);

    const found = vault.getPairedDevice("petbot-a1b2c3");
    expect(found).toBeDefined();
    expect(found?.deviceName).toBe("Living Room Pet Robot");

    const foundByPub = vault.findDeviceByPublicKey(mockRobot.ed25519PublicKeyHex);
    expect(foundByPub?.deviceId).toBe("petbot-a1b2c3");

    const all = vault.listPairedDevices();
    expect(all).toHaveLength(1);

    expect(vault.removePairedDevice("petbot-a1b2c3")).toBe(true);
    expect(vault.getPairedDevice("petbot-a1b2c3")).toBeUndefined();
  });

  it("creates a Touch2FA challenge with 32-byte nonce and expiration", () => {
    const challenge = vault.createTouch2FAChallenge(
      "Authorize Cloud Deployment",
      RiskTier.TIER_3_2FA_REQUIRED,
      10000
    );

    expect(challenge.challengeId).toMatch(/^chal_[a-f0-9]{24}$/);
    expect(challenge.nonce).toHaveLength(64); // 32 bytes in hex = 64 chars
    expect(challenge.riskTierName).toBe("TIER_3_2FA_REQUIRED");
    expect(challenge.expiresInMs).toBe(10000);
    expect(challenge.expiresAt).toBeGreaterThan(Date.now());
    expect(challenge.protocolPayload.actionTitle).toBe("Authorize Cloud Deployment");
  });

  it("verifies valid ESP32-S3 firmware expanded HMAC signature on APPROVED_SINGLE_TAP", () => {
    const secretHex = crypto.randomBytes(32).toString("hex");
    const device = vault.registerPairedDevice({
      deviceId: "petbot-esp32s3",
      deviceName: "Desk Pet Robot",
      role: "ROBOT",
      ed25519PublicKeyHex: crypto.randomBytes(32).toString("hex"),
      sharedHmacSecretHex: secretHex,
    });

    const challenge = vault.createTouch2FAChallenge(
      "Allow Terminal Root Access",
      RiskTier.TIER_3_2FA_REQUIRED,
      15000
    );

    const touchTimestampMs = Date.now();
    const signatureHex = vault.computeFirmwareSignature(
      secretHex,
      challenge.challengeId,
      challenge.nonce,
      "APPROVED_SINGLE_TAP",
      touchTimestampMs
    );

    const response: Touch2FaResponse = {
      challengeId: challenge.challengeId,
      decision: "APPROVED_SINGLE_TAP",
      touchTimestampMs,
      signatureHex,
    };

    const isValid = vault.verifyTouch2FAResponse(challenge, response, device);
    expect(isValid).toBe(true);
  });

  it("rejects replayed nonce attacks", () => {
    const secretHex = crypto.randomBytes(32).toString("hex");
    const device = vault.registerPairedDevice({
      deviceId: "petbot-esp32s3",
      deviceName: "Desk Pet Robot",
      role: "ROBOT",
      ed25519PublicKeyHex: crypto.randomBytes(32).toString("hex"),
      sharedHmacSecretHex: secretHex,
    });

    const challenge = vault.createTouch2FAChallenge(
      "Replay Test Action",
      RiskTier.TIER_2_WORKFLOW,
      15000
    );

    const touchTimestampMs = Date.now();
    const signatureHex = vault.computeFirmwareSignature(
      secretHex,
      challenge.challengeId,
      challenge.nonce,
      "APPROVED_SINGLE_TAP",
      touchTimestampMs
    );

    const response: Touch2FaResponse = {
      challengeId: challenge.challengeId,
      decision: "APPROVED_SINGLE_TAP",
      touchTimestampMs,
      signatureHex,
    };

    // First verification succeeds
    expect(vault.verifyTouch2FAResponse(challenge, response, device)).toBe(true);

    // Replay with identical parameters MUST fail
    expect(vault.verifyTouch2FAResponse(challenge, response, device)).toBe(false);
  });

  it("rejects DENIED_LONG_PRESS or TIMEOUT decisions", () => {
    const secretHex = crypto.randomBytes(32).toString("hex");
    const device = vault.registerPairedDevice({
      deviceId: "petbot-esp32s3",
      deviceName: "Desk Pet Robot",
      role: "ROBOT",
      ed25519PublicKeyHex: crypto.randomBytes(32).toString("hex"),
      sharedHmacSecretHex: secretHex,
    });

    const challenge = vault.createTouch2FAChallenge(
      "Denied Action",
      RiskTier.TIER_2_WORKFLOW,
      15000
    );

    const touchTimestampMs = Date.now();
    const signatureHex = vault.computeFirmwareSignature(
      secretHex,
      challenge.challengeId,
      challenge.nonce,
      "DENIED_LONG_PRESS",
      touchTimestampMs
    );

    const response: Touch2FaResponse = {
      challengeId: challenge.challengeId,
      decision: "DENIED_LONG_PRESS",
      touchTimestampMs,
      signatureHex,
    };

    expect(vault.verifyTouch2FAResponse(challenge, response, device)).toBe(false);
  });

  it("rejects tampered signatures or altered touch timestamps", () => {
    const secretHex = crypto.randomBytes(32).toString("hex");
    const device = vault.registerPairedDevice({
      deviceId: "petbot-esp32s3",
      deviceName: "Desk Pet Robot",
      role: "ROBOT",
      ed25519PublicKeyHex: crypto.randomBytes(32).toString("hex"),
      sharedHmacSecretHex: secretHex,
    });

    const challenge = vault.createTouch2FAChallenge(
      "Tamper Test",
      RiskTier.TIER_3_2FA_REQUIRED,
      15000
    );

    const touchTimestampMs = Date.now();
    const signatureHex = vault.computeFirmwareSignature(
      secretHex,
      challenge.challengeId,
      challenge.nonce,
      "APPROVED_SINGLE_TAP",
      touchTimestampMs
    );

    // Attacker alters timestamp
    const tamperedResponse: Touch2FaResponse = {
      challengeId: challenge.challengeId,
      decision: "APPROVED_SINGLE_TAP",
      touchTimestampMs: touchTimestampMs + 10,
      signatureHex,
    };

    expect(vault.verifyTouch2FAResponse(challenge, tamperedResponse, device)).toBe(false);
  });
});
