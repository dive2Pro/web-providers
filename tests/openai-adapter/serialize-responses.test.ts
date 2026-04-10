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
});
