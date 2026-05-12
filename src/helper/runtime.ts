import type { BrowserAutomationClient } from "./browser/types";
import { HelperError } from "./errors";
import {
  buildProviderResponseRepairPrompt,
  getProviderResponseRepairDecision,
} from "./provider-response";
import type { SessionBindingStore } from "./session-binding-store";
import { HelperState } from "./state";
import {
  normalizeBoundModelId,
  type BoundSession,
  type ProviderRequestDebugRecord,
} from "./types";
import type {
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderId,
  ProviderToolCall,
} from "../shared/contracts";

export const DEFAULT_SESSION_ID = "__default__";
export const OPENAI_PUBLIC_SESSION_ID = "__openai_public__";
const MAX_PROVIDER_RESPONSE_REPAIR_ATTEMPTS = 3;

function buildProviderPrompt(input: {
  messages: ProviderChatRequest["messages"];
  sessionInit?: ProviderChatRequest["sessionInit"];
  providerInitialized: boolean;
}) {
  const currentUser = [...input.messages]
    .reverse()
    .find((message) => message.role === "user");

  const userPrompt = currentUser?.content ?? "";
  const initPrompt = input.sessionInit?.prompt.trim() ?? "";
  const shouldStartFresh = initPrompt.length > 0 && !input.providerInitialized;

  if (!shouldStartFresh) {
    return {
      prompt: userPrompt,
      shouldStartFresh: false,
    };
  }

  return {
    prompt: [initPrompt, userPrompt].filter((part) => part.length > 0).join("\n\n"),
    shouldStartFresh: true,
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
      repair: null,
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
  toolCalls?: ProviderToolCall[];
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
    toolCalls: result.toolCalls as ProviderToolCall[],
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

function isRecoverableTabLookupError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("no browser tab is available") ||
    message.includes("tab not found") ||
    message.includes("no page target found") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("execution context was destroyed")
  );
}

export class HelperRuntime {
  constructor(
    private readonly browserClient: BrowserAutomationClient,
    private readonly state: HelperState,
    private readonly sessionBindingStore?: SessionBindingStore,
  ) {}

  private async persistSessionBindings() {
    if (!this.sessionBindingStore) {
      return;
    }

    await this.sessionBindingStore.save({
      sessions: this.state.exportSessionBindings(),
    });
  }

  private storeBoundSession(input: {
    sessionId: string;
    provider: ProviderId;
    modelId?: string | null;
    previousSession?: BoundSession | null;
    result: Awaited<ReturnType<NonNullable<BrowserAutomationClient["bindProviderTab"]>>>;
  }) {
    const modelId = normalizeBoundModelId(input.provider, input.modelId);
    const previousSession =
      input.previousSession ??
      this.state.getSessionBoundSession(input.sessionId, input.provider, modelId);
    const sameTab = isSameTab(previousSession, input.result.tabId);
    const sameSessionUrl = isSameSessionUrl(previousSession, input.result.url);
    const preserveSessionState = sameTab || sameSessionUrl;
    const nextConversationId = createConversationId(input.provider, input.result.tabId);

    const nextSession: BoundSession = {
      provider: input.provider,
      modelId,
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
    };

    this.state.setSessionBoundSession(input.sessionId, nextSession);
    return nextSession;
  }

  async bindProvider(input: {
    sessionId?: string;
    provider: ProviderId;
    modelId?: string | null;
    openNew?: boolean;
    tabId?: string;
    openUrl?: string;
    passive?: boolean;
    previousSession?: BoundSession | null;
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
            passive: input.passive,
          })
        : await this.browserClient.bindDeepSeekTab();

    if (result.loginState === "logged_out") {
      throw new HelperError(
        "NOT_BOUND",
        input.provider === "qwen-web"
          ? "Open Qwen in the browser tab, sign in on that page, then retry."
          : result.pageState.blockingMessage ??
              "DeepSeek tab is still loading. Wait for the page to finish loading and retry.",
      );
    }

