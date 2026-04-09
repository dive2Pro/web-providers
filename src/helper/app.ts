import Fastify from "fastify";
import type { BrowserAutomationClient } from "./browser/types";
import { registerBindRoute } from "./routes/bind";
import { registerChatRoute } from "./routes/chat";
import { registerDebugProviderLastRoute } from "./routes/debug-provider-last";
import { registerHealthRoute } from "./routes/health";
import { registerProviderChatRoute } from "./routes/provider-chat";
import { registerResetRoute } from "./routes/reset";
import { HelperState } from "./state";

export interface AppDeps {
  token: string;
  browserClient: BrowserAutomationClient;
}

export interface AppContext {
  browserClient: BrowserAutomationClient;
  state: HelperState;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify();
  const ctx: AppContext = {
    browserClient: deps.browserClient,
    state: new HelperState(),
  };
  const unauthenticatedPaths = new Set(["/v1/debug/provider-last"]);

  app.addHook("onRequest", async (request, reply) => {
    if (unauthenticatedPaths.has(request.url)) {
      return;
    }

    if (request.headers.authorization !== `Bearer ${deps.token}`) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  });

  registerHealthRoute(app, ctx);
  registerBindRoute(app, ctx);
  registerResetRoute(app, ctx);
  registerChatRoute(app, ctx);
  registerProviderChatRoute(app, ctx);
  registerDebugProviderLastRoute(app, ctx);

  return app;
}
