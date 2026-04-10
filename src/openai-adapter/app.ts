import Fastify from "fastify";
import { createHelperClient } from "./helper-client";
import { registerChatCompletionsRoute } from "./routes/chat-completions";
import { registerModelsRoute } from "./routes/models";
import { registerResponsesRoute } from "./routes/responses";

export type HelperClient = ReturnType<typeof createHelperClient>;

export function buildOpenAiAdapterApp(input: {
  token?: string;
  helperBaseUrl: string;
  helperToken?: string;
  fetchImpl?: typeof fetch;
}) {
  const app = Fastify();
  const helperClient = createHelperClient({
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
  registerChatCompletionsRoute(app, helperClient);
  registerResponsesRoute(app, helperClient);

  return app;
}
