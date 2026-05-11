import Fastify from "fastify";
import type { BrowserAutomationClient } from "./browser/types";
import { toProviderChatRequest } from "../openai-adapter/helper-client";
import { registerChatCompletionsRoute } from "../openai-adapter/routes/chat-completions";
import { registerModelsRoute } from "../openai-adapter/routes/models";
import { registerResponsesRoute } from "../openai-adapter/routes/responses";
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

export interface AppDeps {
  token?: string;
  browserClient: BrowserAutomationClient;
  requestLogger?: RequestLogger;
  requestLogDir?: string;
  requestLogStore?: RequestLogStore;
}

export interface AppContext {
  browserClient: BrowserAutomationClient;
  state: HelperState;
  runtime: HelperRuntime;
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
  registerRequestLogging(app, {
    scope: "helper",
    logger: deps.requestLogger,
    store: requestLogStore ?? undefined,
  });
  const state = new HelperState();
  const runtime = new HelperRuntime(deps.browserClient, state);
  const ctx: AppContext = {
    browserClient: deps.browserClient,
    state,
    runtime,
  };
  const unauthenticatedPaths = new Set(["/v1/debug/provider-last"]);
  const openAiPublicPaths = new Set([
    "/v1/models",
    "/v1/chat/completions",
    "/v1/responses",
  ]);

  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0] ?? request.url;
    if (unauthenticatedPaths.has(pathname)) {
      return;
    }

    if (deps.token && request.headers.authorization !== `Bearer ${deps.token}`) {
      if (openAiPublicPaths.has(pathname)) {
        return reply.code(401).send({
          error: {
            code: "unauthorized",
            message: "Unauthorized",
          },
        });
      }
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
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
  registerModelsRoute(app);
  const executionClient = {
    run: async (
      request: Parameters<typeof toProviderChatRequest>[0],
      options?: { sessionId?: string },
    ) =>
      ctx.runtime.executeProviderChat({
        sessionId: options?.sessionId,
        body: toProviderChatRequest(request),
      }),
  };
  registerChatCompletionsRoute(app, executionClient);
  registerResponsesRoute(app, executionClient);

  return app;
}
