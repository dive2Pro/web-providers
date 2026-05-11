import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicAdapterApp } from "../../src/anthropic-adapter/app";
import { loadAnthropicAdapterConfig } from "../../src/anthropic-adapter/config";
import { normalizeMessagesRequest } from "../../src/anthropic-adapter/normalize";
import { getAnthropicPublicModel } from "../../src/anthropic-adapter/models";

describe("anthropic adapter config", () => {
  it("falls back to local helper url and default port", () => {
    expect(loadAnthropicAdapterConfig({})).toEqual({
      token: undefined,
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: undefined,
      port: 4320,
    });
  });
});

describe("anthropic adapter normalization", () => {
  it("normalizes system, text, tool_use, and tool_result blocks", () => {
    const normalized = normalizeMessagesRequest(
      {
        model: "deepseek-web-tools",
        system: [{ type: "text", text: "Be terse." }],
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "read_file",
                input: { path: "README.md" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "file contents",
              },
              {
                type: "text",
                text: "Summarize it.",
              },
            ],
          },
        ],
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            input_schema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        tool_choice: {
          type: "tool",
          name: "read_file",
        },
        max_tokens: 256,
      },
      getAnthropicPublicModel("deepseek-web-tools")!,
    );

    expect(normalized).toMatchObject({
      publicModel: "deepseek-web-tools",
      provider: "deepseek-web",
      responseFormat: "anthropic_messages",
      toolChoice: {
        type: "function",
        name: "read_file",
      },
      maxOutputTokens: 256,
      messages: [
        { role: "system", content: "Be terse." },
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({ role: "user" }),
      ],
      tools: [
        expect.objectContaining({
          name: "read_file",
        }),
      ],
    });
    expect(normalized.messages[1]?.content).toContain("tool_use");
    expect(normalized.messages[2]?.content).toContain("tool_result");
    expect(normalized.messages[2]?.content).toContain("Summarize it.");
  });
});

describe("anthropic adapter app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts x-api-key auth and returns the model list", async () => {
    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        "x-api-key": "adapter-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "anthropic-deepseek-web-chat",
          type: "model",
        }),
      ]),
    );
  });

  it("forwards Claude Code session ids to helper", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "text",
        outputText: "hello from helper",
        finishReason: "stop",
      }),
    });

    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: fetchMock,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "adapter-token",
        "x-claude-code-session-id": "claude-session-1",
      },
      payload: {
        model: "anthropic-qwen-web-chat",
        max_tokens: 256,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer helper-token",
          "x-web-providers-session-id": "claude-session-1",
        }),
      }),
    );
  });

  it("serializes helper text output into an anthropic message", async () => {
    const app = buildAnthropicAdapterApp({
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
      url: "/v1/messages",
      headers: {
        "x-api-key": "adapter-token",
      },
      payload: {
        model: "anthropic-deepseek-web-chat",
        max_tokens: 256,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      model: "anthropic-deepseek-web-chat",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hello from helper" }],
    });
  });

  it("serializes helper tool calls into anthropic tool_use blocks", async () => {
    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          mode: "json_fallback",
          toolCall: {
            name: "read_file",
            argumentsJson: "{\"path\":\"README.md\"}",
          },
          finishReason: "stop",
        }),
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "adapter-token",
      },
      payload: {
        model: "anthropic-deepseek-web-tools",
        max_tokens: 256,
        messages: [{ role: "user", content: "read README" }],
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            input_schema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          name: "read_file",
          input: {
            path: "README.md",
          },
        },
      ],
    });
  });

  it("returns token estimates for messages payloads", async () => {
    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers: {
        "x-api-key": "adapter-token",
      },
      payload: {
        system: "Be terse.",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().input_tokens).toBeGreaterThan(0);
  });

  it("streams text responses as anthropic SSE events", async () => {
    const app = buildAnthropicAdapterApp({
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
      url: "/v1/messages",
      headers: {
        "x-api-key": "adapter-token",
      },
      payload: {
        model: "anthropic-deepseek-web-chat",
        max_tokens: 256,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: message_start");
    expect(response.body).toContain("\"type\":\"content_block_delta\"");
    expect(response.body).toContain("\"text\":\"hello from helper\"");
    expect(response.body).toContain("\"stop_reason\":\"end_turn\"");
    expect(response.body).toContain("event: message_stop");
  });

  it("streams tool calls as anthropic SSE events", async () => {
    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          mode: "json_fallback",
          toolCall: {
            name: "read_file",
            argumentsJson: "{\"path\":\"README.md\"}",
          },
          finishReason: "stop",
        }),
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "adapter-token",
      },
      payload: {
        model: "anthropic-deepseek-web-tools",
        max_tokens: 256,
        stream: true,
        messages: [{ role: "user", content: "read README" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: content_block_start");
    expect(response.body).toContain("\"type\":\"tool_use\"");
    expect(response.body).toContain("\"name\":\"read_file\"");
    expect(response.body).toContain("\"partial_json\":\"{\\\"path\\\":\\\"README.md\\\"}\"");
    expect(response.body).toContain("\"stop_reason\":\"tool_use\"");
    expect(response.body).toContain("event: message_stop");
  });
});
