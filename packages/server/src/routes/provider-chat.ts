import type { FastifyInstance } from "fastify";
import type {
  ProviderId,
  ProviderChatRequest,
  ProviderChatResponse,
} from "@web-providers/shared";
import type { AppContext } from "../app";
import { HelperError } from "../errors";
import type { BoundSession, ProviderRequestDebugRecord } from "../types";

const DEBUG_PROVIDER_REQUESTS = process.env.PI_DEEPSEEK_DEBUG === "1";

function logProviderDebug(message: string, payload: Record<string, unknown>) {
  if (!DEBUG_PROVIDER_REQUESTS) {
    return;
  }

  console.error(
    `[web-providers/helper] ${message} ${JSON.stringify(
      {
        at: new Date().toISOString(),
        ...payload,
      },
      null,
      2,
    )}`,
  );
}

function buildProviderPrompt(input: {
  messages: ProviderChatRequest["messages"];
  sessionInit?: ProviderChatRequest["sessionInit"];
  providerInitialized: boolean;
  providerInitFingerprint: string | null;
  providerSessionKey: string | null;
}) {
  const currentUser = [...input.messages]
    .reverse()
    .find((message) => message.role === "user");

  const userPrompt = currentUser?.content ?? "";
  const nextFingerprint = input.sessionInit?.fingerprint ?? null;
  const nextSessionKey = input.sessionInit?.sessionKey ?? null;
  const freshReasons: string[] = [];

  if (nextFingerprint !== null && nextSessionKey !== null) {
    if (!input.providerInitialized) {
      freshReasons.push("provider_not_initialized");
    }

    if (input.providerInitFingerprint !== nextFingerprint) {
      freshReasons.push("fingerprint_changed");
    }

    if (input.providerSessionKey !== nextSessionKey) {
      freshReasons.push("session_key_changed");
    }
  }

  const shouldStartFresh =
    nextFingerprint !== null &&
    nextSessionKey !== null &&
    freshReasons.length > 0;

  if (!shouldStartFresh) {
    return {
      prompt: userPrompt,
      shouldStartFresh: false,
      freshReasons,
      nextFingerprint: input.providerInitFingerprint,
      nextSessionKey: input.providerSessionKey,
    };
  }

  const initPrompt = input.sessionInit?.prompt.trim() ?? "";

  return {
    prompt: [initPrompt, userPrompt].filter((part) => part.length > 0).join("\n\n"),
    shouldStartFresh: true,
    freshReasons,
    nextFingerprint,
    nextSessionKey,
  };
}

