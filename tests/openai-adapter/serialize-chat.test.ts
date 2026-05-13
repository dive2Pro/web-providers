import { describe, expect, it } from "vitest";
import { serializeChatCompletions } from "../../src/openai-adapter/serialize-chat";

describe("chat completions serializer", () => {
  it("serializes text output", () => {
    expect(
      serializeChatCompletions({
        id: "resp-1",
        created: 1710000000,
        model: "qwen-web-chat",
        result: {
          mode: "text",
          outputText: "hello",
          finishReason: "stop",
          modelLabel: "Qwen Web",
        },
      }),
    ).toMatchObject({
      id: "resp-1",
      object: "chat.completion",
      model: "qwen-web-chat",
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "hello",
          },
        },
      ],
    });
  });

  it("serializes tool call output", () => {
    expect(
      serializeChatCompletions({
        id: "resp-2",
        created: 1710000000,
        model: "qwen-web-tools",
        result: {
          mode: "native_tool_call",
          toolCalls: [
            {
              name: "read_file",
              argumentsJson: "{\"path\":\"src/index.ts\"}",
            },
          ],
          finishReason: "stop",
        },
      }),
    ).toMatchObject({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [
              {
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"src/index.ts\"}",
                },
              },
            ],
          },
        },
      ],
    });
  });
});
