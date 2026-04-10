import type { ExecutionResult } from "../types";

export type StreamInput = {
  id: string;
  created: number;
  model: string;
  result: ExecutionResult;
};

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

export type SerializeChatCompletionsStreamInput = StreamInput;

export type ResponsesResponseObject = "response";

export type ResponsesResponseStub = {
  id: string;
  object: ResponsesResponseObject;
};

export type ResponsesCreatedEvent = {
  type: "response.created";
  response: ResponsesResponseStub & {
    created_at: number;
    model: string;
  };
};

export type ResponsesOutputTextDeltaEvent = {
  type: "response.output_text.delta";
  delta: string;
};

export type ResponsesFunctionCallArgumentsDeltaEvent = {
  type: "response.function_call_arguments.delta";
  item_id: string;
  name: string;
  delta: string;
};

export type ResponsesCompletedEvent = {
  type: "response.completed";
  response: ResponsesResponseStub;
};

export type ResponsesEvent =
  | ResponsesCreatedEvent
  | ResponsesOutputTextDeltaEvent
  | ResponsesFunctionCallArgumentsDeltaEvent
  | ResponsesCompletedEvent;
