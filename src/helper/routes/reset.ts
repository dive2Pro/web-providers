import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";

export function registerResetRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/reset", async () => {
    const session = ctx.state.getBoundSession();

    if (session) {
      await ctx.browserClient.resetPageBridge(session.tabId);
      ctx.state.setBoundSession(null);
    }

    ctx.state.resetRuntime();

    return { ok: true };
  });
}
