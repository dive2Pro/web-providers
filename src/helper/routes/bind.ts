import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { HelperError } from "../errors";
import type { BindRequest, ProviderId } from "../../shared/contracts";

const SESSION_HEADER = "x-web-providers-session-id";

export function registerBindRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/bind", async (request, reply) => {
    const body = ((request.body ?? {}) as Partial<BindRequest>);
    const provider = body.provider ?? "deepseek-web";
    const sessionId = (request.headers[SESSION_HEADER] as string | undefined)?.trim();

    if (!sessionId) {
      return reply.code(400).send({
        error: "AUTOMATION_DESYNC",
        message: "Missing x-web-providers-session-id header",
      });
    }

    try {
      const result = await ctx.runtime.bindProvider({
        sessionId,
        provider: provider as ProviderId,
      });

      return {
        provider,
        tabId: result.tabId,
        url: result.tabUrl,
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
