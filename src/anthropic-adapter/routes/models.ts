import type { FastifyInstance } from "fastify";
import {
  getAnthropicPublicModel,
  listAnthropicPublicModels,
} from "../models";

export function registerAnthropicModelsRoute(app: FastifyInstance) {
  const models = listAnthropicPublicModels();
  const modelMap = new Map(models.map((model) => [model.id, model]));

  app.get("/v1/models", async () => ({
    data: models.map((model) => ({
      type: "model",
      id: model.id,
      display_name: model.displayName,
      created_at: model.createdAt,
    })),
    first_id: models[0]?.id ?? null,
    has_more: false,
    last_id: models[models.length - 1]?.id ?? null,
  }));

  app.get("/v1/models/:modelId", async (request, reply) => {
    const modelId = (request.params as { modelId?: string }).modelId ?? "";
    const discoveredModel = modelMap.get(modelId);

    if (discoveredModel) {
      return {
        type: "model",
        id: discoveredModel.id,
        display_name: discoveredModel.displayName,
        created_at: discoveredModel.createdAt,
      };
    }

    const upstreamModel = getAnthropicPublicModel(modelId);
    if (!upstreamModel) {
      return reply.code(404).send({
        type: "error",
        error: {
          type: "not_found_error",
          message: `Model not found: ${modelId}`,
        },
      });
    }

    return {
      type: "model",
      id: upstreamModel.id,
      display_name: upstreamModel.id,
      created_at: "2026-05-11T00:00:00Z",
    };
  });
}
