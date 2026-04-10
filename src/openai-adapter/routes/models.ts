import type { FastifyInstance } from "fastify";
import { listPublicModels } from "../models";

export function registerModelsRoute(app: FastifyInstance) {
  app.get("/v1/models", async () => ({
    object: "list",
    data: listPublicModels().map((model) => ({
      id: model.id,
      object: "model",
      owned_by: "web-providers",
    })),
  }));
}
