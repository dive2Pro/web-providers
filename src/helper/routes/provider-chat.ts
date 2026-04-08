import type { FastifyInstance } from "fastify";
import type {
  ProviderChatRequest,
  ProviderChatResponse,
} from "../../shared/contracts";
import type { AppContext } from "../app";
import { HelperError } from "../errors";
import type { ProviderRequestDebugRecord } from "../types";

function buildProviderPrompt(messages: ProviderChatRequest["messages"]) {
  const currentUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  return currentUser?.content ?? "";
}

export function registerProviderChatRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/provider/chat", async (request, reply) => {
    const body = request.body as ProviderChatRequest;
    const session = ctx.state.getBoundSession();

    if (!session) {
      return reply.code(409).send({
        error: "NOT_BOUND",
        message: "Bind a DeepSeek tab before provider chat",
      });
    }

    if (ctx.state.hasRunningRequest()) {
      return reply.code(409).send({
        error: "MODEL_BUSY",
        message: "Another request is already in progress",
      });
    }

    const prompt = buildProviderPrompt(body.messages);
    const startedAt = new Date().toISOString();
    const requestId = `req-${Date.now()}`;
    const normalizedMessages = body.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const rawRequest: ProviderChatRequest = {
      model: body.model,
      messages: normalizedMessages,
      ...(typeof body.temperature === "number"
        ? { temperature: body.temperature }
        : {}),
      ...(typeof body.maxOutputTokens === "number"
        ? { maxOutputTokens: body.maxOutputTokens }
        : {}),
      ...(typeof body.abortKey === "string"
        ? { abortKey: body.abortKey }
        : {}),
    };
    const baseDebugRecord: ProviderRequestDebugRecord = {
      requestId,
      rawRequest,
      normalizedMessages,
      prompt,
      session: {
        tabId: session.tabId,
        url: session.url,
      },
      startedAt,
      completedAt: null,
      status: "running",
      response: null,
      error: null,
    };
    ctx.state.setLastProviderRequest(baseDebugRecord);

    ctx.state.setActiveRequest({
      requestId,
      prompt,
      accumulatedReply: "",
      startedAt,
      lastEventAt: startedAt,
      status: "running",
      finalErrorCode: null,
    });

    try {
      const result = await ctx.browserClient.sendChatPrompt({
        tabId: session.tabId,
        prompt,
        timeoutMs: 30_000,
      });

      ctx.state.setActiveRequest(null);

      const response: ProviderChatResponse = {
        outputText: result.reply,
        finishReason: "stop",
        modelLabel: result.modelLabel,
      };
      ctx.state.setLastProviderRequest({
        ...baseDebugRecord,
        completedAt: new Date().toISOString(),
        status: "completed",
        response,
      });

      return response;
    } catch (error) {
      const rootCauseMessage =
        error instanceof Error
          ? error.message
          : String(error);
      const helperError =
        error instanceof HelperError
          ? error
          : new HelperError(
              "AUTOMATION_DESYNC",
              `Unexpected automation failure: ${rootCauseMessage}`,
            );
      ctx.state.setLastProviderRequest({
        ...baseDebugRecord,
        completedAt: new Date().toISOString(),
        status: "failed",
        error: {
          code: helperError.code,
          message: helperError.message,
        },
      });

      ctx.state.setActiveRequest(null);

      return reply.code(409).send({
        error: helperError.code,
        message: helperError.message,
      });
    }
  });
}
