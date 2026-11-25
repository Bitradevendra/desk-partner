import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  EntitlementEngine,
  createCloudGatewayServer,
  FrameType,
  decodeFrame,
  decodeControlPayload,
  SubscriptionEntitlementSyncSchema,
  type CloudGatewayServerInstance,
} from "../src/index.js";
import WebSocket from "ws";

describe("EdDSA / JWT Subscription Entitlement Engine & Device Registry", () => {
  let engine: EntitlementEngine;

  beforeEach(() => {
    engine = new EntitlementEngine({
      jwtSecret: "super-secure-production-test-jwt-secret-at-least-32-chars",
      tokenTtlSeconds: 86400, // 24 hours
    });
  });

  it("manages user accounts and device pairing with per-device shared secrets", () => {
    const user = engine.registerUser("user-alpha-01", "alpha@petbot.ai");
    expect(user.userId).toBe("user-alpha-01");
    expect(user.email).toBe("alpha@petbot.ai");
    expect(user.tier).toBe("FREE");
    expect(user.activePersona).toBe("Default");

    const device = engine.registerDevice(
      "user-alpha-01",
      "esp32s3-dev-1001",
      "abcdef0123456789"
    );
    expect(device.deviceId).toBe("esp32s3-dev-1001");
    expect(device.ownerUserId).toBe("user-alpha-01");
    expect(device.devicePublicKeyHex).toBe("abcdef0123456789");
    expect(device.deviceSharedSecretHex).toHaveLength(64); // 32 bytes hex

    const userDevices = engine.getDevicesForUser("user-alpha-01");
    expect(userDevices).toHaveLength(1);
    expect(userDevices[0]?.deviceId).toBe("esp32s3-dev-1001");

    expect(engine.getDevice("esp32s3-dev-1001")).toBeDefined();
    expect(engine.getUserByEmail("alpha@petbot.ai")?.userId).toBe("user-alpha-01");
  });

  it("enforces strict tier quotas and capabilities for FREE and PRO users", () => {
    engine.registerUser("user-free", "free@petbot.ai");
    const freeCaps = engine.getCapabilities("FREE");

    expect(freeCaps.voiceAiEnabled).toBe(false);
    expect(freeCaps.allowedPersonas).toEqual(["Default"]);
    expect(freeCaps.dailyWidgetGenerationsLimit).toBe(3);
    expect(freeCaps.cloudAgenticToolsEnabled).toBe(false);
    expect(freeCaps.localSdVaultEnabled).toBe(true);
    expect(freeCaps.offlineNormalModeEnabled).toBe(true);

    // Test Free widget quota consumption
    const q1 = engine.checkWidgetQuota("user-free");
    expect(q1.allowed).toBe(true);
    expect(q1.remaining).toBe(3);

    expect(engine.recordWidgetGeneration("user-free")).toBe(true); // 1
    expect(engine.recordWidgetGeneration("user-free")).toBe(true); // 2
    expect(engine.recordWidgetGeneration("user-free")).toBe(true); // 3

    const qExhausted = engine.checkWidgetQuota("user-free");
    expect(qExhausted.allowed).toBe(false);
    expect(qExhausted.remaining).toBe(0);
    expect(engine.recordWidgetGeneration("user-free")).toBe(false);

    // Upgrade to PRO
    engine.updateUserTier("user-free", "PRO");
    const proCaps = engine.getCapabilities("PRO");

    expect(proCaps.voiceAiEnabled).toBe(true);
    expect(proCaps.allowedPersonas).toContain("Nova");
    expect(proCaps.allowedPersonas).toContain("Atlas");
    expect(proCaps.allowedPersonas).toContain("Pixel");
    expect(proCaps.dailyWidgetGenerationsLimit).toBe(Infinity);
    expect(proCaps.cloudAgenticToolsEnabled).toBe(true);

    const qPro = engine.checkWidgetQuota("user-free");
    expect(qPro.allowed).toBe(true);
    expect(qPro.remaining).toBe(Infinity);
    expect(engine.recordWidgetGeneration("user-free")).toBe(true);
  });

  it("mints cryptographically signed JWT and binary SUBSCRIPTION_ENTITLEMENT_SYNC frame", async () => {
    engine.registerUser("user-pro-01", "pro@petbot.ai");
    engine.registerDevice("user-pro-01", "esp32-s3-robot-pro");

    const entitlements = await engine.mintEntitlementToken(
      "user-pro-01",
      "esp32-s3-robot-pro",
      "PRO",
      "Nova"
    );

    // 1. Verify standard JWT
    expect(entitlements.jwt).toBeDefined();
    expect(typeof entitlements.jwt).toBe("string");

    const claims = await engine.verifyEntitlementJwt(entitlements.jwt);
    expect(claims.sub).toBe("user-pro-01");
    expect(claims.deviceId).toBe("esp32-s3-robot-pro");
    expect(claims.tier).toBe("PRO");
    expect(claims.voiceAiEnabled).toBe(true);
    expect(claims.activePersona).toBe("Nova");
    expect(claims.allowedPersonas).toContain("Atlas");

    // 2. Verify MessagePack sync payload
    expect(entitlements.syncPayload.tier).toBe("PRO");
    expect(entitlements.syncPayload.enabledPersonas).toContain("Nova");
    expect(entitlements.syncPayload.jwtToken).toBe(entitlements.jwt);

    // 3. Verify standard PetBot Binary Frame (12-byte header + payload + CRC32)
    expect(entitlements.binaryFrame).toBeInstanceOf(Uint8Array);
    const decoded = decodeFrame(entitlements.binaryFrame);

    expect(decoded.header.frameType).toBe(FrameType.SUBSCRIPTION_ENTITLEMENT_SYNC);
    expect(decoded.header.magic).toBe(0x4250);
    expect(decoded.payload.byteLength).toBe(decoded.header.payloadLen);

    // Deserialize payload back using protocol schema
    const unpacked = decodeControlPayload(
      SubscriptionEntitlementSyncSchema,
      decoded.payload
    );
    expect(unpacked.tier).toBe("PRO");
    expect(unpacked.jwtToken).toBe(entitlements.jwt);
    expect(unpacked.enabledPersonas).toContain("Pixel");

    // 4. Verify HMAC-SHA256 signature
    expect(entitlements.hmacSignatureHex).toHaveLength(64);
    const validHmac = engine.verifyDeviceHmac(
      "esp32-s3-robot-pro",
      "PRO",
      entitlements.expiresAt,
      true,
      entitlements.jwt,
      entitlements.hmacSignatureHex
    );
    expect(validHmac).toBe(true);
  });
});

