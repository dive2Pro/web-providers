export type BindState = "unbound" | "bound";
export type BrowserConnectionStatus = "connected" | "disconnected";
export type ErrorCode =
  | "NOT_BOUND"
  | "PAGE_UNAVAILABLE"
  | "MODEL_BUSY"
  | "TIMEOUT"
  | "AUTOMATION_DESYNC";

export interface HealthResponse {
  ok: true;
  browser: BrowserConnectionStatus;
  bindState: BindState;
  degraded: boolean;
  lastBridgeHeartbeatAt: string | null;
}

export interface ChatRequest {
  prompt: string;
  conversationId?: string;
  timeoutMs?: number;
}

export interface ChatResponse {
  reply: string;
  conversationId: string;
  modelLabel?: string;
  rawStatus: "completed" | "timeout" | "failed";
}

export interface ProviderChatRequest {
  model: "deepseek-web-chat";
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  temperature?: number;
  maxOutputTokens?: number;
  abortKey?: string;
}

export interface ProviderChatResponse {
  outputText: string;
  finishReason: "stop" | "length" | "error";
  modelLabel?: string;
}
