import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import type { ProviderId } from "../../shared/contracts";

export function registerDebugProviderLastRoute(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/debug/provider-last", async (request) => {
    const { provider } = (request.query ?? {}) as { provider?: ProviderId };
    if (provider) {
      return ctx.state.getLastProviderRequest(provider);
    }

    const allRecords = ctx.state.getAllLastProviderRequests();
    const entries = Object.entries(allRecords);

    if (entries.length === 0) {
      return null;
    }

    if (entries.length === 1) {
      return entries[0]?.[1] ?? null;
    }

    return allRecords;
  });
}
