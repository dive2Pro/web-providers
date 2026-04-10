import type { FastifyInstance } from "fastify";
import { AdapterError } from "../errors";
import { getPublicModel } from "../models";
import { normalizeChatCompletionsRequest } from "../normalize";
import { serializeChatCompletions } from "../serialize-chat";
import type { HelperClient } from "../app";

export function registerChatCompletionsRoute(
  app: FastifyInstance,
  helperClient: HelperClient,
) {
  app.post("/v1/chat/completions", async (request, reply) => {
    try {
      const body = request.body as {
        model: string;
        messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        stream?: boolean;
        tools?: Array<{
          type: "function";
          function: {
            name: string;
            description?: string;
            parameters?: unknown;
          };
        }>;
        tool_choice?: unknown;
        temperature?: number;
        max_tokens?: number;
      };
      const model = getPublicModel(body.model);
      if (!model) {
        throw new AdapterError(404, "model_not_found", `Unknown model: ${body.model}`);
      }

      const normalized = normalizeChatCompletionsRequest(body, model);
      const result = await helperClient.run(normalized);
      return serializeChatCompletions({
        id: `chatcmpl-${Date.now()}`,
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
