import Fastify from "fastify";
import { createHelperClient } from "./helper-client";
import { registerChatCompletionsRoute } from "./routes/chat-completions";
import { registerModelsRoute } from "./routes/models";
import { registerResponsesRoute } from "./routes/responses";
import type { ExecutionResult, NormalizedRequest } from "./types";

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
}) {
  const app = Fastify();
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
  registerChatCompletionsRoute(app, executionClient);
  registerResponsesRoute(app, executionClient);

  return app;
}
