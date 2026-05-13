import Fastify from "fastify";
import type { BrowserAutomationClient } from "./browser/types";
import { registerCountTokensRoute } from "../anthropic-adapter/routes/count-tokens";
import {
  authenticationError,
  mapHelperError as mapAnthropicHelperError,
} from "../anthropic-adapter/errors";
import { toProviderChatRequest as toAnthropicProviderChatRequest } from "../anthropic-adapter/helper-client";
import { registerMessagesRoute } from "../anthropic-adapter/routes/messages";
import type { ExecutionClient as AnthropicExecutionClient } from "../anthropic-adapter/app";
import { registerGatewayModelsRoutes } from "../gateway/routes/models";
import { toProviderChatRequest } from "../openai-adapter/helper-client";
import { registerChatCompletionsRoute } from "../openai-adapter/routes/chat-completions";
import { registerResponsesRoute } from "../openai-adapter/routes/responses";
import { HelperError } from "./errors";
import { registerBindRoute } from "./routes/bind";
import { registerChatRoute } from "./routes/chat";
import { registerDebugProviderLastRoute } from "./routes/debug-provider-last";
import { registerDebugSessionBindingsRoute } from "./routes/debug-session-bindings";
import { registerHealthRoute } from "./routes/health";
import { registerInternalPiProviderChatRoute } from "./routes/internal-pi-provider-chat";
import { registerInternalPiSessionShutdownRoute } from "./routes/internal-pi-session-shutdown";
import { registerProviderChatRoute } from "./routes/provider-chat";
import { registerResetRoute } from "./routes/reset";
import { HelperRuntime } from "./runtime";
import {
  LocalSessionBindingStore,
  type SessionBindingStore,
} from "./session-binding-store";
import { HelperState } from "./state";
import {
  registerRequestLogging,
  type RequestLogger,
} from "../shared/request-logging";
import {
  LocalRequestLogStore,
  type RequestLogStore,
} from "../shared/request-log-store";
import { registerRequestLogRoutes } from "../shared/request-log-routes";
import {
  buildSessionTitleResponse,
  isSessionTitleRequest,
} from "../shared/session-title";

export interface AppDeps {
  token?: string;
  browserClient: BrowserAutomationClient;
  requestLogger?: RequestLogger;
  requestLogDir?: string;
  requestLogStore?: RequestLogStore;
  sessionBindingDir?: string;
  sessionBindingStore?: SessionBindingStore;
}

export interface AppContext {
  browserClient: BrowserAutomationClient;
  state: HelperState;
  runtime: HelperRuntime;
}

function isBearerAuthorized(headers: Record<string, unknown>, token: string) {
  return headers.authorization === `Bearer ${token}`;
}

function isAnthropicAuthorized(headers: Record<string, unknown>, token: string) {
  return (
    headers.authorization === `Bearer ${token}` || headers["x-api-key"] === token
  );
}

function isPublicModelsPath(pathname: string) {
  return pathname === "/v1/models" || pathname.startsWith("/v1/models/");
}

function isOpenAiPath(pathname: string) {
  return pathname === "/v1/chat/completions" || pathname === "/v1/responses";
}

function isAnthropicPath(pathname: string) {
  return pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens";
}

export function buildApp(deps: AppDeps) {
  const app = Fastify();
  const requestLogStore =
    deps.requestLogStore ??
    (deps.requestLogDir
      ? new LocalRequestLogStore({
          scope: "helper",
          dir: deps.requestLogDir,
        })
      : null);
  const sessionBindingStore =
    deps.sessionBindingStore ??
    (deps.sessionBindingDir
      ? new LocalSessionBindingStore({
          scope: "helper",
          dir: deps.sessionBindingDir,
        })
      : null);
  registerRequestLogging(app, {
    scope: "helper",
    logger: deps.requestLogger,
    store: requestLogStore ?? undefined,
  });
  const state = new HelperState();
  const runtime = new HelperRuntime(
    deps.browserClient,
    state,
    sessionBindingStore ?? undefined,
  );
  const ctx: AppContext = {
    browserClient: deps.browserClient,
    state,
    runtime,
  };
  const unauthenticatedPaths = new Set(["/v1/debug/provider-last"]);

  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0] ?? request.url;
    if (unauthenticatedPaths.has(pathname)) {
      return;
    }

    if (deps.token) {
      const headers = request.headers as Record<string, unknown>;

      if (isPublicModelsPath(pathname)) {
        if (
          !isBearerAuthorized(headers, deps.token) &&
          !isAnthropicAuthorized(headers, deps.token)
        ) {
          if ("x-api-key" in headers) {
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

      if (isOpenAiPath(pathname) && !isBearerAuthorized(headers, deps.token)) {
        return reply.code(401).send({
          error: {
            code: "unauthorized",
            message: "Unauthorized",
          },
        });
      }

      if (isAnthropicPath(pathname) && !isAnthropicAuthorized(headers, deps.token)) {
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
        !isOpenAiPath(pathname) &&
        !isAnthropicPath(pathname) &&
        !isBearerAuthorized(headers, deps.token)
      ) {
        return reply.code(401).send({ error: "UNAUTHORIZED" });
      }
    }
  });

  app.addHook("onReady", async () => {
    if (!sessionBindingStore) {
      return;
    }

    const persistedSessions = await sessionBindingStore.load();
    state.hydrateSessionBindings(persistedSessions);
  });

  registerHealthRoute(app, ctx);
  registerBindRoute(app, ctx);
  registerResetRoute(app, ctx);
  registerChatRoute(app, ctx);
  registerProviderChatRoute(app, ctx);
  registerInternalPiProviderChatRoute(app, ctx);
  registerInternalPiSessionShutdownRoute(app, ctx);
  registerDebugProviderLastRoute(app, ctx);
  registerDebugSessionBindingsRoute(app, ctx);
  if (requestLogStore) {
    registerRequestLogRoutes(app, {
      scope: "helper",
      store: requestLogStore,
    });
  }
  registerGatewayModelsRoutes(app);
  const runProviderRequest = async (input: {
    sessionId: string;
    request: Parameters<typeof toProviderChatRequest>[0];
  }) =>
    ctx.runtime.executeProviderChat({
      sessionId: input.sessionId,
      body: toProviderChatRequest(input.request),
    });
  const executionClient = {
    run: async (
      request: Parameters<typeof toProviderChatRequest>[0],
      options?: { sessionId?: string },
    ) => {
      if (!options?.sessionId) {
        throw new HelperError(
          "AUTOMATION_DESYNC",
          "Missing session id for OpenAI-compatible request",
        );
      }

      return runProviderRequest({ request, sessionId: options.sessionId });
    },
  };
  const anthropicExecutionClient: AnthropicExecutionClient = {
    run: async (request, options) => {
      try {
        if (isSessionTitleRequest(request.messages)) {
          return buildSessionTitleResponse(request.messages);
        }

        if (!options?.sessionId) {
          throw new HelperError(
            "AUTOMATION_DESYNC",
            "Missing session id for Anthropic-compatible request",
          );
        }

        return await ctx.runtime.executeProviderChat({
          sessionId: options.sessionId,
          body: toAnthropicProviderChatRequest(request),
        });
      } catch (error) {
        if (error instanceof HelperError) {
          throw mapAnthropicHelperError({
            error: error.code,
            message: error.message,
          });
        }

        throw error;
      }
    },
  };
  registerChatCompletionsRoute(app, executionClient);
  registerResponsesRoute(app, executionClient);
  registerMessagesRoute(app, anthropicExecutionClient);
  registerCountTokensRoute(app);

  return app;
}
