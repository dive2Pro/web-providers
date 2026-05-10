import type {
  BrowserConnectionStatus,
  ProviderId,
} from "../../shared/contracts";

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
  thinkingText?: string;
  outputText?: string;
  modelLabel?: string;
}

export interface ProviderTextTurn {
  mode: "text";
  thinkingText?: string;
  outputText: string;
  modelLabel?: string;
}

export interface SendChatAutomationDebug {
  source:
    | "bridge_stream"
    | "bridge_dom_fallback"
    | "bridge_timeout_recovery"
    | "client_polling"
    | "client_recovery"
    | "client_error";
  freshSession: boolean;
  completionObserved?: boolean;
  baselineReply?: string;
  latestReply?: string;
  finalReply?: string;
  startMode?: "bridge_start" | "transport_submit";
  trace?: Array<{
    phase: string;
    pageBusy?: boolean;
    pageReplyPreview?: string | null;
    assistantCount?: number;
    completionStatus?: string | null;
    completionClosed?: boolean;
    completionObserved?: boolean;
    completionTurnMode?: string | null;
    completionTurnPreview?: string | null;
    note?: string;
  }>;
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
  bindProviderTab?(input: {
    provider: ProviderId;
    tabId?: string;
    openNew?: boolean;
  }): Promise<BindResult>;
  bindDeepSeekTab(): Promise<BindResult>;
  resetProvider?(input: { provider: ProviderId; tabId: string }): Promise<void>;
  resetPageBridge(tabId: string): Promise<void>;
  startNewChat(
    input:
      | string
      | {
          provider: ProviderId;
          tabId: string;
        },
  ): Promise<void>;
  sendChatPrompt(input: {
    provider?: ProviderId;
    tabId: string;
    prompt: string;
    timeoutMs: number;
    freshSession?: boolean;
    signal?: AbortSignal;
  }): Promise<SendChatResult>;
}
