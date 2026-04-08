import type { PageStateSummary } from "./browser/types";
import type {
  ProviderChatRequest,
  ProviderChatResponse,
} from "../shared/contracts";

export interface BoundSession {
  tabId: string;
  url: string;
  loginState: "logged_in" | "logged_out";
  bridgeInjected: boolean;
  pageState: PageStateSummary;
  conversationId: string;
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
  error: {
    code: string;
    message: string;
  } | null;
}
