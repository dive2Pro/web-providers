import Fastify from "fastify";
import { createHelperClient as createAnthropicHelperClient } from "../anthropic-adapter/helper-client";
import { registerChatCompletionsRoute } from "../openai-adapter/routes/chat-completions";
import { registerResponsesRoute } from "../openai-adapter/routes/responses";
import { registerMessagesRoute } from "../anthropic-adapter/routes/messages";
import { registerCountTokensRoute } from "../anthropic-adapter/routes/count-tokens";
import { authenticationError } from "../anthropic-adapter/errors";
import { registerGatewayModelsRoutes } from "./routes/models";
import { createHelperClient as createOpenAiHelperClient } from "../openai-adapter/helper-client";
import type { ExecutionClient as OpenAiExecutionClient } from "../openai-adapter/app";
import type { ExecutionClient as AnthropicExecutionClient } from "../anthropic-adapter/app";
import {
  registerRequestLogging,
  type RequestLogger,
} from "../shared/request-logging";
import {
  LocalRequestLogStore,
  type RequestLogStore,
} from "../shared/request-log-store";
import { registerRequestLogRoutes } from "../shared/request-log-routes";

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

function isGatewayAuthorized(input: {
  headers: Record<string, unknown>;
  openAiToken?: string;
  anthropicToken?: string;
}) {
  return isOpenAiModelsAuthorized(input);
}

function shouldStoreGatewayRequestLog(routePath: string | null) {
  return (
    routePath === "/v1/messages" ||
    routePath === "/v1/chat/completions" ||
    routePath === "/v1/responses"
  );
}

export function buildGatewayApp(input: {
  openAiToken?: string;
  anthropicToken?: string;
  helperBaseUrl: string;
  helperToken?: string;
  fetchImpl?: typeof fetch;
  requestLogger?: RequestLogger;
  requestLogDir?: string;
  requestLogStore?: RequestLogStore;
}) {
  const app = Fastify();
  const requestLogStore =
    input.requestLogStore ??
    (input.requestLogDir
      ? new LocalRequestLogStore({
          scope: "gateway",
          dir: input.requestLogDir,
        })
      : null);
  registerRequestLogging(app, {
    scope: "gateway",
    logger: input.requestLogger,
    store: requestLogStore ?? undefined,
    shouldStore: (entry) => shouldStoreGatewayRequestLog(entry.routePath),
  });
  const openAiExecutionClient: OpenAiExecutionClient = createOpenAiHelperClient({
    helperBaseUrl: input.helperBaseUrl,
    helperToken: input.helperToken,
    fetchImpl: input.fetchImpl,
  });
  const anthropicExecutionClient: AnthropicExecutionClient =
    createAnthropicHelperClient({
    helperBaseUrl: input.helperBaseUrl,
    helperToken: input.helperToken,
    fetchImpl: input.fetchImpl,
  });
  const fetchImpl = input.fetchImpl ?? fetch;

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

    if (
      (input.openAiToken || input.anthropicToken) &&
      !isGatewayAuthorized({
        headers,
        openAiToken: input.openAiToken,
        anthropicToken: input.anthropicToken,
      })
    ) {
      return reply.code(401).send({
        error: {
          code: "unauthorized",
          message: "Unauthorized",
        },
      });
    }
  });

  registerGatewayModelsRoutes(app);
  if (requestLogStore) {
    registerRequestLogRoutes(app, {
      scope: "gateway",
      store: requestLogStore,
    });
  }
  app.get("/v1/debug/session-bindings", async (_request, reply) => {
    const response = await fetchImpl(
      `${input.helperBaseUrl}/v1/debug/session-bindings`,
      {
        method: "GET",
        headers: input.helperToken
          ? { authorization: `Bearer ${input.helperToken}` }
          : {},
      },
    );

    const payload = (await response.json()) as unknown;
    return reply.code(response.status).send(payload);
  });
  registerChatCompletionsRoute(
    app,
    openAiExecutionClient,
  );
  registerResponsesRoute(
    app,
    openAiExecutionClient,
  );
  registerMessagesRoute(
    app,
    anthropicExecutionClient,
  );
  registerCountTokensRoute(app);

  return app;
}
