import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  EntitlementEngine,
  type SubscriptionTier,
  type TierCapabilities,
} from "../auth/entitlement-engine.js";
import type { CloudGatewayRouter } from "../index.js";

export interface SubscriptionRoutesOptions {
  readonly entitlementEngine: EntitlementEngine;
  readonly gatewayRouter?: CloudGatewayRouter | undefined;
}

// ============================================================================
// Request Validation Schemas
// ============================================================================

const RegisterDeviceSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  deviceId: z.string().min(1, "deviceId is required"),
  email: z.string().email().optional(),
  devicePublicKeyHex: z.string().optional(),
});

const DevActivateProSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  deviceId: z.string().optional(),
  persona: z.enum(["Default", "Nova", "Atlas", "Pixel"]).optional(),
});

const DevDeactivateProSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  deviceId: z.string().optional(),
});

const SetPersonaSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  persona: z.string().min(1, "persona is required"),
});

// ============================================================================
// Subscription & Billing Fastify Route Plugin
// ============================================================================

export async function subscriptionRoutes(
  fastify: FastifyInstance,
  options: SubscriptionRoutesOptions
): Promise<void> {
  const engine = options.entitlementEngine;
  const router = options.gatewayRouter;

  /**
   * Helper: Push live FrameType.SUBSCRIPTION_ENTITLEMENT_SYNC binary frame to active device socket
   */
  async function notifyDeviceEntitlementSync(
    userId: string,
    deviceId: string,
    tier: SubscriptionTier,
    persona?: string
  ): Promise<Uint8Array | undefined> {
    const entitlements = await engine.mintEntitlementToken(
      userId,
      deviceId,
      tier,
      persona
    );

    if (router) {
      router.pushFrameToDevice(deviceId, entitlements.binaryFrame);
    }
    return entitlements.binaryFrame;
  }

  // --------------------------------------------------------------------------
  // 1. POST /api/v1/auth/register-device
  // Pairs an ESP32-S3 deviceId to a user account and returns initial FREE tokens.
  // --------------------------------------------------------------------------
  fastify.post(
    "/api/v1/auth/register-device",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = RegisterDeviceSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request payload",
          details: parseResult.error.format(),
        });
      }

      const { userId, deviceId, email, devicePublicKeyHex } = parseResult.data;

      // Register user and pair device in Entitlement Engine
      engine.registerUser(userId, email);
      engine.registerDevice(userId, deviceId, devicePublicKeyHex);

      const user = engine.getUser(userId)!;
      const entitlements = await engine.mintEntitlementToken(
        userId,
        deviceId,
        user.tier,
        user.activePersona
      );

      return reply.code(200).send({
        success: true,
        paired: true,
        userId,
        deviceId,
        tier: user.tier,
        capabilities: entitlements.capabilities,
        jwt: entitlements.jwt,
        expiresAt: entitlements.expiresAt,
        syncPayload: entitlements.syncPayload,
        binarySyncFrameBase64: Buffer.from(entitlements.binaryFrame).toString("base64"),
      });
    }
  );

  // --------------------------------------------------------------------------
  // 2. POST /api/v1/billing/webhook
  // Handles Stripe and RevenueCat webhook events in real-time.
  // --------------------------------------------------------------------------
  fastify.post(
    "/api/v1/billing/webhook",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, any>;
      if (!body) {
        return reply.code(400).send({ error: "Missing webhook payload" });
      }

      let eventType = "unknown";
      let targetUserId: string | undefined;
      let targetTier: SubscriptionTier | undefined;

      // --- Stripe Webhook Event Detection ---
      if (typeof body["type"] === "string" && body["data"]?.["object"]) {
        eventType = body["type"];
        const obj = body["data"]["object"];

        if (eventType === "checkout.session.completed") {
          targetUserId =
            obj["client_reference_id"] ||
            obj["metadata"]?.["userId"] ||
            obj["customer_email"];

          if (!targetUserId && obj["customer"]) {
            const existing = engine.getUserByStripeCustomer(obj["customer"]);
            targetUserId = existing?.userId;
          }

          if (targetUserId) {
            targetTier = "PRO";
            engine.updateUserTier(targetUserId, "PRO", {
              customerId: obj["customer"],
              subscriptionId: obj["subscription"],
            });
          }
        } else if (
          eventType === "customer.subscription.deleted" ||
          eventType === "customer.subscription.updated"
        ) {
          const customerId = obj["customer"];
          const status = obj["status"];
          const user = customerId ? engine.getUserByStripeCustomer(customerId) : undefined;

          if (user) {
            targetUserId = user.userId;
            if (eventType === "customer.subscription.deleted" || status === "canceled" || status === "unpaid") {
              targetTier = "FREE";
              engine.updateUserTier(user.userId, "FREE");
            } else if (status === "active") {
              targetTier = "PRO";
              engine.updateUserTier(user.userId, "PRO", {
                customerId,
                subscriptionId: obj["id"],
              });
            }
          }
        }
      }
      // --- RevenueCat Webhook Event Detection ---
      else if (body["event"] && typeof body["event"]["type"] === "string") {
        const rcEvent = body["event"];
        eventType = rcEvent["type"];
        const appUserId = rcEvent["app_user_id"];

        if (appUserId) {
          targetUserId = appUserId;
          if (
            eventType === "INITIAL_PURCHASE" ||
            eventType === "RENEWAL" ||
            eventType === "UNCANCELLATION" ||
            eventType === "PRODUCT_CHANGE"
          ) {
            targetTier = "PRO";
            engine.updateUserTier(appUserId, "PRO");
          } else if (eventType === "CANCELLATION" || eventType === "EXPIRATION") {
            targetTier = "FREE";
            engine.updateUserTier(appUserId, "FREE");
          }
        }
      }

      // If user tier was modified, push live SUBSCRIPTION_ENTITLEMENT_SYNC frames
      let notifiedDevicesCount = 0;
      if (targetUserId && targetTier) {
        const user = engine.getUser(targetUserId);
        const devices = engine.getDevicesForUser(targetUserId);

        for (const dev of devices) {
          await notifyDeviceEntitlementSync(
            targetUserId,
            dev.deviceId,
            targetTier,
            user?.activePersona
          );
          notifiedDevicesCount += 1;
        }
      }

      return reply.code(200).send({
        received: true,
        eventType,
        userId: targetUserId,
        updatedTier: targetTier,
        notifiedDevicesCount,
      });
    }
  );

  // --------------------------------------------------------------------------
  // 3. POST /api/v1/billing/dev-activate-pro
  // Instant developer/demo endpoint (used by Companion 1-click Pro toggle)
  // --------------------------------------------------------------------------
  fastify.post(
    "/api/v1/billing/dev-activate-pro",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = DevActivateProSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request payload",
          details: parseResult.error.format(),
        });
      }

      const { userId, deviceId, persona } = parseResult.data;

      // Upgrade user to PRO in-memory
      const user = engine.updateUserTier(userId, "PRO");
      if (persona) {
        engine.updateUserPersona(userId, persona);
      }

      // Determine target device
      let targetDeviceId = deviceId;
      if (!targetDeviceId) {
        const devs = engine.getDevicesForUser(userId);
        targetDeviceId = devs[0]?.deviceId ?? "robot-esp32-default";
      }

      // Mint PRO entitlements with custom persona
      const entitlements = await engine.mintEntitlementToken(
        userId,
        targetDeviceId,
        "PRO",
        user.activePersona
      );

      // Beam live frame directly to active WebSocket session if connected
      if (router) {
        router.pushFrameToDevice(targetDeviceId, entitlements.binaryFrame);
      }

      return reply.code(200).send({
        success: true,
        tier: "PRO",
        userId,
        deviceId: targetDeviceId,
        activePersona: user.activePersona,
        capabilities: entitlements.capabilities,
        jwt: entitlements.jwt,
        expiresAt: entitlements.expiresAt,
        syncPayload: entitlements.syncPayload,
        binarySyncFrameBase64: Buffer.from(entitlements.binaryFrame).toString("base64"),
      });
    }
  );

  // --------------------------------------------------------------------------
  // 3b. POST /api/v1/billing/dev-deactivate-pro
  // Instant developer toggle to downgrade back to FREE
  // --------------------------------------------------------------------------
  fastify.post(
    "/api/v1/billing/dev-deactivate-pro",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = DevDeactivateProSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request payload",
          details: parseResult.error.format(),
        });
      }

      const { userId, deviceId } = parseResult.data;
      const user = engine.updateUserTier(userId, "FREE");

      let targetDeviceId = deviceId;
      if (!targetDeviceId) {
        const devs = engine.getDevicesForUser(userId);
        targetDeviceId = devs[0]?.deviceId ?? "robot-esp32-default";
      }

      const entitlements = await engine.mintEntitlementToken(
        userId,
        targetDeviceId,
        "FREE",
        user.activePersona
      );

      if (router) {
        router.pushFrameToDevice(targetDeviceId, entitlements.binaryFrame);
      }

      return reply.code(200).send({
        success: true,
        tier: "FREE",
        userId,
        deviceId: targetDeviceId,
        capabilities: entitlements.capabilities,
        jwt: entitlements.jwt,
        expiresAt: entitlements.expiresAt,
        syncPayload: entitlements.syncPayload,
        binarySyncFrameBase64: Buffer.from(entitlements.binaryFrame).toString("base64"),
      });
    }
  );

  // --------------------------------------------------------------------------
  // 3c. POST /api/v1/entitlements/persona
  // Configure active voice persona for PRO users (Nova, Atlas, Pixel, Default)
  // --------------------------------------------------------------------------
  fastify.post(
    "/api/v1/entitlements/persona",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = SetPersonaSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request payload",
          details: parseResult.error.format(),
        });
      }

      const { userId, persona } = parseResult.data;
      try {
        const user = engine.updateUserPersona(userId, persona);
        return reply.code(200).send({
          success: true,
          userId,
          tier: user.tier,
          activePersona: user.activePersona,
        });
      } catch (err: any) {
        return reply.code(403).send({
          error: err.message ?? "Forbidden persona selection",
        });
      }
    }
  );

  // --------------------------------------------------------------------------
  // 4. GET /api/v1/entitlements/status
  // Verifies bearer JWT and returns current tier, quota usage, persona, and sync packet.
  // --------------------------------------------------------------------------
  fastify.get(
    "/api/v1/entitlements/status",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;
      const query = request.query as Record<string, string>;

      let userId: string | undefined;
      let deviceId: string | undefined;
      let token = query["token"];

      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7).trim();
      }

      if (token) {
        try {
          const claims = await engine.verifyEntitlementJwt(token);
          userId = claims.sub;
          deviceId = claims.deviceId;
        } catch (err: any) {
          return reply.code(401).send({
            error: "Invalid or expired bearer token",
            message: err.message,
          });
        }
      } else {
        // Fallback to explicit query params
        userId = query["userId"];
        deviceId = query["deviceId"];
      }

      if (!userId) {
        return reply.code(400).send({
          error: "Missing authentication: Provide Authorization: Bearer <jwt> or ?userId=<id>",
        });
      }

      const user = engine.getUser(userId) ?? engine.registerUser(userId);
      const targetDeviceId = deviceId ?? engine.getDevicesForUser(userId)[0]?.deviceId ?? "robot-esp32-default";
      const quota = engine.checkWidgetQuota(userId);

      const entitlements = await engine.mintEntitlementToken(
        userId,
        targetDeviceId,
        user.tier,
        user.activePersona
      );

      return reply.code(200).send({
        valid: true,
        userId,
        deviceId: targetDeviceId,
        tier: user.tier,
        voiceAiEnabled: entitlements.capabilities.voiceAiEnabled,
        activePersona: user.activePersona,
        allowedPersonas: [...entitlements.capabilities.allowedPersonas],
        quota: {
          dailyWidgetGenerationsUsed: quota.used,
          dailyWidgetGenerationsLimit: quota.limit,
          dailyWidgetGenerationsRemaining: quota.remaining,
        },
        capabilities: entitlements.capabilities,
        expiresAt: entitlements.expiresAt,
        jwt: entitlements.jwt,
        syncPayload: entitlements.syncPayload,
        binarySyncFrameBase64: Buffer.from(entitlements.binaryFrame).toString("base64"),
      });
    }
  );
}
