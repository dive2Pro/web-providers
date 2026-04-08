import type { FastifyInstance } from "fastify";
import type {
  ProviderChatRequest,
  ProviderChatResponse,
} from "../../shared/contracts";
import type { AppContext } from "../app";
import { HelperError } from "../errors";
import type { ProviderRequestDebugRecord } from "../types";

function buildProviderPrompt(input: {
  messages: ProviderChatRequest["messages"];
  sessionInit?: ProviderChatRequest["sessionInit"];
  providerInitialized: boolean;
  providerInitFingerprint: string | null;
}) {
  const currentUser = [...input.messages]
    .reverse()
    .find((message) => message.role === "user");

  const userPrompt = currentUser?.content ?? "";
  const nextFingerprint = input.sessionInit?.fingerprint ?? null;
  const shouldStartFresh =
    nextFingerprint !== null &&
    (!input.providerInitialized || input.providerInitFingerprint !== nextFingerprint);

  if (!shouldStartFresh) {
    return {
      prompt: userPrompt,
      shouldStartFresh: false,
      nextFingerprint: input.providerInitFingerprint,
    };
  }

  const initPrompt = input.sessionInit?.prompt.trim() ?? "";

  return {
    prompt: [initPrompt, userPrompt].filter((part) => part.length > 0).join("\n\n"),
    shouldStartFresh: true,
    nextFingerprint,
  };
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

    const promptInput = buildProviderPrompt({
      messages: body.messages,
      sessionInit: body.sessionInit,
      providerInitialized: session.providerInitialized,
      providerInitFingerprint: session.providerInitFingerprint,
    });
    const prompt = promptInput.prompt;
    const startedAt = new Date().toISOString();
    const requestId = `req-${Date.now()}`;
    const normalizedMessages = body.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const rawRequest: ProviderChatRequest = {
      model: body.model,
      messages: normalizedMessages,
      ...(body.sessionInit
        ? {
            sessionInit: {
              fingerprint: body.sessionInit.fingerprint,
              prompt: body.sessionInit.prompt,
            },
          }
        : {}),
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
      automation: null,
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
      if (promptInput.shouldStartFresh) {
        await ctx.browserClient.startNewChat(session.tabId);
      }

      const result = await ctx.browserClient.sendChatPrompt({
        tabId: session.tabId,
        prompt,
        timeoutMs: 30_000,
        freshSession: promptInput.shouldStartFresh,
      });

      ctx.state.setActiveRequest(null);

      const response: ProviderChatResponse =
        result.mode === "text"
          ? {
              mode: "text",
              outputText: result.outputText,
              finishReason: "stop",
              modelLabel: result.modelLabel,
            }
          : {
              mode: result.mode,
              toolCall: result.toolCall,
              finishReason: "stop",
              modelLabel: result.modelLabel,
              ...(typeof result.outputText === "string"
                ? { outputText: result.outputText }
                : {}),
            };
      ctx.state.setLastProviderRequest({
        ...baseDebugRecord,
        completedAt: new Date().toISOString(),
        status: "completed",
        response,
        automation: result.debug ?? null,
      });
      if (promptInput.shouldStartFresh || body.sessionInit?.fingerprint) {
        ctx.state.setBoundSession({
          ...session,
          conversationId: promptInput.shouldStartFresh
            ? `conv-${session.tabId}-${Date.now()}`
            : session.conversationId,
          providerInitialized: true,
          providerInitFingerprint:
            body.sessionInit?.fingerprint ?? session.providerInitFingerprint,
        });
      }

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
        automation: null,
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
