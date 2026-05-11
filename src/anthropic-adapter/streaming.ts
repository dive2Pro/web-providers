import type { ExecutionResult } from "./types";

function toSseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createBaseMessage(input: { id: string; model: string }) {
  return {
    id: input.id,
    type: "message",
    role: "assistant",
    model: input.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

function parseToolInput(argumentsJson: string) {
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return {
      raw_arguments: argumentsJson,
    };
  }
}

export function serializeMessagesStream(input: {
  id: string;
  model: string;
  result: ExecutionResult;
}) {
  const events: string[] = [
    toSseEvent("message_start", {
      type: "message_start",
      message: createBaseMessage({
        id: input.id,
        model: input.model,
      }),
    }),
  ];

  let nextIndex = 0;

  if (input.result.mode === "text") {
    events.push(
      toSseEvent("content_block_start", {
        type: "content_block_start",
        index: nextIndex,
        content_block: {
          type: "text",
          text: "",
        },
      }),
    );
    events.push(
      toSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: nextIndex,
        delta: {
          type: "text_delta",
          text: input.result.outputText,
        },
      }),
    );
    events.push(
      toSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: nextIndex,
      }),
    );
    events.push(
      toSseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: 0,
        },
      }),
    );
    events.push(
      toSseEvent("message_stop", {
        type: "message_stop",
      }),
    );
    return events;
  }

  if (typeof input.result.outputText === "string" && input.result.outputText.length > 0) {
    events.push(
      toSseEvent("content_block_start", {
        type: "content_block_start",
        index: nextIndex,
        content_block: {
          type: "text",
          text: "",
        },
      }),
    );
    events.push(
      toSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: nextIndex,
        delta: {
          type: "text_delta",
          text: input.result.outputText,
        },
      }),
    );
    events.push(
      toSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: nextIndex,
      }),
    );
    nextIndex += 1;
  }

  events.push(
    toSseEvent("content_block_start", {
      type: "content_block_start",
      index: nextIndex,
      content_block: {
        type: "tool_use",
        id: `${input.id}_toolu_1`,
        name: input.result.toolCalls[0]?.name ?? "unknown_tool",
        input: {},
      },
    }),
  );
  events.push(
    toSseEvent("content_block_delta", {
      type: "content_block_delta",
      index: nextIndex,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(
          parseToolInput(input.result.toolCalls[0]?.argumentsJson ?? "{}"),
        ),
      },
    }),
  );
  events.push(
    toSseEvent("content_block_stop", {
      type: "content_block_stop",
      index: nextIndex,
    }),
  );
  nextIndex += 1;
  for (const [index, toolCall] of input.result.toolCalls.entries()) {
    if (index === 0) {
      continue;
    }

    events.push(
      toSseEvent("content_block_start", {
        type: "content_block_start",
        index: nextIndex,
        content_block: {
          type: "tool_use",
          id: `${input.id}_toolu_${index + 1}`,
          name: toolCall.name,
          input: {},
        },
      }),
    );
    events.push(
      toSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: nextIndex,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(parseToolInput(toolCall.argumentsJson)),
        },
      }),
    );
    events.push(
      toSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: nextIndex,
      }),
    );
    nextIndex += 1;
  }
  events.push(
    toSseEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: "tool_use",
        stop_sequence: null,
      },
      usage: {
        output_tokens: 0,
      },
    }),
  );
  events.push(
    toSseEvent("message_stop", {
      type: "message_stop",
    }),
  );

  return events;
}
