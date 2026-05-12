import type { FastifyInstance } from "fastify";
import { listPublicModels } from "../../openai-adapter/models";

export function registerGatewayModelsRoutes(app: FastifyInstance) {
  const openAiModels = listPublicModels();
  const data = openAiModels.map((model) => ({
    id: model.id,
    object: "model",
    owned_by: "web-providers",
    type: "model",
    display_name: model.id,
    created_at: "2026-05-11T00:00:00Z",
  }));

  app.get("/v1/models", async () => ({
    object: "list",
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data[data.length - 1]?.id ?? null,
  }));

  app.get("/v1/models/:modelId", async (request, reply) => {
    const modelId = (request.params as { modelId?: string }).modelId ?? "";
    const openAiModel = openAiModels.find((model) => model.id === modelId);
    if (openAiModel) {
      return {
        type: "model",
        id: openAiModel.id,
        display_name: openAiModel.id,
        created_at: "2026-05-11T00:00:00Z",
      };
    }

    return reply.code(404).send({
      type: "error",
      error: {
        type: "not_found_error",
        message: `Model not found: ${modelId}`,
      },
    });
  });
}
