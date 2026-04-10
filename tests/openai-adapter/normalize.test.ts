import { describe, expect, it } from "vitest";
import {
  normalizeChatCompletionsRequest,
  normalizeResponsesRequest,
} from "../../src/openai-adapter/normalize";
import { getPublicModel } from "../../src/openai-adapter/models";

describe("openai adapter normalization", () => {
  const toolModel = getPublicModel("deepseek-web-tools");
  const chatModel = getPublicModel("qwen-web-chat");

  it("normalizes a chat completions request with tools", () => {
    const normalized = normalizeChatCompletionsRequest(
      {
        model: "deepseek-web-tools",
        messages: [{ role: "user", content: "list files" }],
        tools: [
          {
            type: "function",
            function: {
              name: "list_files",
              description: "List files",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: 120,
      },
      toolModel!,
    );

    expect(normalized).toMatchObject({
      publicModel: "deepseek-web-tools",
      provider: "deepseek-web",
      responseFormat: "chat_completions",
      toolChoice: "auto",
      temperature: 0.2,
      maxOutputTokens: 120,
      messages: [{ role: "user", content: "list files" }],
      tools: [
        {
          name: "list_files",
          description: "List files",
        },
      ],
    });
  });

  it("normalizes a responses request without tools", () => {
    const normalized = normalizeResponsesRequest(
      {
        model: "qwen-web-chat",
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: "Be terse." }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
      },
      chatModel!,
    );

    expect(normalized).toMatchObject({
      publicModel: "qwen-web-chat",
      provider: "qwen-web",
      responseFormat: "responses",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hello" },
      ],
      tools: [],
      toolChoice: "none",
    });
  });

  it("rejects streaming chat completions requests", () => {
    expect(() =>
      normalizeChatCompletionsRequest(
        {
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
        getPublicModel("deepseek-web-chat")!,
      ),
    ).toThrowError("Streaming is not supported");
  });
});
