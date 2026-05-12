import { describe, expect, it } from "vitest";
import { serializeResponses } from "../../src/openai-adapter/serialize-responses";

describe("responses serializer", () => {
  it("serializes text output", () => {
    expect(
      serializeResponses({
        id: "resp-3",
        created: 1710000000,
        model: "qwen-web-chat",
        result: {
          mode: "text",
          outputText: "done",
          finishReason: "stop",
        },
      }),
    ).toMatchObject({
      id: "resp-3",
      object: "response",
      model: "qwen-web-chat",
      output: [
        {
          type: "message",
          role: "assistant",
        },
      ],
    });
  });

  it("serializes multiple tool calls and marks them as parallel-capable", () => {
    expect(
      serializeResponses({
        id: "resp-4",
        created: 1710000001,
        model: "qwen-web-tools",
        result: {
          mode: "json_fallback",
          toolCalls: [
            {
              name: "read_file",
              argumentsJson: "{\"path\":\"README.md\"}",
            },
            {
              name: "bash",
              argumentsJson: "{\"cmd\":\"pwd\"}",
            },
          ],
          finishReason: "stop",
        },
      }),
    ).toMatchObject({
      id: "resp-4",
      object: "response",
      model: "qwen-web-tools",
      parallel_tool_calls: true,
      output: [
        {
          type: "function_call",
          name: "read_file",
          arguments: "{\"path\":\"README.md\"}",
          call_id: "resp-4-tool-1",
        },
        {
          type: "function_call",
          name: "bash",
          arguments: "{\"cmd\":\"pwd\"}",
          call_id: "resp-4-tool-2",
        },
      ],
    });
  });
});
