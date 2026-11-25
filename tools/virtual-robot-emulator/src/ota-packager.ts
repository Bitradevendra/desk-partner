import * as crypto from "node:crypto";
import * as fs from "node:fs";
import {
  OTA_CHUNK_SIZE_BYTES,
  OtaUpdateStart,
} from "@petbot/protocol";

export const PBOTA_MAGIC = 0x50424f54; // ASCII: 'P', 'B', 'O', 'T'
export const PBOTA_VERSION = 1;

export interface OtaBundleManifest {
  version: string;
  totalBytes: number;
  chunkSize: number;
  totalChunks: number;
  sha256Hex: string;
  ed25519SignatureHex: string;
  timestamp: number;
}

export interface SignedOtaBundle {
  manifest: OtaBundleManifest;
  firmwareBin: Uint8Array;
}

/**
 * Normalizes an Ed25519 private key input into a Node.js crypto.KeyObject.
 */
export function normalizePrivateKey(privateKey: string | crypto.KeyObject): crypto.KeyObject {
  if (typeof privateKey !== "string") {
    return privateKey;
  }

  // PEM format
  if (privateKey.includes("-----BEGIN")) {
    return crypto.createPrivateKey(privateKey);
  }

  // 64-char (32 bytes seed) or 128-char (64 bytes) hex string
  const rawKey = Buffer.from(privateKey, "hex");
  if (rawKey.length === 32) {
    // Wrap 32-byte seed into PKCS#8 DER structure
    const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
    const pkcs8Der = Buffer.concat([pkcs8Header, rawKey]);
    return crypto.createPrivateKey({
      key: pkcs8Der,
      format: "der",
      type: "pkcs8",
    });
  }

  return crypto.createPrivateKey(privateKey);
}

/**
 * Normalizes an Ed25519 public key input into a Node.js crypto.KeyObject.
 */
export function normalizePublicKey(publicKey: string | crypto.KeyObject): crypto.KeyObject {
  if (typeof publicKey !== "string") {
    return publicKey;
  }

  // PEM format
  if (publicKey.includes("-----BEGIN")) {
    return crypto.createPublicKey(publicKey);
  }

  // 64-character (32 bytes) raw Ed25519 public key hex
  const rawPub = Buffer.from(publicKey, "hex");
  if (rawPub.length === 32) {
    const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
    const spkiDer = Buffer.concat([spkiHeader, rawPub]);
    return crypto.createPublicKey({
      key: spkiDer,
      format: "der",
      type: "spki",
    });
  }

  return crypto.createPublicKey(publicKey);
}

/**
 * Computes the canonical byte sequence signed for OTA verification:
 * `${version}:${totalBytes}:${sha256Hex}`
 */
export function buildOtaSigningPayload(version: string, totalBytes: number, sha256Hex: string): Buffer {
  return Buffer.from(`${version}:${totalBytes}:${sha256Hex}`, "utf-8");
}

/**
 * Creates a cryptographically signed .pbota OTA update bundle.
 */
export function createSignedOtaBundle(
  firmwareBin: Uint8Array,
  version: string,
  privateKey: string | crypto.KeyObject
): SignedOtaBundle {
  if (firmwareBin.byteLength === 0) {
    throw new Error("Firmware binary cannot be empty");
  }

  const sha256Hex = crypto.createHash("sha256").update(firmwareBin).digest("hex");
  const totalBytes = firmwareBin.byteLength;
  const chunkSize = OTA_CHUNK_SIZE_BYTES;
  const totalChunks = Math.ceil(totalBytes / chunkSize);

  const messageToSign = buildOtaSigningPayload(version, totalBytes, sha256Hex);
  const keyObj = normalizePrivateKey(privateKey);
  const signature = crypto.sign(null, messageToSign, keyObj);
  const ed25519SignatureHex = signature.toString("hex");

  const manifest: OtaBundleManifest = {
    version,
    totalBytes,
    chunkSize,
    totalChunks,
    sha256Hex,
    ed25519SignatureHex,
    timestamp: Date.now(),
  };

  return {
    manifest,
    firmwareBin,
  };
}

/**
 * Verifies the integrity and authenticity of a signed OTA update bundle.
 */
