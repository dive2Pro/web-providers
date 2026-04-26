import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { HelperError } from "../errors";
import type { BindRequest, ProviderId } from "@web-providers/shared";

export function registerBindRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/bind", async (request, reply) => {
    const body = ((request.body ?? {}) as Partial<BindRequest>);
    const provider = body.provider ?? "deepseek-web";
    const previousSession = ctx.state.getBoundSession(provider);

    try {
      const result =
        ctx.browserClient.bindProviderTab
          ? await ctx.browserClient.bindProviderTab({
              provider,
              preferredTabId: previousSession?.tabId,
            })
          : await ctx.browserClient.bindDeepSeekTab({
              preferredTabId: previousSession?.tabId,
            });
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
