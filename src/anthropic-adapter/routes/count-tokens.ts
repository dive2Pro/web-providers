import type { FastifyInstance } from "fastify";
import { estimateInputTokens } from "../normalize";
import { AnthropicAdapterError, invalidRequestError } from "../errors";

function errorResponse(error: AnthropicAdapterError) {
  return {
    type: "error",
    error: {
      type: error.type,
      message: error.message,
    },
  };
}

export function registerCountTokensRoute(app: FastifyInstance) {
  app.post("/v1/messages/count_tokens", async (request, reply) => {
    try {
      if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
        throw invalidRequestError("Request body must be a JSON object");
      }

      const body = request.body as {
        system?: string | Array<{ type?: string; text?: string }>;
        messages?: Array<{
          role: "user" | "assistant";
          content?: string | Array<{ type?: string; text?: string }>;
        }>;
        tools?: Array<{
          name?: string;
          description?: string;
          input_schema?: unknown;
        }>;
      };

      return reply.send({
        input_tokens: estimateInputTokens(body),
      });
    } catch (error) {
      if (error instanceof AnthropicAdapterError) {
        return reply.code(error.statusCode).send(errorResponse(error));
      }

      const unexpected = new AnthropicAdapterError(
        500,
        "api_error",
        error instanceof Error ? error.message : "Unexpected error",
      );
      return reply.code(unexpected.statusCode).send(errorResponse(unexpected));
    }
  });
}
