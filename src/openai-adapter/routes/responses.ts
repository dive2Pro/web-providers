import type { FastifyInstance } from "fastify";
import { AdapterError } from "../errors";
import { getPublicModel } from "../models";
import { normalizeResponsesRequest } from "../normalize";
import { serializeResponses } from "../serialize-responses";
import type { HelperClient } from "../app";

export function registerResponsesRoute(
  app: FastifyInstance,
  helperClient: HelperClient,
) {
  app.post("/v1/responses", async (request, reply) => {
    try {
      const body = request.body as {
        model: string;
        input?: Array<{
          role: "system" | "user" | "assistant";
          content?: Array<{ type: string; text?: string }>;
        }>;
        stream?: boolean;
        tools?: Array<{
          type?: "function";
          name: string;
          description?: string;
          parameters?: unknown;
        }>;
        tool_choice?: unknown;
        temperature?: number;
        max_output_tokens?: number;
      };
      const model = getPublicModel(body.model);
      if (!model) {
        throw new AdapterError(404, "model_not_found", `Unknown model: ${body.model}`);
      }

      const normalized = normalizeResponsesRequest(body, model);
      const result = await helperClient.run(normalized);
      return serializeResponses({
        id: `resp-${Date.now()}`,
        created: Math.floor(Date.now() / 1000),
        model: normalized.publicModel,
        result,
      });
    } catch (error) {
      if (error instanceof AdapterError) {
        return reply.code(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
          },
        });
      }

      throw error;
    }
  });
}
