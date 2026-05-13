import type { FastifyInstance } from "fastify";
import { getAnthropicPublicModel } from "../models";
import { normalizeMessagesRequest } from "../normalize";
import { serializeMessagesResponse } from "../serialize-messages";
import { serializeMessagesStream } from "../streaming";
import type { ExecutionClient } from "../app";
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

function getSessionId(headers: Record<string, unknown>) {
  const sessionId = headers["x-claude-code-session-id"];
  if (typeof sessionId === "string" && sessionId.length > 0) {
    return sessionId;
  }

  throw invalidRequestError("x-claude-code-session-id header is required");
}

function assertJsonObject(body: unknown) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalidRequestError("Request body must be a JSON object");
  }
}

function createMessageId() {
  return `msg_${Date.now()}`;
}

export function registerMessagesRoute(
  app: FastifyInstance,
  executionClient: ExecutionClient,
) {
  app.post("/v1/messages", async (request, reply) => {
    try {
      assertJsonObject(request.body);
      const body = request.body as {
        model?: string;
        system?: string | Array<{ type?: string; text?: string }>;
        messages?: Array<{
          role: "user" | "assistant";
          content:
            | string
            | Array<
                | { type: "text"; text?: string }
                | { type: "tool_use"; id?: string; name?: string; input?: unknown }
                | {
                    type: "tool_result";
                    tool_use_id?: string;
                    content?: string | Array<{ type?: string; text?: string }>;
                    is_error?: boolean;
                  }
                | { type: "image" | "document"; source?: unknown }
              >;
        }>;
        tools?: Array<{
          name?: string;
          description?: string;
          input_schema?: unknown;
        }>;
        tool_choice?:
          | { type?: "auto" | "any" | "tool" | "none"; name?: string }
          | undefined;
        stream?: boolean;
        temperature?: number;
        max_tokens?: number;
      };

      if (typeof body.model !== "string" || body.model.length === 0) {
        throw invalidRequestError("model is required");
      }

      const model = getAnthropicPublicModel(body.model);
      if (!model) {
        throw new AnthropicAdapterError(
          404,
          "not_found_error",
          `Unknown model: ${body.model}`,
        );
      }

      const normalized = normalizeMessagesRequest(body, model);
      const result = await executionClient.run(normalized, {
        sessionId: getSessionId(request.headers as Record<string, unknown>),
        signal: request.raw.aborted ? AbortSignal.abort() : undefined,
      });

      const id = createMessageId();

      if (body.stream === true) {
        return reply
          .code(200)
          .header("content-type", "text/event-stream; charset=utf-8")
          .header("cache-control", "no-cache")
          .send(
            serializeMessagesStream({
              id,
              model: body.model,
              result,
            }).join(""),
          );
      }

      return reply.send(
        serializeMessagesResponse({
          id,
          model: body.model,
          result,
        }),
      );
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
