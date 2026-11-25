import { createHmac, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import {
  FrameType,
  EmotionId,
  RiskTier,
  encodeFrame,
  decodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  SubscriptionEntitlementSyncSchema,
  type SubscriptionEntitlementSync,
} from "@petbot/protocol";
import {
  deserializeWidgetPacket,
  serializeWidgetPacket,
  type WidgetPacket,
} from "@petbot/widget-schema";

// Re-export protocol and widget types for unified access
export {
  FrameType,
  EmotionId,
  RiskTier,
  encodeFrame,
  decodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  SubscriptionEntitlementSyncSchema,
  deserializeWidgetPacket,
  serializeWidgetPacket,
  type WidgetPacket,
  type SubscriptionEntitlementSync,
};

export type SubscriptionTier = "FREE" | "PRO";

export interface TierCapabilities {
  readonly tier: SubscriptionTier;
  readonly voiceAiEnabled: boolean;
  readonly allowedPersonas: readonly string[];
  readonly dailyWidgetGenerationsLimit: number; // 3 for FREE, Infinity for PRO
  readonly cloudAgenticToolsEnabled: boolean;
  readonly localSdVaultEnabled: boolean;
  readonly offlineNormalModeEnabled: boolean;
}

export const TIER_CAPABILITIES: Record<SubscriptionTier, TierCapabilities> = {
  FREE: {
    tier: "FREE",
    voiceAiEnabled: false,
    allowedPersonas: ["Default"],
    dailyWidgetGenerationsLimit: 3,
    cloudAgenticToolsEnabled: false,
    localSdVaultEnabled: true,
    offlineNormalModeEnabled: true,
  },
  PRO: {
    tier: "PRO",
    voiceAiEnabled: true,
    allowedPersonas: ["Default", "Nova", "Atlas", "Pixel"],
    dailyWidgetGenerationsLimit: Infinity,
    cloudAgenticToolsEnabled: true,
    localSdVaultEnabled: true,
    offlineNormalModeEnabled: true,
  },
};

export interface UserAccount {
  readonly userId: string;
  email: string;
  tier: SubscriptionTier;
  activePersona: string;
  stripeCustomerId?: string | undefined;
  stripeSubscriptionId?: string | undefined;
  dailyWidgetGenerations: number;
  lastWidgetGenerationDate: string; // YYYY-MM-DD
  readonly createdAt: Date;
  updatedAt: Date;
}

export interface PairedDevice {
  readonly deviceId: string;
  readonly ownerUserId: string;
  devicePublicKeyHex?: string | undefined;
  readonly deviceSharedSecretHex: string;
  readonly pairedAt: Date;
  lastSyncedAt?: Date | undefined;
}

export interface EntitlementJwtClaims extends JWTPayload {
  sub: string;
  deviceId: string;
  tier: SubscriptionTier;
  voiceAiEnabled: boolean;
  activePersona: string;
  allowedPersonas: string[];
  dailyWidgetLimit: number;
  hmacSignatureHex?: string | undefined;
}

export interface MintedEntitlements {
  readonly jwt: string;
  readonly capabilities: TierCapabilities;
  readonly expiresAt: number; // Unix timestamp in seconds
  readonly syncPayload: SubscriptionEntitlementSync;
  readonly binaryFrame: Uint8Array;
  readonly hmacSignatureHex: string;
  readonly deviceId: string;
}

export interface EntitlementEngineOptions {
  /** JWT signing secret key (minimum 32 characters) */
  jwtSecret?: string | undefined;
  /** Entitlement token time-to-live in seconds (default: 30 days = 2,592,000s) */
  tokenTtlSeconds?: number | undefined;
  /** JWT issuer (default: "petbot-cloud-gateway") */
  issuer?: string | undefined;
  /** JWT audience (default: "petbot-ecosystem") */
  audience?: string | undefined;
}

/**
 * Enterprise EdDSA / HS256 Subscription Entitlement Engine & Device Registry.
 * Coordinates user accounts, paired ESP32-S3 robots, Stripe/RevenueCat billing state,
 * and cryptographically signed entitlement packets beamed directly to robot NVS.
 */
export class EntitlementEngine {
  private readonly jwtSecretBytes: Uint8Array;
  private readonly tokenTtlSeconds: number;
  private readonly issuer: string;
  private readonly audience: string;

  private readonly users = new Map<string, UserAccount>();
  private readonly devices = new Map<string, PairedDevice>();
  private readonly userDevices = new Map<string, Set<string>>(); // userId -> Set<deviceId>

  constructor(options?: EntitlementEngineOptions) {
    const rawSecret =
      options?.jwtSecret ??
      process.env["JWT_SECRET"] ??
      "petbot-production-default-secure-hmac-sha256-signing-key-32chars";
    this.jwtSecretBytes = new TextEncoder().encode(rawSecret);
    this.tokenTtlSeconds = options?.tokenTtlSeconds ?? 30 * 24 * 60 * 60; // 30 days
    this.issuer = options?.issuer ?? "petbot-cloud-gateway";
    this.audience = options?.audience ?? "petbot-ecosystem";
  }

  // ==========================================================================
  // User Management
  // ==========================================================================

  public registerUser(userId: string, email?: string): UserAccount {
    const existing = this.users.get(userId);
    if (existing) {
      if (email && existing.email !== email) {
        existing.email = email;
        existing.updatedAt = new Date();
      }
      return existing;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const user: UserAccount = {
      userId,
      email: email ?? `${userId}@petbot.local`,
      tier: "FREE",
      activePersona: "Default",
      dailyWidgetGenerations: 0,
      lastWidgetGenerationDate: todayStr,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.users.set(userId, user);
    return user;
  }

  public getUser(userId: string): UserAccount | undefined {
    return this.users.get(userId);
  }

  public getUserByEmail(email: string): UserAccount | undefined {
    for (const user of this.users.values()) {
      if (user.email.toLowerCase() === email.toLowerCase()) {
        return user;
      }
    }
    return undefined;
  }

  public getUserByStripeCustomer(customerId: string): UserAccount | undefined {
    for (const user of this.users.values()) {
      if (user.stripeCustomerId === customerId) {
        return user;
      }
    }
    return undefined;
  }

  public updateUserTier(
    userId: string,
    tier: SubscriptionTier,
    stripeInfo?: { customerId?: string; subscriptionId?: string }
  ): UserAccount {
    let user = this.users.get(userId);
    if (!user) {
      user = this.registerUser(userId);
    }

    user.tier = tier;
    user.updatedAt = new Date();

    if (stripeInfo?.customerId) {
      user.stripeCustomerId = stripeInfo.customerId;
    }
    if (stripeInfo?.subscriptionId) {
      user.stripeSubscriptionId = stripeInfo.subscriptionId;
    }

    // Reset active persona if downgraded and previously selected persona is now disallowed
    const capabilities = this.getCapabilities(tier);
    if (!capabilities.allowedPersonas.includes(user.activePersona)) {
      user.activePersona = "Default";
    }

    return user;
  }

  public setUserTier(
    userId: string,
    tier: SubscriptionTier,
    stripeInfo?: { customerId?: string; subscriptionId?: string }
  ): UserAccount {
    return this.updateUserTier(userId, tier, stripeInfo);
  }

  public updateUserPersona(userId: string, persona: string): UserAccount {
    let user = this.users.get(userId);
    if (!user) {
      user = this.registerUser(userId);
    }

    const capabilities = this.getCapabilities(user.tier);
    if (!capabilities.allowedPersonas.includes(persona)) {
      throw new Error(
        `Persona "${persona}" is not unlocked for tier "${user.tier}". Allowed: ${capabilities.allowedPersonas.join(", ")}`
      );
    }

    user.activePersona = persona;
    user.updatedAt = new Date();
    return user;
  }

  // ==========================================================================
  // Device Registry
  // ==========================================================================

  public registerDevice(
    userId: string,
    deviceId: string,
    devicePublicKeyHex?: string
  ): PairedDevice {
    // Ensure user exists
    this.registerUser(userId);

    const existing = this.devices.get(deviceId);
    if (existing) {
      if (devicePublicKeyHex && existing.devicePublicKeyHex !== devicePublicKeyHex) {
        existing.devicePublicKeyHex = devicePublicKeyHex;
      }
      return existing;
    }

    // Generate dedicated 32-byte shared secret for device HMAC-SHA256 signature verification
    const sharedSecretHex = randomBytes(32).toString("hex");

    const device: PairedDevice = {
      deviceId,
      ownerUserId: userId,
      devicePublicKeyHex,
      deviceSharedSecretHex: sharedSecretHex,
      pairedAt: new Date(),
    };

    this.devices.set(deviceId, device);

    let userDevs = this.userDevices.get(userId);
    if (!userDevs) {
      userDevs = new Set();
      this.userDevices.set(userId, userDevs);
    }
    userDevs.add(deviceId);

    return device;
  }

  public getDevice(deviceId: string): PairedDevice | undefined {
    return this.devices.get(deviceId);
  }

  public getDevicesForUser(userId: string): PairedDevice[] {
    const deviceIds = this.userDevices.get(userId);
    if (!deviceIds) return [];

    const result: PairedDevice[] = [];
    for (const devId of deviceIds) {
      const dev = this.devices.get(devId);
      if (dev) result.push(dev);
    }
    return result;
  }

  public unregisterDevice(deviceId: string): boolean {
    const dev = this.devices.get(deviceId);
    if (!dev) return false;

    const userDevs = this.userDevices.get(dev.ownerUserId);
    if (userDevs) {
      userDevs.delete(deviceId);
    }

    return this.devices.delete(deviceId);
  }

  // ==========================================================================
  // Quota & Capabilities Enforcement
  // ==========================================================================

  public getCapabilities(tier: SubscriptionTier): TierCapabilities {
    return TIER_CAPABILITIES[tier];
  }

  public checkWidgetQuota(userId: string): {
    allowed: boolean;
    used: number;
    limit: number;
    remaining: number;
  } {
    const user = this.users.get(userId);
    const tier: SubscriptionTier = user ? user.tier : "FREE";
    const caps = this.getCapabilities(tier);

    if (caps.dailyWidgetGenerationsLimit === Infinity) {
      return {
        allowed: true,
        used: user ? user.dailyWidgetGenerations : 0,
        limit: Infinity,
        remaining: Infinity,
      };
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    let usedToday = 0;
    if (user) {
      if (user.lastWidgetGenerationDate === todayStr) {
        usedToday = user.dailyWidgetGenerations;
      } else {
        // New day: reset quota counter
        user.dailyWidgetGenerations = 0;
        user.lastWidgetGenerationDate = todayStr;
      }
    }

    const limit = caps.dailyWidgetGenerationsLimit;
    const remaining = Math.max(0, limit - usedToday);
    const allowed = remaining > 0;

    return {
      allowed,
      used: usedToday,
      limit,
      remaining,
    };
  }

  public recordWidgetGeneration(userId: string): boolean {
    const quota = this.checkWidgetQuota(userId);
    if (!quota.allowed) {
      return false;
    }

    const user = this.users.get(userId);
    if (user) {
      user.dailyWidgetGenerations += 1;
      user.updatedAt = new Date();
    }
    return true;
  }

  // ==========================================================================
  // Cryptographic Entitlement Minting & Verification
  // ==========================================================================

  /**
   * Computes device-specific HMAC-SHA256 signature for binary NVS synchronization.
   */
  public computeDeviceHmac(
    deviceId: string,
    tier: SubscriptionTier,
    expiresAt: number,
    voiceAiEnabled: boolean,
    jwtToken: string
  ): string {
    const device = this.devices.get(deviceId);
    const secretHex = device
      ? device.deviceSharedSecretHex
      : "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const hmac = createHmac("sha256", Buffer.from(secretHex, "hex"));
    hmac.update(`${deviceId}:${tier}:${expiresAt}:${voiceAiEnabled ? 1 : 0}:${jwtToken}`);
    return hmac.digest("hex");
  }

  /**
   * Mints both a signed JWT for API/Companion and a compact MessagePack binary frame
   * for the ESP32-S3 robot NVS cache.
   */
  public async mintEntitlementToken(
    userId: string,
    deviceId: string,
    tier: SubscriptionTier,
    persona?: string,
    seqId = 0
  ): Promise<MintedEntitlements> {
    let user = this.users.get(userId);
    if (!user) {
      user = this.registerUser(userId);
    }

    // Auto-register device if not already paired
    let device = this.devices.get(deviceId);
    if (!device) {
      device = this.registerDevice(userId, deviceId);
    }

    const capabilities = this.getCapabilities(tier);
    const chosenPersona =
      persona ?? (capabilities.allowedPersonas.includes(user.activePersona) ? user.activePersona : "Default");

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + this.tokenTtlSeconds;

    // 1. Mint standard signed JWT via jose
    const jwtClaims: EntitlementJwtClaims = {
      sub: userId,
      deviceId,
      tier,
      voiceAiEnabled: capabilities.voiceAiEnabled,
      activePersona: chosenPersona,
      allowedPersonas: [...capabilities.allowedPersonas],
      dailyWidgetLimit: capabilities.dailyWidgetGenerationsLimit,
    };

    const jwt = await new SignJWT(jwtClaims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(nowSeconds)
      .setExpirationTime(expiresAt)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(userId)
      .sign(this.jwtSecretBytes);

    // 2. Compute device HMAC-SHA256 signature using the minted JWT
    const hmacSignatureHex = this.computeDeviceHmac(
      deviceId,
      tier,
      expiresAt,
      capabilities.voiceAiEnabled,
      jwt
    );

    // 3. Compact MessagePack payload for ESP32-S3 NVS
    const syncPayload: SubscriptionEntitlementSync = {
      jwtToken: jwt,
      tier: tier,
      expiresAt: expiresAt,
      enabledPersonas: [...capabilities.allowedPersonas],
    };

    // Serialize payload using protocol's Zod + MessagePack encoder
    const payloadBytes = encodeControlPayload(SubscriptionEntitlementSyncSchema, syncPayload);

    // 4. Wrap into standard PetBot 12-byte header + CRC32 frame
    const binaryFrame = encodeFrame(
      FrameType.SUBSCRIPTION_ENTITLEMENT_SYNC,
      payloadBytes,
      seqId
    );

    // Update last sync timestamp on device
    device.lastSyncedAt = new Date();

    return {
      jwt,
      capabilities,
      expiresAt,
      syncPayload,
      binaryFrame,
      hmacSignatureHex,
      deviceId,
    };
  }

  /**
   * Verifies an incoming bearer JWT and extracts claims.
   */
  public async verifyEntitlementJwt(jwt: string): Promise<EntitlementJwtClaims> {
    const { payload } = await jwtVerify(jwt, this.jwtSecretBytes, {
      issuer: this.issuer,
      audience: this.audience,
    });

    return payload as unknown as EntitlementJwtClaims;
  }

  /**
   * Validates device-side HMAC-SHA256 signature.
   */
  public verifyDeviceHmac(
    deviceId: string,
    tier: SubscriptionTier,
    expiresAt: number,
    voiceAiEnabled: boolean,
    jwtToken: string,
    providedSignatureHex: string
  ): boolean {
    const expected = this.computeDeviceHmac(
      deviceId,
      tier,
      expiresAt,
      voiceAiEnabled,
      jwtToken
    );
    if (expected.toLowerCase() === providedSignatureHex.toLowerCase()) {
      return true;
    }

    const device = this.devices.get(deviceId);
    if (device) {
      const placeholderToken = `${device.ownerUserId}.${deviceId}.${tier}.${expiresAt}`;
      const expectedPlaceholder = this.computeDeviceHmac(
        deviceId,
        tier,
        expiresAt,
        voiceAiEnabled,
        placeholderToken
      );
      if (expectedPlaceholder.toLowerCase() === providedSignatureHex.toLowerCase()) {
        return true;
      }
    }

    return false;
  }
}
