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
  sessionInit?: {
    fingerprint: string;
    prompt: string;
  };
  temperature?: number;
  maxOutputTokens?: number;
  abortKey?: string;
}

export type ProviderChatResponse =
  | {
      mode: "text";
      thinkingText?: string;
      outputText: string;
      finishReason: "stop" | "length" | "error";
      modelLabel?: string;
    }
  | {
      mode: "native_tool_call" | "json_fallback";
      thinkingText?: string;
      toolCall: {
        name: string;
        argumentsJson: string;
      };
      finishReason: "stop" | "error";
      modelLabel?: string;
      outputText?: string;
    };
