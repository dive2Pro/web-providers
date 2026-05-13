import Fastify from "fastify";
import { createHelperClient } from "./helper-client";
import { registerChatCompletionsRoute } from "./routes/chat-completions";
import { registerModelsRoute } from "./routes/models";
import { registerResponsesRoute } from "./routes/responses";
import type { ExecutionResult, NormalizedRequest } from "./types";
import {
  registerRequestLogging,
  type RequestLogger,
} from "../shared/request-logging";
import {
  LocalRequestLogStore,
  type RequestLogStore,
} from "../shared/request-log-store";
import { registerRequestLogRoutes } from "../shared/request-log-routes";

export type ExecutionClient = {
  run(
    request: NormalizedRequest,
    options?: { sessionId?: string; signal?: AbortSignal },
  ): Promise<ExecutionResult>;
};

export function buildOpenAiAdapterApp(input: {
  token?: string;
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
          scope: "openai-adapter",
          dir: input.requestLogDir,
        })
      : null);
  registerRequestLogging(app, {
    scope: "openai-adapter",
    logger: input.requestLogger,
    store: requestLogStore ?? undefined,
  });
  const executionClient: ExecutionClient = createHelperClient({
    helperBaseUrl: input.helperBaseUrl,
    helperToken: input.helperToken,
    fetchImpl: input.fetchImpl,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (input.token && request.headers.authorization !== `Bearer ${input.token}`) {
      return reply.code(401).send({
        error: {
          code: "unauthorized",
          message: "Unauthorized",
        },
      });
    }
  });

  registerModelsRoute(app);
  if (requestLogStore) {
    registerRequestLogRoutes(app, {
      scope: "openai-adapter",
      store: requestLogStore,
    });
  }
  registerChatCompletionsRoute(app, executionClient);
  registerResponsesRoute(app, executionClient);

  return app;
}
