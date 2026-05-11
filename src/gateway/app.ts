import Fastify from "fastify";
import { createHelperClient } from "../openai-adapter/helper-client";
import { registerChatCompletionsRoute } from "../openai-adapter/routes/chat-completions";
import { registerResponsesRoute } from "../openai-adapter/routes/responses";
import { registerMessagesRoute } from "../anthropic-adapter/routes/messages";
import { registerCountTokensRoute } from "../anthropic-adapter/routes/count-tokens";
import { authenticationError } from "../anthropic-adapter/errors";
import { registerGatewayModelsRoutes } from "./routes/models";
import type { ExecutionClient as OpenAiExecutionClient } from "../openai-adapter/app";
import type { ExecutionClient as AnthropicExecutionClient } from "../anthropic-adapter/app";

function isBearerAuthorized(headers: Record<string, unknown>, token: string) {
  return headers.authorization === `Bearer ${token}`;
}

function isAnthropicAuthorized(headers: Record<string, unknown>, token: string) {
  return (
    headers.authorization === `Bearer ${token}` || headers["x-api-key"] === token
  );
}

function isOpenAiPath(url: string) {
  return url === "/v1/chat/completions" || url === "/v1/responses";
}

function isAnthropicPath(url: string) {
  return (
    url === "/v1/messages" ||
    url === "/v1/messages/count_tokens" ||
    url === "/v1/models" ||
    url.startsWith("/v1/models/")
  );
}

function isOpenAiModelsAuthorized(input: {
  headers: Record<string, unknown>;
  openAiToken?: string;
  anthropicToken?: string;
}) {
  return (
    (input.openAiToken && isBearerAuthorized(input.headers, input.openAiToken)) ||
    (input.anthropicToken && isAnthropicAuthorized(input.headers, input.anthropicToken))
  );
}

export function buildGatewayApp(input: {
  openAiToken?: string;
  anthropicToken?: string;
  helperBaseUrl: string;
  helperToken?: string;
  fetchImpl?: typeof fetch;
}) {
  const app = Fastify();
  const executionClient = createHelperClient({
    helperBaseUrl: input.helperBaseUrl,
    helperToken: input.helperToken,
    fetchImpl: input.fetchImpl,
  });

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? request.url;
    const headers = request.headers as Record<string, unknown>;

    if (url === "/v1/models" || url.startsWith("/v1/models/")) {
      if (
        (input.openAiToken || input.anthropicToken) &&
        !isOpenAiModelsAuthorized({
          headers,
          openAiToken: input.openAiToken,
          anthropicToken: input.anthropicToken,
        })
      ) {
        const wantsAnthropicStyle = "x-api-key" in headers;
        if (wantsAnthropicStyle) {
          const error = authenticationError("Unauthorized");
          return reply.code(error.statusCode).send({
            type: "error",
            error: {
              type: error.type,
              message: error.message,
            },
          });
        }

        return reply.code(401).send({
          error: {
            code: "unauthorized",
            message: "Unauthorized",
          },
        });
      }

      return;
    }

    if (isOpenAiPath(url) && input.openAiToken && !isBearerAuthorized(headers, input.openAiToken)) {
      return reply.code(401).send({
        error: {
          code: "unauthorized",
          message: "Unauthorized",
        },
      });
    }

    if (
      isAnthropicPath(url) &&
      input.anthropicToken &&
      !isAnthropicAuthorized(headers, input.anthropicToken)
    ) {
      const error = authenticationError("Unauthorized");
      return reply.code(error.statusCode).send({
        type: "error",
        error: {
          type: error.type,
          message: error.message,
        },
      });
    }
  });

  registerGatewayModelsRoutes(app);
  registerChatCompletionsRoute(
    app,
    executionClient as unknown as OpenAiExecutionClient,
  );
  registerResponsesRoute(
    app,
    executionClient as unknown as OpenAiExecutionClient,
  );
  registerMessagesRoute(
    app,
    executionClient as unknown as AnthropicExecutionClient,
  );
  registerCountTokensRoute(app);

  return app;
}
