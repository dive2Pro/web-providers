import type { ProviderChatResponse } from "../shared/contracts";

export type NormalizedMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type NormalizedTool = {
  name: string;
  description?: string;
  parametersJson: string;
};

export type NormalizedToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; name: string };

export type NormalizedRequest = {
  publicModel: string;
  provider: "deepseek-web" | "qwen-web";
  responseFormat: "anthropic_messages";
  messages: NormalizedMessage[];
  tools: NormalizedTool[];
  toolChoice: NormalizedToolChoice;
  temperature?: number;
  maxOutputTokens?: number;
};

export type ExecutionResult = ProviderChatResponse;
