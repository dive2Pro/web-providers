import type { PageStateSummary } from "./browser/types";
import type { SendChatAutomationDebug } from "./browser/types";
import type {
  ProviderId,
  ProviderChatRequest,
  ProviderChatResponse,
} from "../shared/contracts";

export interface BoundSession {
  provider: ProviderId;
  tabId: string;
  url: string;
  loginState: "logged_in" | "logged_out";
  bridgeInjected: boolean;
  pageState: PageStateSummary;
  conversationId: string;
  providerInitialized: boolean;
  providerInitFingerprint: string | null;
  providerSessionKey: string | null;
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

export interface ProviderRequestDebugRecord {
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
  error: {
    code: string;
    message: string;
  } | null;
}
