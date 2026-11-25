import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { WidgetPackageSchema } from "@petbot/widget-schema";
import {
  ZeroCodeCompilerService,
  type GenerateWidgetParams,
  type GenerateWidgetResult,
  type StudioTemplate,
} from "../studio/zero-code-compiler-service.js";

export interface StudioRoutesOptions {
  readonly compilerService?: ZeroCodeCompilerService | undefined;
}

// ============================================================================
// Request Validation Schemas
// ============================================================================

const StudioGenerateRequestSchema = z.object({
  prompt: z.string().min(1, "prompt is required").max(1000),
  currentWidget: WidgetPackageSchema.optional(),
  conversationHistory: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string(),
      })
    )
    .optional(),
});

export type StudioGenerateRequest = z.infer<typeof StudioGenerateRequestSchema>;

// ============================================================================
// Studio Fastify Route Plugin
// ============================================================================

export async function studioRoutes(
  fastify: FastifyInstance,
  options?: StudioRoutesOptions
): Promise<void> {
  const compilerService = options?.compilerService ?? new ZeroCodeCompilerService();

  /**
   * Helper handler for generating or refining widgets
   */
  async function handleGenerate(request: FastifyRequest, reply: FastifyReply) {
    const parseResult = StudioGenerateRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: "Invalid request payload",
        details: parseResult.error.format(),
      });
    }

    try {
      const result: GenerateWidgetResult = await compilerService.generateOrRefineWidget(
        parseResult.data
      );

      return reply.code(200).send({
        success: true,
        widget: result.widget,
        bytecodeBase64: result.bytecodeBase64,
        assistantSummary: result.assistantSummary,
        linkedWorkflow: result.linkedWorkflow,
      });
    } catch (err) {
      request.log.error(err, "Failed to compile zero-code widget");
      return reply.code(500).send({
        error: "Widget compilation failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Helper handler for retrieving curated templates
   */
  async function handleGetTemplates(_request: FastifyRequest, reply: FastifyReply) {
    try {
      const templates: StudioTemplate[] = compilerService.getTemplates();
      return reply.code(200).send({
        success: true,
        templates,
      });
    } catch (err) {
      return reply.code(500).send({
        error: "Failed to retrieve studio templates",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Register endpoints supporting both prefixed and non-prefixed paths
  fastify.post("/generate", handleGenerate);
  fastify.post("/api/v1/studio/generate", handleGenerate);

  fastify.get("/templates", handleGetTemplates);
  fastify.get("/api/v1/studio/templates", handleGetTemplates);
}
