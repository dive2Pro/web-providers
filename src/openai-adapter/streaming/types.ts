import type { ExecutionResult } from "../types";

export type ChatCompletionsChunkObject = "chat.completion.chunk";

export type ChatCompletionsFinishReason = "stop" | "length" | "error" | "tool_calls";

export type ChatCompletionsChunkChoiceDelta =
  | { role: "assistant" }
  | { content: string }
  | {
      tool_calls: Array<{
        index: number;
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | Record<string, never>;

export type ChatCompletionsChunkChoice = {
  index: number;
  delta: ChatCompletionsChunkChoiceDelta;
  finish_reason: ChatCompletionsFinishReason | null;
};

export type ChatCompletionsChunk = {
  id: string;
  object: ChatCompletionsChunkObject;
  created: number;
  model: string;
  choices: ChatCompletionsChunkChoice[];
};

export type SerializeChatCompletionsStreamInput = {
  id: string;
  created: number;
  model: string;
  result: ExecutionResult;
};
