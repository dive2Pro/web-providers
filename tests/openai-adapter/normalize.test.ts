import { describe, expect, it } from "vitest";
import {
  normalizeChatCompletionsRequest,
  normalizeResponsesRequest,
} from "../../src/openai-adapter/normalize";
import { getPublicModel } from "../../src/openai-adapter/models";

describe("openai adapter normalization", () => {
  const toolModel = getPublicModel("qwen-web-tools");
  const chatModel = getPublicModel("qwen-web-chat");

  it("normalizes a chat completions request with tools", () => {
    const normalized = normalizeChatCompletionsRequest(
      {
        model: "qwen-web-tools",
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
      publicModel: "qwen-web-tools",
      provider: "qwen-web",
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

  it("normalizes tool schemas from input_schema when parameters is absent", () => {
    const normalized = normalizeChatCompletionsRequest(
      {
        model: "qwen-web-tools",
        messages: [{ role: "user", content: "list files" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "Read a file",
              input_schema: {
                type: "object",
                properties: {
                  path: { type: "string" },
                },
                required: ["path"],
              },
            },
          } as unknown as {
            type: "function";
            function: {
              name: string;
              description?: string;
              parameters?: unknown;
            };
          },
        ],
      },
      toolModel!,
    );

    expect(normalized.tools[0]?.parametersJson).toBe(
      JSON.stringify({
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      }),
    );
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

  it("normalizes a responses request with string input", () => {
    const normalized = normalizeResponsesRequest(
      {
        model: "qwen-web-chat",
        input: "hello",
      },
      chatModel!,
    );

    expect(normalized).toMatchObject({
      publicModel: "qwen-web-chat",
      provider: "qwen-web",
      responseFormat: "responses",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "none",
    });
  });

  it("normalizes responses tool schema from input_schema", () => {
    const normalized = normalizeResponsesRequest(
      {
        model: "qwen-web-tools",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        tools: [
          {
            type: "function",
            name: "read",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          } as unknown as {
            type?: "function";
            name: string;
            description?: string;
            parameters?: unknown;
          },
        ],
      },
      toolModel!,
    );

    expect(normalized.tools[0]?.parametersJson).toBe(
      JSON.stringify({
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      }),
    );
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

  it("accepts DeepSeek tool requests for pro mode", () => {
    const normalized = normalizeChatCompletionsRequest(
      {
        model: "deepseek-web-pro",
        messages: [{ role: "user", content: "list files" }],
        tools: [
          {
            type: "function",
            function: {
              name: "list_files",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
      },
      getPublicModel("deepseek-web-pro")!,
    );

    expect(normalized).toMatchObject({
      publicModel: "deepseek-web-pro",
      provider: "deepseek-web",
      toolChoice: "auto",
      tools: [
        {
          name: "list_files",
        },
      ],
    });
  });
});
