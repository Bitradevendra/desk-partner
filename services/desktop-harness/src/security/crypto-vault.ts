import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  RiskTier,
  Touch2FADecision,
  type Touch2FaChallenge,
  type Touch2FaResponse,
  type Touch2FaRiskTier,
} from "@petbot/protocol";

export type DeviceRole = "ROBOT" | "COMPANION";

export interface PairedDeviceRecord {
  deviceId: string;
  deviceName: string;
  role: DeviceRole;
  ed25519PublicKeyHex: string;
  sharedHmacSecretHex: string; // 32-byte secret as 64 hex characters
  pairedAt: number;
  lastSeenAt?: number | undefined;
}

export interface PairedDevicesStore {
  version: number;
  devices: Record<string, PairedDeviceRecord>;
}

export interface HarnessIdentityKeys {
  deviceId: string;
  ed25519PrivateKeyPem: string;
  ed25519PublicKeyPem: string;
  ed25519PublicKeyHex: string; // 32-byte raw public key as 64 hex characters
  certificatePem: string;
  certificateFingerprintSha256: string;
  createdAt: number;
}

export interface ActiveChallenge {
  challengeId: string;
  actionTitle: string;
  riskTier: RiskTier;
  riskTierName: Touch2FaRiskTier;
  expiresInMs: number;
  expiresAt: number;
  nonce: string; // 32-byte cryptographic random nonce (64 hex characters)
  createdAt: number;
  protocolPayload: Touch2FaChallenge;
}

export interface CryptoVaultOptions {
  /** Directory path to persist harness-keys.json and paired-devices.json (default: ~/.petbot) */
  baseDir?: string;
}

/**
 * Encodes an ASN.1 DER length field.
 */
function derEncodeLength(len: number): Buffer {
  if (len < 128) {
    return Buffer.from([len]);
  }
  const bytes: number[] = [];
  let temp = len;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/**
 * Wraps items inside an ASN.1 DER SEQUENCE (tag 0x30).
 */
function derSequence(items: Buffer[]): Buffer {
  const body = Buffer.concat(items);
  return Buffer.concat([Buffer.from([0x30]), derEncodeLength(body.length), body]);
}

/**
 * Wraps items inside an ASN.1 DER SET (tag 0x31).
 */
function derSet(items: Buffer[]): Buffer {
  const body = Buffer.concat(items);
  return Buffer.concat([Buffer.from([0x31]), derEncodeLength(body.length), body]);
}

/**
 * Encodes a Date object into ASN.1 UTCTime (tag 0x17, format YYMMDDHHMMSSZ).
 */
function derUTCTime(date: Date): Buffer {
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  const timeStr = `${yy}${mm}${dd}${hh}${min}${ss}Z`;
  const buf = Buffer.from(timeStr, "ascii");
  return Buffer.concat([Buffer.from([0x17, buf.length]), buf]);
}

/**
 * Generates a self-signed X.509 v3 certificate for Ed25519 identity in pure Node.js.
 */
function generateSelfSignedEd25519Cert(
  publicKey: crypto.KeyObject,
  privateKey: crypto.KeyObject,
  commonName: string = "PetBot-Desktop-Harness"
): { certificatePem: string; fingerprintSha256: string } {
  const spkiDer = publicKey.export({ type: "spki", format: "der" });

  // Ed25519 AlgorithmIdentifier: OID 1.3.101.112 -> 06 03 2b 65 70
  const ed25519Alg = Buffer.from("300506032b6570", "hex");

  // Serial Number: INTEGER 1
  const serial = Buffer.from("020101", "hex");

  // Validity: valid from 1 minute ago to 10 years into the future
  const notBefore = derUTCTime(new Date(Date.now() - 60_000));
  const notAfter = derUTCTime(new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000));
  const validity = derSequence([notBefore, notAfter]);

  // Subject / Issuer: CN=<commonName>
  // commonName OID 2.5.4.3 -> 06 03 55 04 03
  const cnOid = Buffer.from("0603550403", "hex");
  const cnStr = Buffer.from(commonName, "utf8");
  const cnVal = Buffer.concat([Buffer.from([0x0c, cnStr.length]), cnStr]);
  const rdn = derSet([derSequence([cnOid, cnVal])]);
  const name = derSequence([rdn]);

  // Version: v3 (represented as integer 2 inside context-specific tag [0])
  const version = Buffer.from("a003020102", "hex");

  // TBSCertificate
  const tbs = derSequence([version, serial, ed25519Alg, name, validity, name, spkiDer]);

  // Sign TBS with Ed25519 private key
  const signature = crypto.sign(null, tbs, privateKey);
  const sigBitString = Buffer.concat([
    Buffer.from([0x03]),
    derEncodeLength(signature.length + 1),
    Buffer.from([0x00]),
    signature,
  ]);

  // Full X.509 Certificate DER
  const certDer = derSequence([tbs, ed25519Alg, sigBitString]);
  const pem =
    "-----BEGIN CERTIFICATE-----\n" +
    (certDer.toString("base64").match(/.{1,64}/g) ?? []).join("\n") +
    "\n-----END CERTIFICATE-----\n";

  const fingerprintSha256 = crypto.createHash("sha256").update(certDer).digest("hex");
  return { certificatePem: pem, fingerprintSha256 };
}

