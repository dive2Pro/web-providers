import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { HelperError } from "../errors";

export function registerBindRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/bind", async (_request, reply) => {
    try {
      const result = await ctx.browserClient.bindDeepSeekTab();
      const previousSession = ctx.state.getBoundSession();
      const sameTab = previousSession?.tabId === result.tabId;

      ctx.state.setBoundSession({
        ...result,
        conversationId: sameTab
          ? previousSession.conversationId
          : `conv-${result.tabId}`,
        providerInitialized: sameTab
          ? previousSession.providerInitialized
          : false,
        providerInitFingerprint: sameTab
          ? previousSession.providerInitFingerprint
          : null,
      });

      return result;
    } catch (error) {
      if (error instanceof HelperError) {
        return reply.code(409).send({
          error: error.code,
          message: error.message,
        });
      }

      throw error;
    }
  });
}
