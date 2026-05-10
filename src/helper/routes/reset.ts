import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import type { ResetRequest } from "../../shared/contracts";
import { DEFAULT_SESSION_ID } from "../runtime";

export function registerResetRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/reset", async (request) => {
    const body = ((request.body ?? {}) as Partial<ResetRequest>);
    const provider = body.provider as ResetRequest["provider"] | undefined;
    await ctx.runtime.resetSession({ sessionId: DEFAULT_SESSION_ID, provider });

    return provider ? { ok: true, provider } : { ok: true };
  });
}
