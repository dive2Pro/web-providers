import type { FastifyInstance } from "fastify";
import { normalizeResponsesRequest } from "../normalize";
import { serializeResponses } from "../serialize-responses";
import { serializeResponsesStream } from "../streaming/responses";
import type { HelperClient } from "../app";
import { handlePseudoStreamRoute, sendAdapterRouteError } from "./streaming";

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
      return await handlePseudoStreamRoute({
        body,
        reply,
        helperClient,
        idPrefix: "resp",
        normalize: normalizeResponsesRequest,
        serialize: serializeResponses,
        serializeStream: serializeResponsesStream,
      });
    } catch (error) {
      return sendAdapterRouteError(error, reply);
    }
  });
}