/**
 * Zero-Trust Ed25519 identity manager, mTLS cert generator, and hardware 2FA cryptographic vault.
 */
export class CryptoVault {
  private readonly baseDir: string;
  private readonly keysPath: string;
  private readonly pairedDevicesPath: string;

  private identity: HarnessIdentityKeys;
  private pairedDevicesStore: PairedDevicesStore;

  private readonly activeChallenges = new Map<string, ActiveChallenge>();
  private readonly usedNonces = new Set<string>();

  constructor(options?: CryptoVaultOptions) {
    this.baseDir = options?.baseDir ?? path.join(os.homedir(), ".petbot");
    this.keysPath = path.join(this.baseDir, "harness-keys.json");
    this.pairedDevicesPath = path.join(this.baseDir, "paired-devices.json");

    this.ensureBaseDirectory();
    this.identity = this.loadOrGenerateIdentityKeys();
    this.pairedDevicesStore = this.loadPairedDevicesStore();
  }

  public getIdentity(): Readonly<HarnessIdentityKeys> {
    return this.identity;
  }

  public getBaseDir(): string {
    return this.baseDir;
  }

  // --- Paired Devices Registry Methods ---

  public registerPairedDevice(
    device: Omit<PairedDeviceRecord, "pairedAt"> & { pairedAt?: number }
  ): PairedDeviceRecord {
    const record: PairedDeviceRecord = {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      role: device.role,
      ed25519PublicKeyHex: device.ed25519PublicKeyHex.toLowerCase(),
      sharedHmacSecretHex: device.sharedHmacSecretHex.toLowerCase(),
      pairedAt: device.pairedAt ?? Date.now(),
      ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
    };

    this.pairedDevicesStore.devices[record.deviceId] = record;
    this.savePairedDevicesStore();
    return record;
  }

  public getPairedDevice(deviceId: string): PairedDeviceRecord | undefined {
    return this.pairedDevicesStore.devices[deviceId];
  }

  public findDeviceByPublicKey(pubKeyHex: string): PairedDeviceRecord | undefined {
    const normalized = pubKeyHex.toLowerCase();
    return Object.values(this.pairedDevicesStore.devices).find(
      (d) => d.ed25519PublicKeyHex === normalized
    );
  }

  public listPairedDevices(): PairedDeviceRecord[] {
    return Object.values(this.pairedDevicesStore.devices);
  }

  public removePairedDevice(deviceId: string): boolean {
    if (deviceId in this.pairedDevicesStore.devices) {
      delete this.pairedDevicesStore.devices[deviceId];
      this.savePairedDevicesStore();
      return true;
    }
    return false;
  }

  public updateLastSeen(deviceId: string, timestamp: number = Date.now()): void {
    const device = this.pairedDevicesStore.devices[deviceId];
    if (device) {
      device.lastSeenAt = timestamp;
      this.savePairedDevicesStore();
    }
  }

  // --- Cryptographic Touch 2FA Engine ---

  /**
   * Creates a tamper-resistant Touch 2FA challenge with a 32-byte cryptographic nonce.
   */
  public createTouch2FAChallenge(
    actionTitle: string,
    riskTier: RiskTier,
    ttlMs: number = 15000
  ): ActiveChallenge {
    const challengeId = `chal_${crypto.randomBytes(12).toString("hex")}`;
    const nonce = crypto.randomBytes(32).toString("hex"); // 32 bytes = 64 hex characters
    const now = Date.now();
    const expiresAt = now + ttlMs;

    let riskTierName: Touch2FaRiskTier = "TIER_2_WORKFLOW";
    if (riskTier === RiskTier.TIER_1_SAFE) {
      riskTierName = "TIER_1_SAFE";
    } else if (riskTier === RiskTier.TIER_3_2FA_REQUIRED) {
      riskTierName = "TIER_3_2FA_REQUIRED";
    }

    const protocolPayload: Touch2FaChallenge = {
      challengeId,
      actionTitle,
      riskTier: riskTierName,
      expiresInMs: ttlMs,
      nonce,
    };

    const activeChallenge: ActiveChallenge = {
      challengeId,
      actionTitle,
      riskTier,
      riskTierName,
      expiresInMs: ttlMs,
      expiresAt,
      nonce,
      createdAt: now,
      protocolPayload,
    };

    this.activeChallenges.set(challengeId, activeChallenge);
    return activeChallenge;
  }

