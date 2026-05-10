import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { HelperError } from "../errors";
import type { BindRequest, ProviderId } from "../../shared/contracts";
import { DEFAULT_SESSION_ID } from "../runtime";

export function registerBindRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/bind", async (request, reply) => {
    const body = ((request.body ?? {}) as Partial<BindRequest>);
    const provider = body.provider ?? "deepseek-web";

    try {
      const result = await ctx.runtime.bindProvider({
        sessionId: DEFAULT_SESSION_ID,
        provider: provider as ProviderId,
      });

      return {
        provider,
        tabId: result.tabId,
        url: result.url,
        loginState: result.loginState,
        bridgeInjected: result.bridgeInjected,
        pageState: result.pageState,
      };
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
