import type { ExecutionResult } from "./types";

function parseToolInput(argumentsJson: string) {
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return {
      raw_arguments: argumentsJson,
    };
  }
}

export function serializeMessagesResponse(input: {
  id: string;
  model: string;
  result: ExecutionResult;
}) {
  if (input.result.mode === "text") {
    return {
      id: input.id,
      type: "message",
      role: "assistant",
      model: input.model,
      content: [
        {
          type: "text",
          text: input.result.outputText,
        },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    };
  }

  return {
    id: input.id,
    type: "message",
    role: "assistant",
    model: input.model,
    content: [
      ...(typeof input.result.outputText === "string" && input.result.outputText.length > 0
        ? [
            {
              type: "text" as const,
              text: input.result.outputText,
            },
          ]
        : []),
      ...input.result.toolCalls.map((toolCall, index) => ({
        type: "tool_use" as const,
        id: `${input.id}_toolu_${index + 1}`,
        name: toolCall.name,
        input: parseToolInput(toolCall.argumentsJson),
      })),
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}