    const session = this.storeBoundSession({
      sessionId,
      provider: input.provider,
      modelId: input.modelId,
      previousSession: input.previousSession,
      result,
    });
    await this.persistSessionBindings();
    return session;
  }

  async ensureBound(input: {
    sessionId: string;
    provider: ProviderId;
    modelId?: string | null;
  }) {
    const modelId = normalizeBoundModelId(input.provider, input.modelId);
    this.state.touchSession(input.sessionId);
    const existing = this.state.getSessionBoundSession(
      input.sessionId,
      input.provider,
      modelId,
    );
    const fallback =
      existing ??
      (modelId
        ? this.state.getProviderFallbackBoundSession(
            input.sessionId,
            input.provider,
          )
        : null);
    const shouldPromoteGenericBinding =
      !existing &&
      modelId !== null &&
      fallback?.provider === input.provider &&
      fallback.modelId === null;

    if (!fallback) {
      try {
        return await this.bindProvider({
          sessionId: input.sessionId,
          provider: input.provider,
          modelId,
          passive: true,
        });
      } catch (error) {
        if (
          !(error instanceof HelperError && error.code === "NOT_BOUND") &&
          !isRecoverableTabLookupError(error)
        ) {
          throw error;
        }

        return this.bindProvider({
          sessionId: input.sessionId,
          provider: input.provider,
          modelId,
          openNew: true,
        });
      }
    }

    const finalizePromotedBinding = async (session: BoundSession) => {
      if (!shouldPromoteGenericBinding) {
        return session;
      }

      this.state.clearSessionBoundSession(input.sessionId, input.provider, null);
      await this.persistSessionBindings();
      return session;
    };

    try {
      return await finalizePromotedBinding(await this.bindProvider({
        sessionId: input.sessionId,
        provider: input.provider,
        modelId,
        tabId: fallback.tabId,
        previousSession: fallback,
      }));
    } catch (error) {
      if (!isRecoverableTabLookupError(error)) {
        throw error;
      }

      try {
        return await finalizePromotedBinding(await this.bindProvider({
          sessionId: input.sessionId,
          provider: input.provider,
          modelId,
          openUrl: fallback.tabUrl,
          previousSession: fallback,
        }));
      } catch (recoveryError) {
        if (
          !isRecoverableTabLookupError(recoveryError) &&
          !(recoveryError instanceof HelperError && recoveryError.code === "NOT_BOUND")
        ) {
          throw recoveryError;
        }

        return this.bindProvider({
          sessionId: input.sessionId,
          provider: input.provider,
          modelId,
          openNew: true,
          openUrl: fallback.tabUrl,
          previousSession: fallback,
        });
      }
    }
  }

  async executeProviderChat(input: {
    sessionId?: string;
    body: ProviderChatRequest;
    signal?: AbortSignal;
  }) {
    const sessionId = input.sessionId ?? DEFAULT_SESSION_ID;
    const provider = (input.body.provider ?? "deepseek-web") as ProviderId;
    const modelId = normalizeBoundModelId(provider, input.body.model);
    if (!this.state.tryAcquireBinding(sessionId, provider, modelId)) {
      throw new HelperError("MODEL_BUSY", "Another request is already in progress");
    }

    let activeTabId: string | null = null;
    let baseDebugRecord: ProviderRequestDebugRecord | null = null;
    let repairSummary: ProviderRequestDebugRecord["repair"] = null;

    try {
      const session = await this.ensureBound({ sessionId, provider, modelId });
      activeTabId = session.tabId;

      if (this.state.hasRunningRequest(session.tabId)) {
        throw new HelperError("MODEL_BUSY", "Another request is already in progress");
      }

      const promptInput = buildProviderPrompt({
        messages: input.body.messages,
        sessionInit: input.body.sessionInit,
        providerInitialized: session.providerInitialized,
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

      const repairIssues: string[][] = [];
      let latestAutomationDebug: ProviderRequestDebugRecord["automation"] = null;
      const sendPrompt = async (nextPrompt: string, freshSession: boolean) => {
        const result = await this.browserClient.sendChatPrompt({
          provider,
          tabId: session.tabId,
          prompt: nextPrompt,
          timeoutMs: 30_000,
          freshSession,
          signal: input.signal,
        });
        latestAutomationDebug = result.debug ?? null;
        return toProviderResponse(result);
      };

      let response = await sendPrompt(prompt, promptInput.shouldStartFresh);
      let repairDecision = getProviderResponseRepairDecision(response);
      let repairAttemptCount = 0;

      while (
        repairDecision.shouldRepair &&
        repairAttemptCount < MAX_PROVIDER_RESPONSE_REPAIR_ATTEMPTS
      ) {
        repairAttemptCount += 1;
        repairIssues.push(repairDecision.issues);
        response = await sendPrompt(
          buildProviderResponseRepairPrompt({
            issues: repairDecision.issues,
            rawOutput: repairDecision.rawOutput,
            attempt: repairAttemptCount,
          }),
          false,
        );
        repairDecision = getProviderResponseRepairDecision(response);
      }

      if (repairDecision.shouldRepair) {
        repairIssues.push(repairDecision.issues);
        repairSummary = {
          attemptCount: repairAttemptCount,
          issues: repairIssues,
          success: false,
        };
        throw new HelperError(
          "INVALID_PROVIDER_RESPONSE",
          `Provider returned an invalid structured response after ${MAX_PROVIDER_RESPONSE_REPAIR_ATTEMPTS} repair attempts`,
          latestAutomationDebug,
        );
      }

      response = repairDecision.response;
      repairSummary =
        repairAttemptCount > 0
          ? {
              attemptCount: repairAttemptCount,
              issues: repairIssues,
              success: true,
            }
          : null;
      let shouldPersistSessionBindings = false;
      const latestTabUrl =
        this.browserClient.getProviderTabUrl
          ? await this.browserClient.getProviderTabUrl({
              provider,
              tabId: session.tabId,
            })
          : null;
      const currentSession =
        this.state.getSessionBoundSession(sessionId, provider, modelId) ?? session;
      let currentBoundSession = currentSession;
      if (latestTabUrl && latestTabUrl !== currentSession.tabUrl) {
        currentBoundSession = {
          ...currentSession,
          tabUrl: latestTabUrl,
        };
        this.state.setSessionBoundSession(sessionId, currentBoundSession);
        shouldPersistSessionBindings = true;
      }
      this.state.setActiveRequest(session.tabId, null);
      this.state.setLastProviderRequest(provider, {
        ...baseDebugRecord,
        completedAt: new Date().toISOString(),
        status: "completed",
        response,
        automation: latestAutomationDebug,
        repair: repairSummary,
      });

      if (input.body.sessionInit?.prompt) {
        const updatedSession =
          this.state.getSessionBoundSession(sessionId, provider, modelId) ??
          currentBoundSession;
        const nextConversationId =
          provider === "deepseek-web"
            ? `conv-${updatedSession.tabId}`
            : `conv-${provider}-${updatedSession.tabId}-${Date.now()}`;
        const nextSession: BoundSession = {
          ...updatedSession,
          conversationId: promptInput.shouldStartFresh
            ? nextConversationId
            : updatedSession.conversationId,
          providerInitialized: true,
        };
        if (
          nextSession.conversationId !== updatedSession.conversationId ||
          nextSession.providerInitialized !== updatedSession.providerInitialized
        ) {
          this.state.setSessionBoundSession(sessionId, nextSession);
          shouldPersistSessionBindings = true;
        }
      }

      if (shouldPersistSessionBindings) {
        await this.persistSessionBindings();
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
          repair: repairSummary,
          error: {
            code: helperError.code,
            message: helperError.message,
          },
        });
      }
      throw helperError;
    } finally {
      this.state.releaseBinding(sessionId, provider, modelId);
    }
  }

  async resetSession(input: { sessionId?: string; provider?: ProviderId }) {
    const sessionId = input.sessionId ?? DEFAULT_SESSION_ID;
    const sessionsToReset = input.provider
      ? this.state.getAllProviderBoundSessions(sessionId, input.provider)
      : [...this.state.getAllSessionBoundSessions(sessionId).values()];

    for (const session of sessionsToReset) {
      this.state.setActiveRequest(session.tabId, null);
      this.state.releaseBinding(sessionId, session.provider, session.modelId);
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
      this.state.clearProviderBoundSessions(sessionId, input.provider);
      this.state.setLastProviderRequest(input.provider, null);
      await this.persistSessionBindings();
      return;
    }

    this.state.clearSessionState(sessionId);
    this.state.setDegraded(false);
    this.state.setLastBridgeHeartbeatAt(null);
    await this.persistSessionBindings();
  }

  async shutdownSession(sessionId: string) {
    const sessions = [...this.state.getAllSessionBoundSessions(sessionId).values()];

    for (const session of sessions) {
      this.state.setActiveRequest(session.tabId, null);
      this.state.releaseBinding(sessionId, session.provider, session.modelId);
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
    await this.persistSessionBindings();
  }
}
