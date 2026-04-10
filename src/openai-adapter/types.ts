import type { PublicModel } from "./models";
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
  | "none"
  | { type: "function"; name: string };

export type ResponseFormat = "chat_completions" | "responses";

export type NormalizedRequest = {
  publicModel: PublicModel["id"];
  provider: PublicModel["provider"];
  responseFormat: ResponseFormat;
  messages: NormalizedMessage[];
  tools: NormalizedTool[];
  toolChoice: NormalizedToolChoice;
  temperature?: number;
  maxOutputTokens?: number;
};

export type ExecutionResult = ProviderChatResponse;
