import type { FastifyInstance } from "fastify";
import { normalizeChatCompletionsRequest } from "../normalize";
import { serializeChatCompletions } from "../serialize-chat";
import { serializeChatCompletionsStream } from "../streaming/chat-completions";
import type { ExecutionClient } from "../app";
import { handlePseudoStreamRoute, sendAdapterRouteError } from "./streaming";

export function registerChatCompletionsRoute(
  app: FastifyInstance,
  executionClient: ExecutionClient,
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
      return await handlePseudoStreamRoute({
        body,
        request,
        reply,
        executionClient,
        idPrefix: "chatcmpl",
        normalize: normalizeChatCompletionsRequest,
        serialize: serializeChatCompletions,
        serializeStream: serializeChatCompletionsStream,
      });
    } catch (error) {
      return sendAdapterRouteError(error, reply);
    }
  });
}