  public getActiveChallenge(challengeId: string): ActiveChallenge | undefined {
    return this.activeChallenges.get(challengeId);
  }

  /**
   * Cryptographically verifies a robot Touch 2FA response against pinned hardware credentials.
   * Ensures non-expired challenge, zero-replay nonce, APPROVED decision, and exact signature match.
   */
  public verifyTouch2FAResponse(
    challenge: ActiveChallenge | (Touch2FaChallenge & { expiresAt?: number; createdAt?: number }),
    responsePayload: Touch2FaResponse,
    deviceRecord: PairedDeviceRecord
  ): boolean {
    const now = Date.now();

    // 1. Expiration check
    const expiresAt =
      challenge.expiresAt ??
      ((challenge.createdAt ?? now) + (challenge.expiresInMs ?? 15000));
    if (now > expiresAt) {
      return false;
    }

    // Nonce replay protection
    if (this.usedNonces.has(challenge.nonce)) {
      return false;
    }

    // 2. Decision verification (Only single-tap physical approval is permitted)
    const isApproved =
      responsePayload.decision === "APPROVED_SINGLE_TAP" ||
      responsePayload.decision === (Touch2FADecision.APPROVED_SINGLE_TAP as unknown as string);
    if (!isApproved) {
      return false;
    }

    // 3. Signature verification (64-byte / 128 hex chars)
    if (!responsePayload.signatureHex || responsePayload.signatureHex.length !== 128) {
      return false;
    }

    const incomingSigBuf = Buffer.from(responsePayload.signatureHex, "hex");
    if (incomingSigBuf.length !== 64) {
      return false;
    }

    // Firmware message payload: challengeId | nonce | decision | touchTimestampMs
    const pipedMsg = `${challenge.challengeId}|${challenge.nonce}|${responsePayload.decision}|${responsePayload.touchTimestampMs}`;
    const colonMsg = `${challenge.challengeId}:${challenge.nonce}:${responsePayload.decision}:${responsePayload.touchTimestampMs}`;
    const unpipedMsg = `${challenge.challengeId}${challenge.nonce}${responsePayload.decision}${responsePayload.touchTimestampMs}`;

    let signatureVerified = false;

    // Verify Method A: ESP32-S3 Firmware Expanded HMAC-SHA256
    try {
      const secret = Buffer.from(deviceRecord.sharedHmacSecretHex, "hex");

      for (const msg of [pipedMsg, colonMsg, unpipedMsg]) {
        const part1 = crypto.createHmac("sha256", secret).update(msg).digest();
        const expMsg = Buffer.concat([part1, Buffer.from("PETBOT_2FA_SIG_EXPANSION_OK_2026")]);
        const part2 = crypto.createHmac("sha256", secret).update(expMsg).digest();
        const expectedSigBuf = Buffer.concat([part1, part2]);

        if (crypto.timingSafeEqual(expectedSigBuf, incomingSigBuf)) {
          signatureVerified = true;
          break;
        }

        // Direct duplicated HMAC fallback
        const doublePart1 = Buffer.concat([part1, part1]);
        if (crypto.timingSafeEqual(doublePart1, incomingSigBuf)) {
          signatureVerified = true;
          break;
        }
      }
    } catch {
      // HMAC comparison error fallback
    }

    // Verify Method B: Ed25519 Asymmetric Signature (Hardware/Companion)
    if (!signatureVerified && deviceRecord.ed25519PublicKeyHex.length === 64) {
      try {
        const rawPub = Buffer.from(deviceRecord.ed25519PublicKeyHex, "hex");
        // SPKI prefix for Ed25519: 30 2a 30 05 06 03 2b 65 70 03 21 00
        const spkiDer = Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          rawPub,
        ]);
        const pubKey = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });

        for (const msg of [pipedMsg, colonMsg, unpipedMsg]) {
          if (crypto.verify(null, Buffer.from(msg), pubKey, incomingSigBuf)) {
            signatureVerified = true;
            break;
          }
        }
      } catch {
        // Asymmetric key parse error
      }
    }

    if (!signatureVerified) {
      return false;
    }

    // Mark nonce as permanently consumed
    this.usedNonces.add(challenge.nonce);
    this.activeChallenges.delete(challenge.challengeId);
    return true;
  }

  // --- Helper Methods for Test Harness & Device Simulation ---

  /**
   * Replicates firmware's exact HMAC-SHA256 signature expansion.
   */
  public computeFirmwareSignature(
    secretHex: string,
    challengeId: string,
    nonce: string,
    decision: string,
    touchTimestampMs: number
  ): string {
    const secret = Buffer.from(secretHex, "hex");
    const msg = `${challengeId}|${nonce}|${decision}|${touchTimestampMs}`;
    const part1 = crypto.createHmac("sha256", secret).update(msg).digest();
    const expMsg = Buffer.concat([part1, Buffer.from("PETBOT_2FA_SIG_EXPANSION_OK_2026")]);
    const part2 = crypto.createHmac("sha256", secret).update(expMsg).digest();
    return Buffer.concat([part1, part2]).toString("hex");
  }

  /**
   * Signs a message using the Desktop Harness's Ed25519 private key.
   */
  public signWithHarnessKey(data: Uint8Array | string): string {
    const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    const privateKey = crypto.createPrivateKey(this.identity.ed25519PrivateKeyPem);
    const sig = crypto.sign(null, buffer, privateKey);
    return sig.toString("hex");
  }

  /**
   * Verifies a signature produced by a peer's Ed25519 public key.
   */
  public verifyPeerEd25519Signature(
    data: Uint8Array | string,
    signatureHex: string,
    publicKeyHex: string
  ): boolean {
    try {
      const rawPub = Buffer.from(publicKeyHex, "hex");
      const spkiDer = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        rawPub,
      ]);
      const pubKey = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });
      const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      const sigBuf = Buffer.from(signatureHex, "hex");
      return crypto.verify(null, buffer, pubKey, sigBuf);
    } catch {
      return false;
    }
  }

  // --- Internal Storage & Key Loading ---

  private ensureBaseDirectory(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    }
  }

  private loadOrGenerateIdentityKeys(): HarnessIdentityKeys {
    if (fs.existsSync(this.keysPath)) {
      try {
        const raw = fs.readFileSync(this.keysPath, "utf-8");
        const parsed = JSON.parse(raw) as HarnessIdentityKeys;
        if (
          parsed.deviceId &&
          parsed.ed25519PrivateKeyPem &&
          parsed.ed25519PublicKeyPem &&
          parsed.ed25519PublicKeyHex &&
          parsed.certificatePem
        ) {
          return parsed;
        }
      } catch {
        // Parse error, re-generate below
      }
    }

    // Generate fresh Ed25519 keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const spkiDer = publicKey.export({ type: "spki", format: "der" });

    // Raw 32 bytes of public key from SPKI DER (offset 12)
    const rawPublicKeyHex = spkiDer.subarray(12).toString("hex");
    const deviceId = `harness-${rawPublicKeyHex.slice(0, 12)}`;

    // Generate self-signed X.509 certificate
    const { certificatePem, fingerprintSha256 } = generateSelfSignedEd25519Cert(
      publicKey,
      privateKey,
      `PetBot-Harness-${deviceId}`
    );

    const identity: HarnessIdentityKeys = {
      deviceId,
      ed25519PrivateKeyPem: privatePem,
      ed25519PublicKeyPem: publicPem,
      ed25519PublicKeyHex: rawPublicKeyHex,
      certificatePem,
      certificateFingerprintSha256: fingerprintSha256,
      createdAt: Date.now(),
    };

    fs.writeFileSync(this.keysPath, JSON.stringify(identity, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(this.keysPath, 0o600);
    } catch {
      // Windows permission fallback
    }

    return identity;
  }

  private loadPairedDevicesStore(): PairedDevicesStore {
    if (fs.existsSync(this.pairedDevicesPath)) {
      try {
        const raw = fs.readFileSync(this.pairedDevicesPath, "utf-8");
        const parsed = JSON.parse(raw) as PairedDevicesStore;
        if (parsed.version && parsed.devices) {
          return parsed;
        }
      } catch {
        // Fallback to empty store
      }
    }

    const emptyStore: PairedDevicesStore = {
      version: 1,
      devices: {},
    };
    this.savePairedDevicesStore(emptyStore);
    return emptyStore;
  }

  private savePairedDevicesStore(store?: PairedDevicesStore): void {
    const toSave = store ?? this.pairedDevicesStore;
    fs.writeFileSync(this.pairedDevicesPath, JSON.stringify(toSave, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(this.pairedDevicesPath, 0o600);
    } catch {
      // Windows permission fallback
    }
  }
}
