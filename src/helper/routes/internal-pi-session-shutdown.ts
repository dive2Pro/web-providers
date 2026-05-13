import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";

const SESSION_HEADER = "x-pi-session-id";

export function registerInternalPiSessionShutdownRoute(
  app: FastifyInstance,
  ctx: AppContext,
) {
  app.post("/internal/pi/session/shutdown", async (request, reply) => {
    const body = (request.body ?? {}) as { sessionId?: string };
    const sessionId =
      body.sessionId ??
      ((request.headers[SESSION_HEADER] as string | undefined) ?? "");

    if (!sessionId) {
      return reply.code(400).send({
        error: "AUTOMATION_DESYNC",
        message: "Missing sessionId",
      });
    }

    await ctx.runtime.shutdownSession(sessionId);
    return { ok: true, sessionId };
  });
}
