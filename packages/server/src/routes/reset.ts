import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import type { ResetRequest } from "@web-providers/shared";

export function registerResetRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/reset", async (request) => {
    const body = ((request.body ?? {}) as Partial<ResetRequest>);
    const provider = body.provider;
    const session = ctx.state.getBoundSession(provider);

    if (session) {
      if (ctx.browserClient.resetProvider) {
        await ctx.browserClient.resetProvider({ provider: session.provider, tabId: session.tabId });
      } else {
        await ctx.browserClient.resetPageBridge(session.tabId);
      }
      ctx.state.setBoundSession(session.provider, null);
      ctx.state.setLastProviderRequest(session.provider, null);
    }

    if (!provider) {
      ctx.state.resetRuntime();
    }

    return provider ? { ok: true, provider } : { ok: true };
  });
}
