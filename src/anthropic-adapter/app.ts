import Fastify from "fastify";
import { createHelperClient } from "./helper-client";
import { registerMessagesRoute } from "./routes/messages";
import { registerCountTokensRoute } from "./routes/count-tokens";
import { registerAnthropicModelsRoute } from "./routes/models";
import { authenticationError } from "./errors";
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

function isAuthorized(headers: Record<string, unknown>, token: string) {
  return (
    headers.authorization === `Bearer ${token}` || headers["x-api-key"] === token
  );
}

export function buildAnthropicAdapterApp(input: {
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
          scope: "anthropic-adapter",
          dir: input.requestLogDir,
        })
      : null);
  registerRequestLogging(app, {
    scope: "anthropic-adapter",
    logger: input.requestLogger,
    store: requestLogStore ?? undefined,
  });
  const executionClient: ExecutionClient = createHelperClient({
    helperBaseUrl: input.helperBaseUrl,
    helperToken: input.helperToken,
    fetchImpl: input.fetchImpl,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (input.token && !isAuthorized(request.headers as Record<string, unknown>, input.token)) {
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

  registerAnthropicModelsRoute(app);
  if (requestLogStore) {
    registerRequestLogRoutes(app, {
      scope: "anthropic-adapter",
      store: requestLogStore,
    });
  }
  registerMessagesRoute(app, executionClient);
  registerCountTokensRoute(app);

  return app;
}
