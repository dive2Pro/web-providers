import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { HelperError } from "../errors";
import type { BindRequest, ProviderId } from "../../shared/contracts";

export function registerBindRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/bind", async (request, reply) => {
    const body = ((request.body ?? {}) as Partial<BindRequest>);
    const provider = body.provider ?? "deepseek-web";

    try {
      const result =
        ctx.browserClient.bindProviderTab
          ? await ctx.browserClient.bindProviderTab({ provider })
          : await ctx.browserClient.bindDeepSeekTab();

      if (result.loginState === "logged_out") {
        return reply.code(409).send({
          error: "NOT_BOUND",
          message:
            provider === "qwen-web"
              ? "Open Qwen in the browser tab, sign in on that page, then retry."
              : result.pageState.blockingMessage ?? `Log in to ${provider} in the browser tab and retry.`,
        });
      }

      const previousSession = ctx.state.getBoundSession(provider);
      const sameTab = previousSession?.tabId === result.tabId;
      const nextConversationId =
        provider === "deepseek-web"
          ? `conv-${result.tabId}`
          : `conv-${provider}-${result.tabId}`;

      ctx.state.setBoundSession(provider as ProviderId, {
        provider: provider as ProviderId,
        ...result,
        conversationId: sameTab
          ? previousSession?.conversationId ?? nextConversationId
          : nextConversationId,
        providerInitialized: sameTab
          ? (previousSession?.providerInitialized ?? false)
          : false,
        providerInitFingerprint: sameTab
          ? (previousSession?.providerInitFingerprint ?? null)
          : null,
        providerSessionKey: sameTab
          ? (previousSession?.providerSessionKey ?? null)
          : null,
      });

      return {
        provider,
        ...result,
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
