import type { FastifyInstance } from "fastify";
import { HelperError } from "../errors";
import type { AppContext } from "../app";

const SESSION_HEADER = "x-web-providers-session-id";

export function registerChatRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/chat", async (request, reply) => {
    const body = request.body as {
      prompt?: string;
      timeoutMs?: number;
    };
    const sessionId = (request.headers[SESSION_HEADER] as string | undefined)?.trim();

    if (!sessionId) {
      return reply.code(400).send({
        error: "AUTOMATION_DESYNC",
        message: "Missing x-web-providers-session-id header",
      });
    }

    const session = ctx.state.getSessionBoundSession(sessionId, "deepseek-web", null);
    if (!session || session.loginState !== "logged_in") {
      return reply.code(409).send({
        error: "NOT_BOUND",
        message:
          session?.pageState.blockingMessage ?? "Bind a DeepSeek tab before chatting",
      });
    }

    if (!body.prompt) {
      return reply.code(400).send({
        error: "AUTOMATION_DESYNC",
        message: "Prompt is required",
      });
    }

    if (ctx.state.hasRunningRequest(session.tabId)) {
      return reply.code(409).send({
        error: "MODEL_BUSY",
        message: "Another request is already in progress",
      });
    }

    const now = new Date().toISOString();

    ctx.state.setActiveRequest(session.tabId, {
      requestId: `req-${Date.now()}`,
      prompt: body.prompt,
      accumulatedReply: "",
      startedAt: now,
      lastEventAt: now,
      status: "running",
      finalErrorCode: null,
    });

    try {
      const result = await ctx.browserClient.sendChatPrompt({
        tabId: session.tabId,
        prompt: body.prompt,
        timeoutMs: body.timeoutMs ?? 60_000,
      });
      const replyText =
        result.mode === "text"
          ? result.outputText
          : (result.outputText ?? "");

      ctx.state.setActiveRequest(session.tabId, null);

      return {
        reply: replyText,
        conversationId: session.conversationId,
        modelLabel: result.modelLabel,
        rawStatus: "completed",
      };
    } catch (error) {
      const helperError =
        error instanceof HelperError
          ? error
          : new HelperError("AUTOMATION_DESYNC", "Unexpected automation failure");

      ctx.state.setActiveRequest(session.tabId, null);

      return reply.code(409).send({
        error: helperError.code,
        message: helperError.message,
      });
    }
  });
}
