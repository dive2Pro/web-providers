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
    output: [
      {
        type: "function_call",
        name: input.result.toolCall.name,
        arguments: input.result.toolCall.argumentsJson,
        call_id: `${input.id}-tool-1`,
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
