import { describe, expect, it } from "vitest";

import { serializeChatCompletionsStream } from "../../src/openai-adapter/streaming/chat-completions";

describe("serializeChatCompletionsStream", () => {
  it("serializes text output into SSE-framed chat.completion.chunk events", () => {
    const id = "chatcmpl_test_1";
    const created = 1710000000;
    const model = "test-model";

    const sse = serializeChatCompletionsStream({
      id,
      created,
      model,
      result: {
        mode: "text",
        outputText: "hello",
        finishReason: "stop",
      },
    });

    const roleChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        },
      ],
    };

    const contentChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: "hello" },
          finish_reason: null,
        },
      ],
    };

    const finishChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    };

    expect(sse).toEqual([
      `data: ${JSON.stringify(roleChunk)}\n\n`,
      `data: ${JSON.stringify(contentChunk)}\n\n`,
      `data: ${JSON.stringify(finishChunk)}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });

  it("serializes tool calls into SSE-framed chat.completion.chunk events", () => {
    const id = "chatcmpl_test_2";
    const created = 1710000001;
    const model = "test-model";

    const sse = serializeChatCompletionsStream({
      id,
      created,
      model,
      result: {
        mode: "json_fallback",
        toolCalls: [
          {
            name: "read_file",
            argumentsJson: "{\"path\":\"src/helper/main.ts\"}",
          },
        ],
        finishReason: "stop",
      },
    });

    const roleChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        },
      ],
    };

    const toolCallsChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `${id}-tool-1`,
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"src/helper/main.ts\"}",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };

    const finishChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
    };

    expect(sse).toEqual([
      `data: ${JSON.stringify(roleChunk)}\n\n`,
      `data: ${JSON.stringify(toolCallsChunk)}\n\n`,
      `data: ${JSON.stringify(finishChunk)}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });

  it("serializes native tool calls into SSE-framed chat.completion.chunk events", () => {
    const id = "chatcmpl_test_3";
    const created = 1710000002;
    const model = "test-model";

    const sse = serializeChatCompletionsStream({
      id,
      created,
      model,
      result: {
        mode: "native_tool_call",
        toolCalls: [
          {
            name: "read_file",
            argumentsJson: "{\"path\":\"src/helper/main.ts\"}",
          },
        ],
        finishReason: "stop",
      },
    });

    const roleChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        },
      ],
    };

    const toolCallsChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `${id}-tool-1`,
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"src/helper/main.ts\"}",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };

    const finishChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
    };

    expect(sse).toEqual([
      `data: ${JSON.stringify(roleChunk)}\n\n`,
      `data: ${JSON.stringify(toolCallsChunk)}\n\n`,
      `data: ${JSON.stringify(finishChunk)}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });

  it("serializes assistant text before tool calls when both are present", () => {
    const id = "chatcmpl_test_4";
    const created = 1710000003;
    const model = "test-model";

    const sse = serializeChatCompletionsStream({
      id,
      created,
      model,
      result: {
        mode: "native_tool_call",
        outputText: "I will inspect the stylesheet first.",
        toolCalls: [
          {
            name: "read_file",
            argumentsJson: "{\"path\":\"src/styles.css\"}",
          },
        ],
        finishReason: "stop",
      },
    });

    const roleChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        },
      ],
    };

    const contentChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: "I will inspect the stylesheet first." },
          finish_reason: null,
        },
      ],
    };

    const toolCallsChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `${id}-tool-1`,
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"src/styles.css\"}",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };

    const finishChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
    };

    expect(sse).toEqual([
      `data: ${JSON.stringify(roleChunk)}\n\n`,
      `data: ${JSON.stringify(contentChunk)}\n\n`,
      `data: ${JSON.stringify(toolCallsChunk)}\n\n`,
      `data: ${JSON.stringify(finishChunk)}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });
});
