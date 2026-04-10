import type { ExecutionResult } from "./types";

function toFinishReason(result: ExecutionResult) {
  if (result.mode === "text") {
    return result.finishReason;
  }

  return "tool_calls";
}

export function serializeChatCompletions(input: {
  id: string;
  created: number;
  model: string;
  result: ExecutionResult;
}) {
  if (input.result.mode === "text") {
    return {
      id: input.id,
      object: "chat.completion",
      created: input.created,
      model: input.model,
      choices: [
        {
          index: 0,
          finish_reason: toFinishReason(input.result),
          message: {
            role: "assistant",
            content: input.result.outputText,
          },
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: input.result.outputText ?? null,
          tool_calls: [
            {
              id: `${input.id}-tool-1`,
              type: "function",
              function: {
                name: input.result.toolCall.name,
                arguments: input.result.toolCall.argumentsJson,
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}
