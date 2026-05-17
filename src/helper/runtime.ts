import { createHash } from "node:crypto";
import type { BrowserAutomationClient } from "./browser/types";
import { HelperError } from "./errors";
import {
  buildProviderResponseRepairPrompt,
  getProviderResponseRepairDecision,
} from "./provider-response";
import { JSON_PROTOCOL_RESPONSE_FORMAT_DECLARATION } from "../shared/code-agent-prompt";
import type { SessionBindingStore } from "./session-binding-store";
import { HelperState } from "./state";
import {
  normalizeBoundModelId,
  type BoundSession,
  type ProviderRequestDebugRecord,
} from "./types";
import type { PageStateSummary, SendChatAutomationDebug } from "./browser/types";
import type {
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderId,
  ProviderToolCall,
} from "../shared/contracts";

const MAX_PROVIDER_RESPONSE_REPAIR_ATTEMPTS = 3;

type TurnRecoveryStage =
  | "initial"
  | "reset_bridge"
  | "rebind_tab"
  | "reopen_session"
  | "fresh_chat";

type TurnContext = {
  turnId: string;
  requestFingerprint: string;
  attemptedStages: TurnRecoveryStage[];
};

export interface HelperRuntimeEvent {
  scope: "helper-runtime";
  event:
    | "bind_attempt"
    | "bind_result"
    | "bind_rejected"
    | "ensure_bound_open_new"
    | "ensure_bound_recover"
    | "reopen_bound_session"
    | "chat_recover_current_prompt"
    | "chat_fresh_session_begin"
    | "chat_fresh_session_ready"
    | "chat_send_prompt_begin"
    | "chat_send_prompt_end";
  sessionId: string;
  provider: ProviderId;
  modelId: string | null;
  tabId?: string;
  tabUrl?: string;
  previousTabId?: string;
  previousTabUrl?: string;
  openNew?: boolean;
  openUrl?: string;
  loginState?: "logged_in" | "logged_out";
  reason?: string;
  errorCode?: string;
  errorMessage?: string;
  pageState?: PageStateSummary;
}

export interface HelperRuntimeEventStore {
  append(entry: HelperRuntimeEvent): Promise<void>;
}

function appendResponseFormatDeclaration(content: string) {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  return [trimmed, `------ \n`, JSON_PROTOCOL_RESPONSE_FORMAT_DECLARATION].join("\n\n");
}

function buildProviderPrompt(input: {
  messages: ProviderChatRequest["messages"];
  sessionInit?: ProviderChatRequest["sessionInit"];
  providerInitialized: boolean;
}) {
  const currentUser = [...input.messages]
    .reverse()
    .find((message) => message.role === "user");

  const userPrompt = currentUser?.content ?? "";
  const promptWithDeclaration = appendResponseFormatDeclaration(userPrompt);
  const initPrompt = input.sessionInit?.prompt.trim() ?? "";
  const shouldStartFresh = initPrompt.length > 0 && !input.providerInitialized;

  if (!shouldStartFresh) {
    return {
      prompt: promptWithDeclaration,
      shouldStartFresh: false,
    };
  }

  return {
    prompt: [initPrompt, promptWithDeclaration]
      .filter((part) => part.length > 0)
      .join("\n\n"),
    shouldStartFresh: true,
  };
}

