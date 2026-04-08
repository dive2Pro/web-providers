import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { HelperError } from "../errors";

export function registerBindRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/bind", async (_request, reply) => {
    try {
      const result = await ctx.browserClient.bindDeepSeekTab();

      ctx.state.setBoundSession({
        ...result,
        conversationId: `conv-${result.tabId}`,
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
