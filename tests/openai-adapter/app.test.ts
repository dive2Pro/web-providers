import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAiAdapterApp } from "../../src/openai-adapter/app";
import { loadOpenAiAdapterConfig } from "../../src/openai-adapter/config";
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

  it("does not send helper authorization when helper token is not configured", async () => {
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
      fetchImpl: fetchMock,
    });

    await client.run({
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
        headers: {
          "content-type": "application/json",
        },
      }),
    );
  });

  it("forwards explicit public session ids to helper", async () => {
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

    await client.run(
      {
        publicModel: "qwen-web-chat",
        provider: "qwen-web",
        responseFormat: "chat_completions",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        toolChoice: "none",
      },
      { sessionId: "session-123" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer helper-token",
          "x-web-providers-session-id": "session-123",
        }),
      }),
    );
  });

  it("injects session init instructions when tools or system prompts are present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "text",
        outputText: "tool-ready",
        finishReason: "stop",
      }),
    });

    const client = createHelperClient({
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: fetchMock,
    });

    await client.run({
      publicModel: "deepseek-web-tools",
      provider: "deepseek-web",
      responseFormat: "chat_completions",
      messages: [
        { role: "system", content: "Always answer with JSON." },
        { role: "user", content: "Call ping with hi." },
      ],
      tools: [
        {
          name: "ping",
          description: "Echo input text",
          parametersJson:
            "{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}",
        },
      ],
      toolChoice: "auto",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        body: expect.stringContaining("\"sessionInit\""),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        body: expect.stringContaining("Tool name: ping"),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        body: expect.stringContaining("Always answer with JSON."),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        body: expect.stringContaining(
          "Return exactly one final action object per reply: either a message or a tool_call, never both.",
        ),
      }),
    );
  });

  it("includes an explicit empty tool schema in first-turn session init", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "text",
        outputText: "tool-ready",
        finishReason: "stop",
      }),
    });

    const client = createHelperClient({
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: fetchMock,
    });

    await client.run({
      publicModel: "deepseek-web-tools",
      provider: "deepseek-web",
      responseFormat: "chat_completions",
      messages: [{ role: "user", content: "Call read." }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parametersJson: "{}",
        },
      ],
      toolChoice: "auto",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        body: expect.stringContaining("Arguments JSON schema: {}"),
      }),
    );
  });
});

describe("openai adapter config", () => {
  it("falls back to local helper url when HELPER_BASE_URL is missing", () => {
    expect(
      loadOpenAiAdapterConfig({
        PORT: "4319",
      }),
    ).toEqual({
      token: undefined,
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: undefined,
      port: 4319,
    });
  });

  it("allows missing HELPER_TOKEN in local mode", () => {
    expect(
      loadOpenAiAdapterConfig({
        HELPER_BASE_URL: "http://127.0.0.1:4318",
        PORT: "4319",
      }),
    ).toEqual({
      token: undefined,
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: undefined,
      port: 4319,
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

  it("allows unauthenticated access when adapter token is not configured", async () => {
    const app = buildOpenAiAdapterApp({
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "deepseek-web-chat", object: "model" }),
      ]),
    );
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

  it("rejects chat completions requests when body is not a json object", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer adapter-token",
        "content-type": "application/json",
      },
      payload: [],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must be a JSON object",
      },
    });
  });

  it("rejects chat completions requests without model", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer adapter-token",
      },
      payload: {
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "model is required",
      },
    });
  });

  it("streams chat text responses as SSE chunks and terminates with [DONE]", async () => {
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
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("\"object\":\"chat.completion.chunk\"");
    expect(response.body).toContain("\"delta\":{\"role\":\"assistant\"}");
    expect(response.body).toContain("\"delta\":{\"content\":\"hello from helper\"}");
    expect(response.body).toContain("\"finish_reason\":\"stop\"");
    expect(response.body).toContain("data: [DONE]\n\n");
  });

  it("streams tool calls as SSE chunks and terminates with [DONE]", async () => {
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
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer adapter-token",
      },
      payload: {
        model: "deepseek-web-tools",
        stream: true,
        messages: [{ role: "user", content: "read helper main" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
        tool_choice: "auto",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("\"object\":\"chat.completion.chunk\"");
    expect(response.body).toContain("\"tool_calls\"");
    expect(response.body).toContain("\"name\":\"read_file\"");
    expect(response.body).toContain("src/helper/main.ts");
    expect(response.body).toContain("\"finish_reason\":\"tool_calls\"");
    expect(response.body).toContain("data: [DONE]\n\n");
  });

  it("returns JSON errors (not SSE) when helper rejects a streaming chat request", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: "MODEL_BUSY",
          message: "Model is busy, retry later",
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
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
    expect(response.json()).toEqual({
      error: {
        code: "model_busy",
        message: "Model is busy, retry later",
      },
    });
  });

  it("returns a JSON model_not_found error before starting SSE for streaming chat requests", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer adapter-token",
      },
      payload: {
        model: "missing-model",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
    expect(response.json()).toEqual({
      error: {
        code: "model_not_found",
        message: "Unknown model: missing-model",
      },
    });
  });

  it("streams responses text output as SSE events", async () => {
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
      url: "/v1/responses",
      headers: {
        authorization: "Bearer adapter-token",
      },
      payload: {
        model: "deepseek-web-chat",
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("\"type\":\"response.created\"");
    expect(response.body).toContain("\"type\":\"response.output_text.delta\"");
    expect(response.body).toContain("\"delta\":\"hello from helper\"");
    expect(response.body).toContain("\"type\":\"response.completed\"");
  });

  it("streams responses tool calls as SSE events", async () => {
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
        stream: true,
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
        tool_choice: "auto",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("\"type\":\"response.created\"");
    expect(response.body).toContain("\"type\":\"response.function_call_arguments.delta\"");
    expect(response.body).toContain("\"name\":\"read_file\"");
    expect(response.body).toContain("src/helper/main.ts");
    expect(response.body).toContain("\"type\":\"response.completed\"");
  });

  it("returns JSON errors (not SSE) when helper rejects a streaming responses request", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: "MODEL_BUSY",
          message: "Model is busy, retry later",
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
        model: "deepseek-web-chat",
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
    expect(response.json()).toEqual({
      error: {
        code: "model_busy",
        message: "Model is busy, retry later",
      },
    });
  });
});