describe("Subscription & Webhook API Routes", () => {
  let server: CloudGatewayServerInstance;
  let baseUrl: string;

  beforeEach(async () => {
    server = await createCloudGatewayServer({
      port: 0, // Random ephemeral port
      jwtSecret: "test-secret-32-chars-minimum-length-for-hmac",
      logger: false,
    });
    baseUrl = await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
  });

  it("POST /api/v1/auth/register-device pairs device and returns initial FREE tokens", async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/register-device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-123",
        deviceId: "esp32-test-01",
        email: "user123@example.com",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.paired).toBe(true);
    expect(body.tier).toBe("FREE");
    expect(body.capabilities.voiceAiEnabled).toBe(false);
    expect(body.jwt).toBeDefined();
    expect(body.binarySyncFrameBase64).toBeDefined();

    // Verify binary frame can be decoded from Base64
    const frameBuffer = Buffer.from(body.binarySyncFrameBase64, "base64");
    const frame = decodeFrame(new Uint8Array(frameBuffer));
    expect(frame.header.frameType).toBe(FrameType.SUBSCRIPTION_ENTITLEMENT_SYNC);
  });

  it("POST /api/v1/billing/webhook handles Stripe checkout.session.completed", async () => {
    // First register device
    await fetch(`${baseUrl}/api/v1/auth/register-device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "stripe-user-01",
        deviceId: "esp32-stripe-dev",
        email: "stripe@example.com",
      }),
    });

    // Simulate Stripe checkout.session.completed webhook
    const stripeWebhook = {
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: "stripe-user-01",
          customer: "cus_stripe_12345",
          subscription: "sub_stripe_67890",
        },
      },
    };

    const webhookRes = await fetch(`${baseUrl}/api/v1/billing/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stripeWebhook),
    });

    expect(webhookRes.status).toBe(200);
    const webhookBody = await webhookRes.json();
    expect(webhookBody.received).toBe(true);
    expect(webhookBody.updatedTier).toBe("PRO");
    expect(webhookBody.userId).toBe("stripe-user-01");

    // Verify user is now PRO
    const user = server.engine.getUser("stripe-user-01");
    expect(user?.tier).toBe("PRO");
    expect(user?.stripeCustomerId).toBe("cus_stripe_12345");
  });

  it("POST /api/v1/billing/webhook handles Stripe customer.subscription.deleted", async () => {
    // Setup PRO user
    server.engine.registerUser("user-canceler", "cancel@example.com");
    server.engine.updateUserTier("user-canceler", "PRO", {
      customerId: "cus_cancel_999",
      subscriptionId: "sub_cancel_888",
    });

    const cancelWebhook = {
      type: "customer.subscription.deleted",
      data: {
        object: {
          customer: "cus_cancel_999",
          id: "sub_cancel_888",
          status: "canceled",
        },
      },
    };

    const res = await fetch(`${baseUrl}/api/v1/billing/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cancelWebhook),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updatedTier).toBe("FREE");

    const user = server.engine.getUser("user-canceler");
    expect(user?.tier).toBe("FREE");
  });

  it("POST /api/v1/billing/webhook handles RevenueCat INITIAL_PURCHASE and EXPIRATION", async () => {
    server.engine.registerUser("rc-user-01", "rc@example.com");

    // Purchase
    const rcPurchase = {
      event: {
        type: "INITIAL_PURCHASE",
        app_user_id: "rc-user-01",
        product_id: "petbot_pro_monthly",
      },
    };

    const purchaseRes = await fetch(`${baseUrl}/api/v1/billing/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rcPurchase),
    });
    expect(purchaseRes.status).toBe(200);
    expect((await purchaseRes.json()).updatedTier).toBe("PRO");
    expect(server.engine.getUser("rc-user-01")?.tier).toBe("PRO");

    // Expiration
    const rcExpire = {
      event: {
        type: "EXPIRATION",
        app_user_id: "rc-user-01",
      },
    };

    const expireRes = await fetch(`${baseUrl}/api/v1/billing/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rcExpire),
    });
    expect(expireRes.status).toBe(200);
    expect((await expireRes.json()).updatedTier).toBe("FREE");
    expect(server.engine.getUser("rc-user-01")?.tier).toBe("FREE");
  });

  it("POST /api/v1/billing/dev-activate-pro enables 1-click Pro for companion", async () => {
    server.engine.registerUser("dev-user", "dev@example.com");
    server.engine.registerDevice("dev-user", "esp32-dev-robot");

    const res = await fetch(`${baseUrl}/api/v1/billing/dev-activate-pro`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "dev-user",
        deviceId: "esp32-dev-robot",
        persona: "Nova",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.tier).toBe("PRO");
    expect(body.activePersona).toBe("Nova");
    expect(body.capabilities.voiceAiEnabled).toBe(true);
    expect(body.jwt).toBeDefined();
    expect(body.binarySyncFrameBase64).toBeDefined();

    // Verify token claims
    const claims = await server.engine.verifyEntitlementJwt(body.jwt);
    expect(claims.tier).toBe("PRO");
    expect(claims.activePersona).toBe("Nova");
  });

  it("GET /api/v1/entitlements/status verifies Bearer JWT and returns quota & robot sync packet", async () => {
    // 1. Register device and get token
    const regRes = await fetch(`${baseUrl}/api/v1/auth/register-device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "status-user",
        deviceId: "esp32-status-dev",
      }),
    });
    const { jwt } = await regRes.json();

    // 2. Query status using Bearer Authorization
    const statusRes = await fetch(`${baseUrl}/api/v1/entitlements/status`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    });

    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();

    expect(statusBody.valid).toBe(true);
    expect(statusBody.userId).toBe("status-user");
    expect(statusBody.deviceId).toBe("esp32-status-dev");
    expect(statusBody.tier).toBe("FREE");
    expect(statusBody.voiceAiEnabled).toBe(false);
    expect(statusBody.quota.dailyWidgetGenerationsLimit).toBe(3);
    expect(statusBody.quota.dailyWidgetGenerationsRemaining).toBe(3);
    expect(statusBody.binarySyncFrameBase64).toBeDefined();

    // Decode returned robot sync packet
    const frame = decodeFrame(
      new Uint8Array(Buffer.from(statusBody.binarySyncFrameBase64, "base64"))
    );
    expect(frame.header.frameType).toBe(FrameType.SUBSCRIPTION_ENTITLEMENT_SYNC);
  });

  it("pushes live SUBSCRIPTION_ENTITLEMENT_SYNC frame over active WebSocket session on tier upgrade", async () => {
    // 1. Setup user and device
    const userId = "ws-user-01";
    const deviceId = "esp32-ws-robot";
    server.engine.registerUser(userId, "ws@petbot.ai");
    server.engine.registerDevice(userId, deviceId);

    // 2. Connect client WebSocket to gateway
    const wsUrl = baseUrl.replace("http://", "ws://") + `/ws/device/${deviceId}`;
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    expect(server.router.getAllActiveDeviceIds()).toContain(deviceId);

    // 3. Prepare frame collector on client WebSocket
    const receivedFramesPromise = new Promise<Uint8Array>((resolve) => {
      ws.on("message", (data: any, isBinary: boolean) => {
        if (isBinary) {
          const buf = data instanceof Buffer ? data : Buffer.from(data);
          resolve(new Uint8Array(buf));
        }
      });
    });

    // 4. Trigger dev-activate-pro which immediately pushes frame
    const activateRes = await fetch(`${baseUrl}/api/v1/billing/dev-activate-pro`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        deviceId,
        persona: "Atlas",
      }),
    });
    expect(activateRes.status).toBe(200);

    // 5. Client receives pushed binary frame in real time
    const pushedBinaryFrame = await receivedFramesPromise;
    expect(pushedBinaryFrame.byteLength).toBeGreaterThan(0);

    const decoded = decodeFrame(pushedBinaryFrame);
    expect(decoded.header.frameType).toBe(FrameType.SUBSCRIPTION_ENTITLEMENT_SYNC);

    const payload = decodeControlPayload(
      SubscriptionEntitlementSyncSchema,
      decoded.payload
    );
    expect(payload.tier).toBe("PRO");
    expect(payload.enabledPersonas).toContain("Atlas");

    ws.close();
  });
});
