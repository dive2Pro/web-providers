import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";

export function registerHealthRoute(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/health", async () => ({
    ok: true,
    browser: await ctx.browserClient.getConnectionStatus(),
    bindState: ctx.state.hasAnyBoundSession() ? "bound" : "unbound",
    degraded: ctx.state.getDegraded(),
    lastBridgeHeartbeatAt: ctx.state.getLastBridgeHeartbeatAt(),
  }));
}