function createBaseDebugRecord(
  session: BoundSession,
  body: ProviderChatRequest,
  prompt: string,
) {
  const startedAt = new Date().toISOString();
  const requestId = `req-${Date.now()}`;
  const normalizedMessages = body.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const rawRequest: ProviderChatRequest = {
    provider: body.provider,
    model: body.model,
    messages: normalizedMessages,
    ...(body.sessionInit
      ? {
          sessionInit: {
            fingerprint: body.sessionInit.fingerprint,
            sessionKey: body.sessionInit.sessionKey,
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

  return {
    record: {
      provider: body.provider,
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
    } satisfies ProviderRequestDebugRecord,
    startedAt,
    requestId,
  };
}

function toProviderResponse(result: {
  mode: "text" | "native_tool_call" | "json_fallback";
  thinkingText?: string;
  outputText?: string;
  modelLabel?: string;
  toolCall?: {
    name: string;
    argumentsJson: string;
  };
}): ProviderChatResponse {
  if (result.mode === "text") {
    return {
      mode: "text",
      ...(typeof result.thinkingText === "string"
        ? { thinkingText: result.thinkingText }
        : {}),
      outputText: result.outputText ?? "",
      finishReason: "stop",
      modelLabel: result.modelLabel,
    };
  }

  return {
    mode: result.mode,
    toolCall: result.toolCall as { name: string; argumentsJson: string },
    finishReason: "stop",
    modelLabel: result.modelLabel,
    ...(typeof result.thinkingText === "string"
      ? { thinkingText: result.thinkingText }
      : {}),
    ...(typeof result.outputText === "string"
      ? { outputText: result.outputText }
      : {}),
  };
}

export function registerProviderChatRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/provider/chat", async (request, reply) => {
    const body = request.body as ProviderChatRequest;
    const provider = (body.provider ?? "deepseek-web") as ProviderId;
    const session = ctx.state.getBoundSession(provider);

    if (!session) {
      return reply.code(409).send({
        error: "NOT_BOUND",
        message: `Bind a ${provider} tab before provider chat`,
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
      providerSessionKey: session.providerSessionKey,
    });
    logProviderDebug("fresh session decision", {
      provider,
      tabId: session.tabId,
      sessionInitialized: session.providerInitialized,
      storedFingerprint: session.providerInitFingerprint,
      incomingFingerprint: body.sessionInit?.fingerprint ?? null,
      storedSessionKey: session.providerSessionKey,
      incomingSessionKey: body.sessionInit?.sessionKey ?? null,
      freshReasons: promptInput.freshReasons,
      shouldStartFresh: promptInput.shouldStartFresh,
      hasSessionInit: Boolean(body.sessionInit),
      messageCount: body.messages.length,
    });
    const prompt = promptInput.prompt;
    const debugSeed = createBaseDebugRecord(session, { ...body, provider }, prompt);
    const baseDebugRecord = debugSeed.record as ProviderRequestDebugRecord;
    baseDebugRecord.freshDecision = {
      shouldStartFresh: promptInput.shouldStartFresh,
      sessionInitialized: session.providerInitialized,
      storedFingerprint: session.providerInitFingerprint,
      incomingFingerprint: body.sessionInit?.fingerprint ?? null,
      storedSessionKey: session.providerSessionKey,
      incomingSessionKey: body.sessionInit?.sessionKey ?? null,
      freshReasons: promptInput.freshReasons,
    };
    ctx.state.setLastProviderRequest(provider, baseDebugRecord);
    ctx.state.setActiveRequest({
      requestId: debugSeed.requestId,
      prompt,
      accumulatedReply: "",
      startedAt: debugSeed.startedAt,
      lastEventAt: debugSeed.startedAt,
      status: "running",
      finalErrorCode: null,
    });

    try {
      let activeTabId = session.tabId;

      if (promptInput.shouldStartFresh) {
        const res = await ctx.browserClient.startNewChat(
          ctx.browserClient.bindProviderTab
            ? { provider, tabId: session.tabId }
            : session.tabId,
        );
        if (res?.tabId) activeTabId = res.tabId;
      }

      const result = await ctx.browserClient.sendChatPrompt({
        provider,
        tabId: activeTabId,
        prompt,
        timeoutMs: 30_000,
        freshSession: promptInput.shouldStartFresh,
      });

      ctx.state.setActiveRequest(null);

      const response = toProviderResponse(result);
      ctx.state.setLastProviderRequest(provider, {
        ...baseDebugRecord,
        completedAt: new Date().toISOString(),
        status: "completed",
        response,
        automation: result.debug ?? null,
      });
      if (promptInput.shouldStartFresh || body.sessionInit?.fingerprint) {
        const nextConversationId =
          provider === "deepseek-web"
            ? `conv-${activeTabId}`
            : `conv-${provider}-${activeTabId}-${Date.now()}`;
        ctx.state.setBoundSession(provider, {
          ...session,
          tabId: activeTabId,
          conversationId: promptInput.shouldStartFresh
            ? nextConversationId
            : session.conversationId,
          providerInitialized: true,
          providerInitFingerprint:
            body.sessionInit?.fingerprint ?? session.providerInitFingerprint,
          providerSessionKey:
            body.sessionInit?.sessionKey ?? session.providerSessionKey,
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
      ctx.state.setLastProviderRequest(provider, {
        ...baseDebugRecord,
        completedAt: new Date().toISOString(),
        status: "failed",
        automation: helperError.automationDebug,
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
