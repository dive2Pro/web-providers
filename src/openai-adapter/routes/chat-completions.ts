import type { FastifyInstance } from "fastify";
import { normalizeChatCompletionsRequest } from "../normalize";
import { serializeChatCompletions } from "../serialize-chat";
import { serializeChatCompletionsStream } from "../streaming/chat-completions";
import type { HelperClient } from "../app";
import { handlePseudoStreamRoute, sendAdapterRouteError } from "./streaming";

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
      return await handlePseudoStreamRoute({
        body,
        reply,
        helperClient,
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
