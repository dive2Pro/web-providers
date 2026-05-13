import type { PageStateSummary } from "./browser/types";
import type { SendChatAutomationDebug } from "./browser/types";
import type {
  ProviderId,
  ProviderChatRequest,
  ProviderChatResponse,
} from "../shared/contracts";

export function normalizeBoundModelId(
  provider: ProviderId,
  modelId?: string | null,
) {
  if (provider !== "deepseek-web") {
    return null;
  }

  const normalized = modelId?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function resolveDeepSeekPageMode(modelId?: string | null) {
  const normalized = modelId?.trim() ?? "";
  if (normalized === "deepseek-web-flash") {
    return "default" as const;
  }

  if (
    normalized === "deepseek-web-pro" ||
    normalized === "deepseek-web-chat" ||
    normalized === "deepseek-web-tools"
  ) {
    return "expert" as const;
  }

  return null;
}

export function getBoundSessionKey(input: {
  provider: ProviderId;
  modelId?: string | null;
}) {
  const modelId = normalizeBoundModelId(input.provider, input.modelId);
  return modelId ? `${input.provider}::${modelId}` : input.provider;
}

export interface BoundSession {
  provider: ProviderId;
  modelId: string | null;
  tabId: string;
  tabUrl: string;
  loginState: "logged_in" | "logged_out";
  bridgeInjected: boolean;
  pageState: PageStateSummary;
  conversationId: string;
  providerInitialized: boolean;
}

export interface ActiveRequest {
  requestId: string;
  prompt: string;
  accumulatedReply: string;
  startedAt: string;
  lastEventAt: string;
  status: "running" | "completed" | "failed";
  finalErrorCode: string | null;
}

export interface SessionStateMeta {
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface SessionBindingDebugRecord {
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
  bindings: Array<{
    bindingKey: string;
    provider: ProviderId;
    modelId: string | null;
    tabId: string;
    tabUrl: string;
    conversationId: string;
    loginState: "logged_in" | "logged_out";
    bridgeInjected: boolean;
    providerInitialized: boolean;
  }>;
  providers: Partial<
    Record<
      ProviderId,
      {
        tabId: string;
        tabUrl: string;
        conversationId: string;
        loginState: "logged_in" | "logged_out";
        bridgeInjected: boolean;
      }
    >
  >;
}

export interface PersistedSessionBindingRecord {
  provider: ProviderId;
  modelId: string | null;
  tabId: string;
  tabUrl: string;
  loginState: "logged_in" | "logged_out";
  bridgeInjected: boolean;
  pageState: PageStateSummary;
  conversationId: string;
  providerInitialized: boolean;
}

export interface PersistedSessionBindingSession {
  sessionId: string;
  meta: SessionStateMeta;
  bindings: PersistedSessionBindingRecord[];
}

export interface ProviderRequestDebugRecord {
  sessionId: string;
  provider: ProviderId;
  requestId: string;
  rawRequest: ProviderChatRequest;
  normalizedMessages: ProviderChatRequest["messages"];
  prompt: string;
  session: {
    tabId: string;
    url: string;
  };
  startedAt: string;
  completedAt: string | null;
  status: "running" | "completed" | "failed";
  response: ProviderChatResponse | null;
  automation: SendChatAutomationDebug | null;
  repair:
    | {
        attemptCount: number;
        issues: string[][];
        success: boolean;
      }
    | null;
  error: {
    code: string;
    message: string;
  } | null;
}
