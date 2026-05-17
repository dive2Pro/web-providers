import type { ExecutionResult } from "../types";
import type {
  ChatCompletionsChunk,
  ChatCompletionsFinishReason,
  SerializeChatCompletionsStreamInput,
} from "./types";

function toSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function toFinishReason(result: ExecutionResult): ChatCompletionsFinishReason {
  if (result.mode === "text") return result.finishReason;
  return "tool_calls";
}

export function serializeChatCompletionsStream(
  input: SerializeChatCompletionsStreamInput,
): string[] {
  const { id, created, model, result } = input;

  const roleChunk: ChatCompletionsChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      { index: 0, delta: { role: "assistant" }, finish_reason: null },
    ],
  };

  if (result.mode === "text") {
    const contentChunk: ChatCompletionsChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        { index: 0, delta: { content: result.outputText }, finish_reason: null },
      ],
    };

    const finishChunk: ChatCompletionsChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        { index: 0, delta: {}, finish_reason: toFinishReason(result) },
      ],
    };

    return [
      toSseData(roleChunk),
      toSseData(contentChunk),
      toSseData(finishChunk),
      "data: [DONE]\n\n",
    ];
  }

  const contentChunk =
    typeof result.outputText === "string" && result.outputText.length > 0
      ? {
          id,
          object: "chat.completion.chunk" as const,
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: result.outputText },
              finish_reason: null,
            },
          ],
        }
      : null;

  const toolCallsChunk: ChatCompletionsChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: result.toolCalls.map((toolCall, index) => ({
            index,
            id: `${id}-tool-${index + 1}`,
            type: "function" as const,
            function: {
              name: toolCall.name,
              arguments: toolCall.argumentsJson,
            },
          })),
        },
        finish_reason: null,
      },
    ],
  };

  const finishChunk: ChatCompletionsChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: toFinishReason(result) }],
  };

  return [
    toSseData(roleChunk),
    ...(contentChunk ? [toSseData(contentChunk)] : []),
    toSseData(toolCallsChunk),
    toSseData(finishChunk),
    "data: [DONE]\n\n",
  ];
}
