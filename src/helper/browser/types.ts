import type { BrowserConnectionStatus } from "../../shared/contracts";

export interface PageStateSummary {
  inputReady: boolean;
  busy: boolean;
  latestAssistantPreview: string | null;
  assistantCount: number;
  blockingMessage?: string | null;
}

export interface BindResult {
  tabId: string;
  url: string;
  loginState: "logged_in" | "logged_out";
  bridgeInjected: boolean;
  pageState: PageStateSummary;
}

export interface ProviderToolCall {
  name: string;
  argumentsJson: string;
}

export interface ProviderToolCallTurn {
  mode: "native_tool_call" | "json_fallback";
  toolCall: ProviderToolCall;
  outputText?: string;
  modelLabel?: string;
}

export interface ProviderTextTurn {
  mode: "text";
  outputText: string;
  modelLabel?: string;
}

export interface SendChatAutomationDebug {
  source:
    | "bridge_stream"
    | "bridge_dom_fallback"
    | "bridge_timeout_recovery"
    | "client_polling"
    | "client_recovery";
  freshSession: boolean;
  completionObserved?: boolean;
  baselineReply?: string;
  latestReply?: string;
  finalReply?: string;
}

export type SendChatResult =
  | (ProviderTextTurn & { debug?: SendChatAutomationDebug })
  | (ProviderToolCallTurn & { debug?: SendChatAutomationDebug });

export interface ChatTextResult {
  reply: string;
  modelLabel?: string;
}

export interface BrowserAutomationClient {
  getConnectionStatus(): Promise<BrowserConnectionStatus>;
  bindDeepSeekTab(): Promise<BindResult>;
  resetPageBridge(tabId: string): Promise<void>;
  startNewChat(tabId: string): Promise<void>;
  sendChatPrompt(input: {
    tabId: string;
    prompt: string;
    timeoutMs: number;
    freshSession?: boolean;
  }): Promise<SendChatResult>;
}
