import Fastify from "fastify";
import { createHelperClient } from "./helper-client";
import { registerMessagesRoute } from "./routes/messages";
import { registerCountTokensRoute } from "./routes/count-tokens";
import { registerAnthropicModelsRoute } from "./routes/models";
import { authenticationError } from "./errors";
import type { ExecutionResult, NormalizedRequest } from "./types";

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
}) {
  const app = Fastify();
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
  registerMessagesRoute(app, executionClient);
  registerCountTokensRoute(app);

  return app;
}