export function verifySignedOtaBundle(
  bundle: SignedOtaBundle,
  publicKey: string | crypto.KeyObject
): { valid: boolean; error?: string } {
  const { manifest, firmwareBin } = bundle;

  // 1. Verify byte length matches manifest
  if (firmwareBin.byteLength !== manifest.totalBytes) {
    return {
      valid: false,
      error: `Firmware length mismatch: expected ${manifest.totalBytes}, got ${firmwareBin.byteLength}`,
    };
  }

  // 2. Verify SHA-256 hash of binary
  const computedSha256 = crypto.createHash("sha256").update(firmwareBin).digest("hex");
  if (computedSha256 !== manifest.sha256Hex) {
    return {
      valid: false,
      error: `SHA-256 mismatch: expected ${manifest.sha256Hex}, got ${computedSha256}`,
    };
  }

  // 3. Verify Ed25519 signature
  try {
    const keyObj = normalizePublicKey(publicKey);
    const message = buildOtaSigningPayload(manifest.version, manifest.totalBytes, manifest.sha256Hex);
    const sigBuffer = Buffer.from(manifest.ed25519SignatureHex, "hex");
    const isSigValid = crypto.verify(null, message, keyObj, sigBuffer);

    if (!isSigValid) {
      return {
        valid: false,
        error: "Ed25519 digital signature verification failed",
      };
    }
  } catch (err) {
    return {
      valid: false,
      error: `Cryptographic verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { valid: true };
}

/**
 * Serializes a SignedOtaBundle into a portable binary buffer (.pbota format):
 * [0..3]: Magic 0x50424F54 ('PBOT')
 * [4]: Version 0x01
 * [5..7]: Reserved (0x00)
 * [8..11]: Manifest JSON length (uint32 LE)
 * [12..12+N]: Manifest JSON UTF-8
 * [12+N..End]: Raw Firmware Binary
 */
export function serializeOtaBundle(bundle: SignedOtaBundle): Uint8Array {
  const manifestJson = JSON.stringify(bundle.manifest);
  const manifestBytes = Buffer.from(manifestJson, "utf-8");
  const headerLen = 12;
  const totalLength = headerLen + manifestBytes.byteLength + bundle.firmwareBin.byteLength;

  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, totalLength);

  view.setUint32(0, PBOTA_MAGIC, false); // Big-Endian 'PBOT'
  view.setUint8(4, PBOTA_VERSION);
  view.setUint8(5, 0);
  view.setUint16(6, 0, true);
  view.setUint32(8, manifestBytes.byteLength, true);

  buffer.set(manifestBytes, headerLen);
  buffer.set(bundle.firmwareBin, headerLen + manifestBytes.byteLength);

  return buffer;
}

/**
 * Deserializes a binary .pbota buffer into a SignedOtaBundle.
 */
export function deserializeOtaBundle(data: Uint8Array): SignedOtaBundle {
  if (data.byteLength < 12) {
    throw new Error("Invalid .pbota file: too small to contain header");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== PBOTA_MAGIC) {
    throw new Error(`Invalid .pbota magic: 0x${magic.toString(16).toUpperCase()}`);
  }

  const version = view.getUint8(4);
  if (version !== PBOTA_VERSION) {
    throw new Error(`Unsupported .pbota version: ${version}`);
  }

  const manifestLen = view.getUint32(8, true);
  const headerLen = 12;
  if (data.byteLength < headerLen + manifestLen) {
    throw new Error("Corrupted .pbota file: truncated manifest data");
  }

  const manifestBytes = data.subarray(headerLen, headerLen + manifestLen);
  const manifestJson = Buffer.from(manifestBytes).toString("utf-8");
  const manifest = JSON.parse(manifestJson) as OtaBundleManifest;

  const firmwareBin = data.subarray(headerLen + manifestLen);

  return {
    manifest,
    firmwareBin,
  };
}

/**
 * Generates an Ed25519 signing keypair for OTA firmware releases.
 */
export function generateOtaSigningKeyPair(): {
  publicKeyPem: string;
  privateKeyPem: string;
  publicKeyHex: string;
  privateKeyHex: string;
  keyPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };
} {
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = keyPair.publicKey.export({ format: "pem", type: "spki" }).toString();

  const rawPubDer = keyPair.publicKey.export({ format: "der", type: "spki" });
  const publicKeyHex = rawPubDer.subarray(-32).toString("hex");

  const rawPrivDer = keyPair.privateKey.export({ format: "der", type: "pkcs8" });
  const privateKeyHex = rawPrivDer.subarray(-32).toString("hex");

  return {
    publicKeyPem,
    privateKeyPem,
    publicKeyHex,
    privateKeyHex,
    keyPair,
  };
}
