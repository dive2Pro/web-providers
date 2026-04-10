import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAiAdapterApp } from "../../src/openai-adapter/app";
import { createHelperClient } from "../../src/openai-adapter/helper-client";

describe("openai adapter helper client", () => {
  it("maps normalized requests into helper provider chat payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "text",
        outputText: "helper says hi",
        finishReason: "stop",
      }),
    });

    const client = createHelperClient({
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: fetchMock,
    });

    const result = await client.run({
      publicModel: "qwen-web-chat",
      provider: "qwen-web",
      responseFormat: "chat_completions",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "none",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer helper-token",
        }),
        body: JSON.stringify({
          provider: "qwen-web",
          model: "qwen-web-chat",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );
    expect(result).toMatchObject({
      mode: "text",
      outputText: "helper says hi",
    });
  });
});

describe("openai adapter app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires bearer auth for public routes", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Unauthorized",
      },
    });
  });

  it("returns the public model list", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer adapter-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "deepseek-web-chat", object: "model" }),
        expect.objectContaining({ id: "qwen-web-tools", object: "model" }),
      ]),
    );
  });

  it("returns chat completions payloads from helper text output", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          mode: "text",
          outputText: "hello from helper",
          finishReason: "stop",
        }),
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer adapter-token",
      },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "deepseek-web-chat",
      choices: [
        {
          message: {
            role: "assistant",
            content: "hello from helper",
          },
        },
      ],
    });
  });

  it("returns responses payloads from helper tool calls", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          mode: "json_fallback",
          toolCall: {
            name: "read_file",
            argumentsJson: "{\"path\":\"src/helper/main.ts\"}",
          },
          finishReason: "stop",
        }),
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer adapter-token",
      },
      payload: {
        model: "deepseek-web-tools",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "read helper main" }],
          },
        ],
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "response",
      model: "deepseek-web-tools",
      output: [
        {
          type: "function_call",
          name: "read_file",
        },
      ],
    });
  });

  it("translates helper errors into stable public errors", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: "NOT_BOUND",
          message: "Bind a deepseek-web tab before provider chat",
        }),
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer adapter-token",
      },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "provider_not_bound",
        message: "Bind a deepseek-web tab before provider chat",
      },
    });
  });
});