function createTurnId() {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createRequestFingerprint(body: ProviderChatRequest) {
  return createHash("sha1")
    .update(JSON.stringify(body))
    .digest("hex")
    .slice(0, 12);
}

function createBaseDebugRecord(
  sessionId: string,
  session: BoundSession,
  body: ProviderChatRequest,
  prompt: string,
  turnContext: TurnContext,
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
      turnId: turnContext.turnId,
      requestFingerprint: turnContext.requestFingerprint,
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
      turnRecovery: null,
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
  rawOutputText?: string;
  modelLabel?: string;
  toolCalls?: ProviderToolCall[];
}): ProviderChatResponse {
  if (result.mode === "text") {
    return {
      mode: "text",
      ...(typeof result.thinkingText === "string"
        ? { thinkingText: result.thinkingText }
        : {}),
      outputText: result.rawOutputText ?? result.outputText ?? "",
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

function isRecoverableSessionError(error: unknown) {
  if (isRecoverableTabLookupError(error)) {
    return true;
  }

  return error instanceof HelperError && error.code === "PAGE_UNAVAILABLE";
}

function isManualInterventionError(error: unknown) {
  if (!(error instanceof HelperError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.code === "NOT_BOUND" ||
    message.includes("manual verification") ||
    message.includes("sign in on that page")
  );
}

function isTurnRecoverableError(error: unknown) {
  if (isManualInterventionError(error)) {
    return false;
  }

  if (isRecoverableTabLookupError(error)) {
    return true;
  }

  if (!(error instanceof HelperError)) {
    return false;
  }

  return (
    error.code === "AUTOMATION_DESYNC" ||
    error.code === "TIMEOUT" ||
    error.code === "PAGE_UNAVAILABLE"
  );
}

function hasActiveTurnEvidence(
  debug: SendChatAutomationDebug | null | undefined,
) {
  if (!debug) {
    return false;
  }

  if (debug.completionObserved === true) {
    return true;
  }

  return (debug.trace ?? []).some((entry) => {
    if (entry.completionObserved === true) {
      return true;
    }

    if (typeof entry.completionStatus === "string" && entry.completionStatus !== "idle") {
      return true;
    }

    if (entry.completionClosed === true) {
      return true;
    }

    if (typeof entry.completionTurnPreview === "string" && entry.completionTurnPreview.length > 0) {
      return true;
    }

    return entry.pageBusy === true;
  });
}

function shouldAutoRetryCurrentTurn(error: unknown) {
  if (isManualInterventionError(error)) {
    return false;
  }

  if (isRecoverableTabLookupError(error)) {
    return true;
  }

  if (!(error instanceof HelperError)) {
    return false;
  }

  if (error.code === "PAGE_UNAVAILABLE") {
    return true;
  }

  if (error.code === "TIMEOUT") {
    return false;
  }

  if (error.code !== "AUTOMATION_DESYNC") {
    return false;
  }

  const normalizedMessage = error.message.toLowerCase();
  if (
    normalizedMessage.includes("server is busy") ||
    normalizedMessage.includes("recover the turn")
  ) {
    return false;
  }

  return !hasActiveTurnEvidence(error.automationDebug);
}

export class HelperRuntime {
  constructor(
    private readonly browserClient: BrowserAutomationClient,
    private readonly state: HelperState,
    private readonly sessionBindingStore?: SessionBindingStore,
    private readonly eventStore?: HelperRuntimeEventStore,
  ) {}

  private async appendEvent(entry: Omit<HelperRuntimeEvent, "scope">) {
    if (!this.eventStore) {
      return;
    }

    try {
      await this.eventStore.append({
        scope: "helper-runtime",
        ...entry,
      });
    } catch {
      // Logging is best-effort and should never break the main flow.
    }
  }

  private async persistSessionBindings() {
    if (!this.sessionBindingStore) {
      return;
    }

    await this.sessionBindingStore.save({
      sessions: this.state.exportSessionBindings(),
    });
  }

  private async reopenBoundSessionByUrl(input: {
    sessionId: string;
    provider: ProviderId;
    modelId?: string | null;
    previousSession: BoundSession;
  }) {
    await this.appendEvent({
      event: "reopen_bound_session",
      sessionId: input.sessionId,
      provider: input.provider,
      modelId: normalizeBoundModelId(input.provider, input.modelId),
      previousTabId: input.previousSession.tabId,
      previousTabUrl: input.previousSession.tabUrl,
      openNew: true,
      openUrl: input.previousSession.tabUrl,
      reason: "rebind previous conversation URL after a recoverable session error",
    });

    return this.bindProvider({
      sessionId: input.sessionId,
      provider: input.provider,
      modelId: input.modelId,
      openNew: true,
      openUrl: input.previousSession.tabUrl,
      previousSession: input.previousSession,
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
    sessionId: string;
    provider: ProviderId;
    modelId?: string | null;
    openNew?: boolean;
    tabId?: string;
    openUrl?: string;
    passive?: boolean;
    previousSession?: BoundSession | null;
  }) {
    const sessionId = input.sessionId;
    const normalizedModelId = normalizeBoundModelId(input.provider, input.modelId);
    this.state.touchSession(sessionId);
    await this.appendEvent({
      event: "bind_attempt",
      sessionId,
      provider: input.provider,
      modelId: normalizedModelId,
      tabId: input.tabId,
      previousTabId: input.previousSession?.tabId,
      previousTabUrl: input.previousSession?.tabUrl,
      openNew: input.openNew,
      openUrl: input.openUrl,
      reason: input.openNew
        ? "attempting a fresh bind that may open a new provider tab"
        : "attempting to bind the existing provider session",
    });
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

    await this.appendEvent({
      event: "bind_result",
      sessionId,
      provider: input.provider,
      modelId: normalizedModelId,
      tabId: result.tabId,
      tabUrl: result.url,
      previousTabId: input.previousSession?.tabId,
      previousTabUrl: input.previousSession?.tabUrl,
      openNew: input.openNew,
      openUrl: input.openUrl,
      loginState: result.loginState,
      pageState: result.pageState,
      reason: input.openNew
        ? "fresh bind resolved to a provider tab"
        : "existing bind resolved to a provider tab",
    });

    if (result.loginState === "logged_out") {
      this.storeBoundSession({
        sessionId,
        provider: input.provider,
        modelId: input.modelId,
        previousSession: input.previousSession,
        result,
      });
      await this.persistSessionBindings();
      await this.appendEvent({
        event: "bind_rejected",
        sessionId,
        provider: input.provider,
        modelId: normalizedModelId,
        tabId: result.tabId,
        tabUrl: result.url,
        openNew: input.openNew,
        openUrl: input.openUrl,
        loginState: result.loginState,
        pageState: result.pageState,
        errorCode: "NOT_BOUND",
        errorMessage:
          input.provider === "qwen-web"
            ? "Open Qwen in the browser tab, sign in on that page, then retry."
            : result.pageState.blockingMessage ??
              "DeepSeek tab is still loading. Wait for the page to finish loading and retry.",
      });
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
      await this.appendEvent({
        event: "ensure_bound_open_new",
        sessionId: input.sessionId,
        provider: input.provider,
        modelId,
        openNew: true,
        reason: "no reusable bound session was found for this provider/model",
      });
      return this.bindProvider({
        sessionId: input.sessionId,
        provider: input.provider,
        modelId,
        openNew: true,
      });
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
      if (!isRecoverableSessionError(error)) {
        throw error;
      }

      await this.appendEvent({
        event: "ensure_bound_recover",
        sessionId: input.sessionId,
        provider: input.provider,
        modelId,
        previousTabId: fallback.tabId,
        previousTabUrl: fallback.tabUrl,
        errorCode: error instanceof HelperError ? error.code : "AUTOMATION_DESYNC",
        errorMessage: error instanceof Error ? error.message : String(error),
        reason: "recoverable error while rebinding an existing session",
      });

      return finalizePromotedBinding(await this.reopenBoundSessionByUrl({
        sessionId: input.sessionId,
        provider: input.provider,
        modelId,
        previousSession: fallback,
      }));
    }
  }

  async executeProviderChat(input: {
    sessionId: string;
    body: ProviderChatRequest;
    signal?: AbortSignal;
  }) {
    const sessionId = input.sessionId;
    const provider = (input.body.provider ?? "deepseek-web") as ProviderId;
    const modelId = normalizeBoundModelId(provider, input.body.model);
    const turnContext: TurnContext = {
      turnId: createTurnId(),
      requestFingerprint: createRequestFingerprint(input.body),
      attemptedStages: [],
    };
    if (!this.state.tryAcquireBinding(sessionId, provider, modelId)) {
      throw new HelperError("MODEL_BUSY", "Another request is already in progress");
    }

    let activeTabId: string | null = null;
    let baseDebugRecord: ProviderRequestDebugRecord | null = null;
    let repairSummary: ProviderRequestDebugRecord["repair"] = null;
    let finalRecoveryStage: TurnRecoveryStage = "initial";

    const buildTurnRecoveryRecord = () =>
      turnContext.attemptedStages.length > 0 || finalRecoveryStage !== "initial"
        ? {
            recovered: turnContext.attemptedStages.length > 0,
            attemptedStages: [...turnContext.attemptedStages],
            finalStage: finalRecoveryStage,
          }
        : null;

    const recordRecoveryStage = async (
      stage: TurnRecoveryStage,
      session: BoundSession,
      error: unknown,
      reason: string,
    ) => {
      if (stage !== "initial" && !turnContext.attemptedStages.includes(stage)) {
        turnContext.attemptedStages.push(stage);
      }

      await this.appendEvent({
        event: "chat_recover_current_prompt",
        sessionId,
        provider,
        modelId,
        previousTabId: session.tabId,
        previousTabUrl: session.tabUrl,
        errorCode: error instanceof HelperError ? error.code : "AUTOMATION_DESYNC",
        errorMessage: error instanceof Error ? error.message : String(error),
        reason,
      });
    };

    const clearAttemptState = (tabId?: string | null) => {
      const targetTabId = tabId ?? activeTabId;
      if (targetTabId) {
        this.state.setActiveRequest(targetTabId, null);
      }
    };

    const executeOnBoundSession = async (
      session: BoundSession,
      options?: {
        forceFreshSession?: boolean;
        resetBridgeBeforeSend?: boolean;
        recoveryStage?: TurnRecoveryStage;
      },
    ) => {
      const recoveryStage = options?.recoveryStage ?? "initial";
      activeTabId = session.tabId;

      if (this.state.hasRunningRequest(session.tabId)) {
        throw new HelperError("MODEL_BUSY", "Another request is already in progress");
      }

      if (options?.resetBridgeBeforeSend) {
        await this.browserClient.resetPageBridge(session.tabId);
      }

      const promptInput = buildProviderPrompt({
        messages: input.body.messages,
        sessionInit: input.body.sessionInit,
        providerInitialized:
          options?.forceFreshSession === true ? false : session.providerInitialized,
      });
      const shouldInitializeDeepSeekSession =
        provider === "deepseek-web" &&
        (options?.forceFreshSession === true || !session.providerInitialized);
      const shouldStartFreshSession =
        options?.forceFreshSession === true ||
        promptInput.shouldStartFresh ||
        shouldInitializeDeepSeekSession;
      const prompt = promptInput.prompt;
      if (!baseDebugRecord) {
        baseDebugRecord = createBaseDebugRecord(
          sessionId,
          session,
          { ...input.body, provider },
          prompt,
          turnContext,
        ).record;
      } else {
        baseDebugRecord = {
          ...baseDebugRecord,
          prompt,
          session: {
            tabId: session.tabId,
            url: session.tabUrl,
          },
          completedAt: null,
          status: "running",
          response: null,
          automation: null,
          repair: null,
          turnRecovery: null,
          error: null,
        };
      }

      this.state.setLastProviderRequest(sessionId, provider, baseDebugRecord);
      this.state.setActiveRequest(session.tabId, {
        requestId: baseDebugRecord.requestId,
        turnId: turnContext.turnId,
        requestFingerprint: turnContext.requestFingerprint,
        recoveryStage,
        prompt,
        accumulatedReply: "",
        startedAt: baseDebugRecord.startedAt,
        lastEventAt: baseDebugRecord.startedAt,
        status: "running",
        finalErrorCode: null,
      });

      if (shouldStartFreshSession) {
        await this.appendEvent({
          event: "chat_fresh_session_begin",
          sessionId,
          provider,
          modelId,
          tabId: session.tabId,
          tabUrl: session.tabUrl,
          reason: shouldInitializeDeepSeekSession
            ? recoveryStage === "initial"
              ? "preparing a fresh DeepSeek session before the first prompt"
              : `preparing a fresh DeepSeek session during ${recoveryStage} recovery`
            : recoveryStage === "initial"
              ? "starting a fresh provider session from sessionInit"
              : `starting a fresh provider session from sessionInit during ${recoveryStage} recovery`,
        });
        const startNewChatTarget = this.browserClient.bindProviderTab
          ? {
              provider,
              tabId: session.tabId,
              ...(modelId !== null && modelId !== undefined ? { modelId } : {}),
            }
          : session.tabId;
        await this.browserClient.startNewChat(
          startNewChatTarget,
        );
        await this.appendEvent({
          event: "chat_fresh_session_ready",
          sessionId,
          provider,
          modelId,
          tabId: session.tabId,
          tabUrl: session.tabUrl,
          reason:
            recoveryStage === "initial"
              ? "fresh provider session is ready for prompt submission"
              : `fresh provider session is ready for prompt submission during ${recoveryStage} recovery`,
        });
      }

      const repairIssues: string[][] = [];
      let latestAutomationDebug: ProviderRequestDebugRecord["automation"] = null;
      const sendPrompt = async (nextPrompt: string, freshSession: boolean) => {
        await this.appendEvent({
          event: "chat_send_prompt_begin",
          sessionId,
          provider,
          modelId,
          tabId: session.tabId,
          tabUrl: session.tabUrl,
          reason: freshSession
            ? recoveryStage === "initial"
              ? "sending prompt on a freshly initialized provider session"
              : `sending prompt on a freshly initialized provider session during ${recoveryStage} recovery`
            : recoveryStage === "initial"
              ? "sending prompt on an existing provider session"
              : `sending prompt on an existing provider session during ${recoveryStage} recovery`,
        });
        const result = await this.browserClient.sendChatPrompt({
          provider,
          tabId: session.tabId,
          prompt: nextPrompt,
          timeoutMs: 30_000,
          freshSession,
          signal: input.signal,
        });
        await this.appendEvent({
          event: "chat_send_prompt_end",
          sessionId,
          provider,
          modelId,
          tabId: session.tabId,
          tabUrl: session.tabUrl,
          reason: `provider returned a ${result.mode} response`,
        });
        latestAutomationDebug = result.debug ?? null;
        return toProviderResponse(result);
      };

      let response = await sendPrompt(prompt, shouldStartFreshSession);
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
      this.state.setLastProviderRequest(sessionId, provider, {
        ...baseDebugRecord,
        completedAt: new Date().toISOString(),
        status: "completed",
        response,
        automation: latestAutomationDebug,
        repair: repairSummary,
        turnRecovery: buildTurnRecoveryRecord(),
      });

      if (input.body.sessionInit?.prompt || shouldInitializeDeepSeekSession) {
        const updatedSession =
          this.state.getSessionBoundSession(sessionId, provider, modelId) ??
          currentBoundSession;
        const nextConversationId =
          provider === "deepseek-web"
            ? `conv-${updatedSession.tabId}`
            : `conv-${provider}-${updatedSession.tabId}-${Date.now()}`;
        const nextSession: BoundSession = {
          ...updatedSession,
          conversationId: shouldStartFreshSession
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
    };

    const runTurnAttempt = async (
      session: BoundSession,
      stage: TurnRecoveryStage,
      options?: {
        forceFreshSession?: boolean;
        resetBridgeBeforeSend?: boolean;
      },
    ) => {
      finalRecoveryStage = stage;
      try {
        return await executeOnBoundSession(session, {
          ...options,
          recoveryStage: stage,
        });
      } catch (error) {
        clearAttemptState(session.tabId);
        throw error;
      }
    };

    try {
      const initialSession = await this.ensureBound({ sessionId, provider, modelId });
      let session = initialSession;

      try {
        return await runTurnAttempt(session, "initial");
      } catch (error) {
        if (!isTurnRecoverableError(error)) {
          throw error;
        }

        let lastError = error;
        if (!shouldAutoRetryCurrentTurn(lastError)) {
          await this.appendEvent({
            event: "chat_recover_current_prompt",
            sessionId,
            provider,
            modelId,
            previousTabId: session.tabId,
            previousTabUrl: session.tabUrl,
            errorCode: lastError instanceof HelperError ? lastError.code : "AUTOMATION_DESYNC",
            errorMessage: lastError instanceof Error ? lastError.message : String(lastError),
            reason:
              "automatic retry of the current prompt was skipped because the page shows evidence that the turn may already be active or waiting on provider-side recovery",
          });
          throw lastError;
        }
        const shouldSkipInPlaceRecovery =
          lastError instanceof HelperError && lastError.code === "PAGE_UNAVAILABLE";

        if (!shouldSkipInPlaceRecovery) {
          try {
            await recordRecoveryStage(
              "reset_bridge",
              session,
              lastError,
              "recoverable error during provider chat execution; resetting the browser bridge before retrying the same turn",
            );
            return await runTurnAttempt(session, "reset_bridge", {
              resetBridgeBeforeSend: true,
            });
          } catch (nextError) {
            lastError = nextError;
          }

          try {
            await recordRecoveryStage(
              "rebind_tab",
              session,
              lastError,
              "recoverable error during provider chat execution; rebinding the current browser tab before retrying the same turn",
            );
            session = await this.bindProvider({
              sessionId,
              provider,
              modelId,
              tabId: session.tabId,
              previousSession: session,
            });
            return await runTurnAttempt(session, "rebind_tab");
          } catch (nextError) {
            lastError = nextError;
          }
        }

        try {
          await recordRecoveryStage(
            "reopen_session",
            session,
            lastError,
            "recoverable error during provider chat execution; reopening the previous session URL before retrying the same turn",
          );
          session = await this.reopenBoundSessionByUrl({
            sessionId,
            provider,
            modelId,
            previousSession: session,
          });
          return await runTurnAttempt(session, "reopen_session");
        } catch (nextError) {
          lastError = nextError;
        }

        await recordRecoveryStage(
          "fresh_chat",
          session,
          lastError,
          "recoverable error during provider chat execution; opening a fresh provider chat before retrying the same turn",
        );
        session = await this.bindProvider({
          sessionId,
          provider,
          modelId,
          openNew: true,
          previousSession: session,
        });
        return await runTurnAttempt(session, "fresh_chat", {
          forceFreshSession: true,
        });
      }
    } catch (error) {
      clearAttemptState();

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
        this.state.setLastProviderRequest(sessionId, provider, {
          ...baseDebugRecord,
          completedAt: new Date().toISOString(),
          status: "failed",
          automation: helperError.automationDebug,
          repair: repairSummary,
          turnRecovery: buildTurnRecoveryRecord(),
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

  async resetSession(input: { sessionId: string; provider?: ProviderId }) {
    const sessionId = input.sessionId;
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
      this.state.setLastProviderRequest(sessionId, input.provider, null);
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
      this.state.setLastProviderRequest(sessionId, session.provider, null);
    }

    this.state.clearSessionState(sessionId);
    await this.persistSessionBindings();
  }
}
