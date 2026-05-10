import type { BrowserAutomationClient } from "./browser/types";
import { HelperError } from "./errors";
import { HelperState } from "./state";
import type { BoundSession, ProviderRequestDebugRecord } from "./types";
import type {
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderId,
} from "../shared/contracts";

export const DEFAULT_SESSION_ID = "__default__";
export const OPENAI_PUBLIC_SESSION_ID = "__openai_public__";

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
  const shouldStartFresh =
    nextFingerprint !== null &&
    nextSessionKey !== null &&
    (!input.providerInitialized ||
      input.providerInitFingerprint !== nextFingerprint ||
      input.providerSessionKey !== nextSessionKey);

  if (!shouldStartFresh) {
    return {
      prompt: userPrompt,
      shouldStartFresh: false,
      nextFingerprint: input.providerInitFingerprint,
      nextSessionKey: input.providerSessionKey,
    };
  }

  const initPrompt = input.sessionInit?.prompt.trim() ?? "";

  return {
    prompt: [initPrompt, userPrompt].filter((part) => part.length > 0).join("\n\n"),
    shouldStartFresh: true,
    nextFingerprint,
    nextSessionKey,
  };
}

function createBaseDebugRecord(
  sessionId: string,
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
      sessionId,
      provider: body.provider,
      requestId,
      rawRequest,
      normalizedMessages,
      prompt,
      session: {
        tabId: session.tabId,
        url: session.tabUrl,
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

function createConversationId(provider: ProviderId, tabId: string) {
  return provider === "deepseek-web"
    ? `conv-${tabId}`
    : `conv-${provider}-${tabId}`;
}

function isSameTab(previousSession: BoundSession | null, nextTabId: string) {
  return previousSession?.tabId === nextTabId;
}

function isSameSessionUrl(previousSession: BoundSession | null, nextTabUrl: string) {
  return previousSession?.tabUrl === nextTabUrl;
}

export class HelperRuntime {
  constructor(
    private readonly browserClient: BrowserAutomationClient,
    private readonly state: HelperState,
  ) {}

  private storeBoundSession(input: {
    sessionId: string;
    provider: ProviderId;
    result: Awaited<ReturnType<NonNullable<BrowserAutomationClient["bindProviderTab"]>>>;
  }) {
    const previousSession = this.state.getSessionBoundSession(
      input.sessionId,
      input.provider,
    );
    const sameTab = isSameTab(previousSession, input.result.tabId);
    const sameSessionUrl = isSameSessionUrl(previousSession, input.result.url);
    const preserveSessionState = sameTab || sameSessionUrl;
    const nextConversationId = createConversationId(input.provider, input.result.tabId);

    const nextSession: BoundSession = {
      provider: input.provider,
      tabId: input.result.tabId,
      tabUrl: input.result.url,
      loginState: input.result.loginState,
      bridgeInjected: input.result.bridgeInjected,
      pageState: input.result.pageState,
      conversationId: preserveSessionState
        ? previousSession?.conversationId ?? nextConversationId
        : nextConversationId,
      providerInitialized: preserveSessionState
        ? (previousSession?.providerInitialized ?? false)
        : false,
      providerInitFingerprint: preserveSessionState
        ? (previousSession?.providerInitFingerprint ?? null)
        : null,
      providerSessionKey: preserveSessionState
        ? (previousSession?.providerSessionKey ?? null)
        : null,
    };

    this.state.setSessionBoundSession(input.sessionId, nextSession);
    return nextSession;
  }

  async bindProvider(input: {
    sessionId?: string;
    provider: ProviderId;
    openNew?: boolean;
    tabId?: string;
    openUrl?: string;
  }) {
    const sessionId = input.sessionId ?? DEFAULT_SESSION_ID;
    this.state.touchSession(sessionId);
    const result =
      this.browserClient.bindProviderTab
        ? await this.browserClient.bindProviderTab({
            provider: input.provider,
            openNew: input.openNew,
            tabId: input.tabId,
            openUrl: input.openUrl,
          })
        : await this.browserClient.bindDeepSeekTab();

    if (result.loginState === "logged_out") {
      throw new HelperError(
        "NOT_BOUND",
        input.provider === "qwen-web"
          ? "Open Qwen in the browser tab, sign in on that page, then retry."
          : result.pageState.blockingMessage ??
              `Log in to ${input.provider} in the browser tab and retry.`,
      );
    }

    return this.storeBoundSession({
      sessionId,
      provider: input.provider,
      result,
    });
  }

  async ensureBound(input: { sessionId: string; provider: ProviderId }) {
    this.state.touchSession(input.sessionId);
    const existing = this.state.getSessionBoundSession(input.sessionId, input.provider);

    if (!existing) {
      return this.bindProvider({
        sessionId: input.sessionId,
        provider: input.provider,
        openNew: true,
      });
    }

    try {
      return await this.bindProvider({
        sessionId: input.sessionId,
        provider: input.provider,
        tabId: existing.tabId,
      });
    } catch {
      return this.bindProvider({
        sessionId: input.sessionId,
        provider: input.provider,
        openNew: true,
        openUrl: existing.tabUrl,
      });
    }
  }

  async executeProviderChat(input: {
    sessionId?: string;
    body: ProviderChatRequest;
    signal?: AbortSignal;
  }) {
    const sessionId = input.sessionId ?? DEFAULT_SESSION_ID;
    const provider = (input.body.provider ?? "deepseek-web") as ProviderId;
    if (!this.state.tryAcquireBinding(sessionId, provider)) {
      throw new HelperError("MODEL_BUSY", "Another request is already in progress");
    }

    let activeTabId: string | null = null;
    let baseDebugRecord: ProviderRequestDebugRecord | null = null;

    try {
      const session = await this.ensureBound({ sessionId, provider });
      activeTabId = session.tabId;

      if (this.state.hasRunningRequest(session.tabId)) {
        throw new HelperError("MODEL_BUSY", "Another request is already in progress");
      }

      const promptInput = buildProviderPrompt({
        messages: input.body.messages,
        sessionInit: input.body.sessionInit,
        providerInitialized: session.providerInitialized,
        providerInitFingerprint: session.providerInitFingerprint,
        providerSessionKey: session.providerSessionKey,
      });
      const prompt = promptInput.prompt;
      const debugSeed = createBaseDebugRecord(
        sessionId,
        session,
        { ...input.body, provider },
        prompt,
      );
      baseDebugRecord = debugSeed.record;
      this.state.setLastProviderRequest(provider, baseDebugRecord);
      this.state.setActiveRequest(session.tabId, {
        requestId: debugSeed.requestId,
        prompt,
        accumulatedReply: "",
        startedAt: debugSeed.startedAt,
        lastEventAt: debugSeed.startedAt,
        status: "running",
        finalErrorCode: null,
      });

      if (promptInput.shouldStartFresh) {
        await this.browserClient.startNewChat(
          this.browserClient.bindProviderTab
            ? { provider, tabId: session.tabId }
            : session.tabId,
        );
      }

      const result = await this.browserClient.sendChatPrompt({
        provider,
        tabId: session.tabId,
        prompt,
        timeoutMs: 30_000,
        freshSession: promptInput.shouldStartFresh,
        signal: input.signal,
      });

      const response = toProviderResponse(result);
      const latestTabUrl =
        this.browserClient.getProviderTabUrl
          ? await this.browserClient.getProviderTabUrl({
              provider,
              tabId: session.tabId,
            })
          : null;
      const currentSession = this.state.getSessionBoundSession(sessionId, provider) ?? session;
      if (latestTabUrl) {
        this.state.setSessionBoundSession(sessionId, provider, {
          ...currentSession,
          tabUrl: latestTabUrl,
        });
      }
      this.state.setActiveRequest(session.tabId, null);
      this.state.setLastProviderRequest(provider, {
        ...baseDebugRecord,
        completedAt: new Date().toISOString(),
        status: "completed",
        response,
        automation: result.debug ?? null,
      });

      if (promptInput.shouldStartFresh || input.body.sessionInit?.fingerprint) {
        const updatedSession = this.state.getSessionBoundSession(sessionId, provider) ?? currentSession;
        const nextConversationId =
          provider === "deepseek-web"
            ? `conv-${updatedSession.tabId}`
            : `conv-${provider}-${updatedSession.tabId}-${Date.now()}`;
        this.state.setSessionBoundSession(sessionId, provider, {
          ...updatedSession,
          conversationId: promptInput.shouldStartFresh
            ? nextConversationId
            : updatedSession.conversationId,
          providerInitialized: true,
          providerInitFingerprint:
            input.body.sessionInit?.fingerprint ?? updatedSession.providerInitFingerprint,
          providerSessionKey:
            input.body.sessionInit?.sessionKey ?? updatedSession.providerSessionKey,
        });
      }

      return response;
    } catch (error) {
      if (activeTabId) {
        this.state.setActiveRequest(activeTabId, null);
      }

      if (input.signal?.aborted) {
        throw error;
      }

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
      if (baseDebugRecord) {
        this.state.setLastProviderRequest(provider, {
          ...baseDebugRecord,
          completedAt: new Date().toISOString(),
          status: "failed",
          automation: helperError.automationDebug,
          error: {
            code: helperError.code,
            message: helperError.message,
          },
        });
      }
      throw helperError;
    } finally {
      this.state.releaseBinding(sessionId, provider);
    }
  }

  async resetSession(input: { sessionId?: string; provider?: ProviderId }) {
    const sessionId = input.sessionId ?? DEFAULT_SESSION_ID;
    const sessionsToReset = input.provider
      ? (() => {
          const session = this.state.getSessionBoundSession(sessionId, input.provider);
          return session ? [session] : [];
        })()
      : [...this.state.getAllSessionBoundSessions(sessionId).values()];

    for (const session of sessionsToReset) {
      this.state.setActiveRequest(session.tabId, null);
      this.state.releaseBinding(sessionId, session.provider);
      if (this.browserClient.resetProvider) {
        await this.browserClient.resetProvider({
          provider: session.provider,
          tabId: session.tabId,
        });
      } else {
        await this.browserClient.resetPageBridge(session.tabId);
      }
    }

    if (input.provider) {
      this.state.releaseBinding(sessionId, input.provider);
      this.state.setSessionBoundSession(sessionId, input.provider, null);
      this.state.setLastProviderRequest(input.provider, null);
      return;
    }

    this.state.clearSessionState(sessionId);
    this.state.setDegraded(false);
    this.state.setLastBridgeHeartbeatAt(null);
  }

  async shutdownSession(sessionId: string) {
    const sessions = [...this.state.getAllSessionBoundSessions(sessionId).values()];

    for (const session of sessions) {
      this.state.setActiveRequest(session.tabId, null);
      this.state.releaseBinding(sessionId, session.provider);
      if (this.browserClient.resetProvider) {
        await this.browserClient.resetProvider({
          provider: session.provider,
          tabId: session.tabId,
        });
      } else {
        await this.browserClient.resetPageBridge(session.tabId);
      }
      this.state.setLastProviderRequest(session.provider, null);
    }

    this.state.clearSessionState(sessionId);
  }
}
