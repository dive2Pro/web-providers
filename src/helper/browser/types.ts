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

export interface SendChatResult {
  reply: string;
  modelLabel?: string;
}

export interface BrowserAutomationClient {
  getConnectionStatus(): Promise<BrowserConnectionStatus>;
  bindDeepSeekTab(): Promise<BindResult>;
  resetPageBridge(tabId: string): Promise<void>;
  sendChatPrompt(input: {
    tabId: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<SendChatResult>;
}
