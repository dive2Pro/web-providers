import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";

export function registerDebugProviderLastRoute(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/debug/provider-last", async () => {
    return ctx.state.getLastProviderRequest();
  });
}
