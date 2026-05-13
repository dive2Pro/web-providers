import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import type { ProviderId } from "../../shared/contracts";

const SESSION_HEADER = "x-web-providers-session-id";

export function registerDebugProviderLastRoute(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/debug/provider-last", async (request) => {
    const sessionId = (request.headers[SESSION_HEADER] as string | undefined)?.trim();
    if (!sessionId) {
      return null;
    }

    const { provider } = (request.query ?? {}) as { provider?: ProviderId };
    if (provider) {
      return ctx.state.getLastProviderRequest(sessionId, provider);
    }

    const allRecords = ctx.state.getAllLastProviderRequests(sessionId);
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
