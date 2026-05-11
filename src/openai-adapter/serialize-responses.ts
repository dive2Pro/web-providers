import type { ExecutionResult } from "./types";

export function serializeResponses(input: {
  id: string;
  created: number;
  model: string;
  result: ExecutionResult;
}) {
  if (input.result.mode === "text") {
    return {
      id: input.id,
      object: "response",
      created_at: input.created,
      model: input.model,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: input.result.outputText,
            },
          ],
        },
      ],
      parallel_tool_calls: false,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  return {
    id: input.id,
    object: "response",
    created_at: input.created,
    model: input.model,
    output: input.result.toolCalls.map((toolCall, index) => ({
      type: "function_call" as const,
      name: toolCall.name,
      arguments: toolCall.argumentsJson,
      call_id: `${input.id}-tool-${index + 1}`,
    })),
    parallel_tool_calls: input.result.toolCalls.length > 1,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}
