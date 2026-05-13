import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import type { ResetRequest } from "../../shared/contracts";

const SESSION_HEADER = "x-web-providers-session-id";

export function registerResetRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/reset", async (request, reply) => {
    const body = ((request.body ?? {}) as Partial<ResetRequest>);
    const provider = body.provider as ResetRequest["provider"] | undefined;
    const sessionId = (request.headers[SESSION_HEADER] as string | undefined)?.trim();

    if (!sessionId) {
      return reply.code(400).send({
        error: "AUTOMATION_DESYNC",
        message: "Missing x-web-providers-session-id header",
      });
    }

    await ctx.runtime.resetSession({ sessionId, provider });

    return provider ? { ok: true, provider } : { ok: true };
  });
}
