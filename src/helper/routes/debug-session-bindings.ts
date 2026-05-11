import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";

export function registerDebugSessionBindingsRoute(
  app: FastifyInstance,
  ctx: AppContext,
) {
  app.get("/v1/debug/session-bindings", async () => {
    return {
      sessions: ctx.state.getAllSessionBindingDebugRecords(),
    };
  });
}
