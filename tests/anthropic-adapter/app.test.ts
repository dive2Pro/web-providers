import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_AGENT_SYSTEM_PROMPT_FIRST_LINE } from "../../src/shared/code-agent-prompt";
import { buildAnthropicAdapterApp } from "../../src/anthropic-adapter/app";
import { loadAnthropicAdapterConfig } from "../../src/anthropic-adapter/config";
import { createHelperClient } from "../../src/anthropic-adapter/helper-client";
import { normalizeMessagesRequest } from "../../src/anthropic-adapter/normalize";
import { getAnthropicPublicModel } from "../../src/anthropic-adapter/models";

const requestLogDirs: string[] = [];

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
        model: "qwen-web-tools",
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
      getAnthropicPublicModel("qwen-web-tools")!,
    );

    expect(normalized).toMatchObject({
      publicModel: "qwen-web-tools",
      provider: "qwen-web",
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

  it("rejects tool_result blocks that do not immediately follow assistant tool_use blocks", () => {
    expect(() =>
      normalizeMessagesRequest(
        {
          model: "qwen-web-tools",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_missing",
                  content: "oops",
                },
              ],
            },
          ],
        },
        getAnthropicPublicModel("qwen-web-tools")!,
      ),
    ).toThrow(/tool_result blocks must immediately follow an assistant tool_use message/);
  });

  it("accepts DeepSeek tool requests", () => {
    const normalized = normalizeMessagesRequest(
      {
        model: "deepseek-web-pro",
        messages: [{ role: "user", content: "read README" }],
        tools: [
          {
            name: "read_file",
            input_schema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        tool_choice: { type: "any" },
      },
      getAnthropicPublicModel("deepseek-web-pro")!,
    );

    expect(normalized).toMatchObject({
      publicModel: "deepseek-web-pro",
      provider: "deepseek-web",
      toolChoice: "required",
      tools: [
        expect.objectContaining({
          name: "read_file",
        }),
      ],
    });
  });
});

describe("anthropic adapter helper client", () => {
  it("handles session title generation locally without opening a provider chat", async () => {
    const fetchMock = vi.fn();
    const client = createHelperClient({
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: fetchMock,
    });

    const result = await client.run({
      publicModel: "deepseek-web-chat",
      provider: "deepseek-web",
      responseFormat: "anthropic_messages",
      messages: [
        {
          role: "system",
          content: [
            "You are Claude Code, Anthropic's official CLI for Claude.",
            "Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session.",
            'Return JSON with a single "title" field.',
          ].join("\n"),
        },
        {
          role: "user",
          content: "fix login button on mobile",
        },
      ],
      tools: [],
      toolChoice: "none",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      mode: "text",
      outputText: "{\"title\":\"Fix login button on mobile\"}",
      finishReason: "stop",
    });
  });

  it("injects tool and json protocol instructions into session init when tools are present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "text",
        outputText: "hello",
        finishReason: "stop",
      }),
    });
    const client = createHelperClient({
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: fetchMock,
    });

    await client.run({
      publicModel: "qwen-web-tools",
      provider: "qwen-web",
      responseFormat: "anthropic_messages",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Read README." },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parametersJson: "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}}",
        },
      ],
      toolChoice: "required",
    });

    const requestBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"),
    ) as { sessionInit?: { prompt?: string } };
    const sessionInitPrompt = String(requestBody.sessionInit?.prompt ?? "");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        body: expect.stringContaining("你是一个 code agent API，不是面向终端用户的闲聊助手。"),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        body: expect.stringContaining("工具名：read_file"),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        body: expect.stringContaining(
          "本轮必须至少调用一个工具。你必须返回 tool_call 或 tool_calls 类型的 JSON 对象。",
        ),
      }),
    );
    expect(sessionInitPrompt.split("\n")[0]).toBe(CODE_AGENT_SYSTEM_PROMPT_FIRST_LINE);
    expect(sessionInitPrompt).toContain(
      "最高优先级：输出协议高于其他一切表达习惯。",
    );
  });

  it("injects json envelope instructions even when no tools are present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "text",
        outputText: "hello",
        finishReason: "stop",
      }),
    });
    const client = createHelperClient({
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: fetchMock,
    });

    await client.run({
      publicModel: "deepseek-web-pro",
      provider: "deepseek-web",
      responseFormat: "anthropic_messages",
      messages: [{ role: "user", content: "Say hi." }],
      tools: [],
      toolChoice: "none",
    });

    const requestBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"),
    ) as { sessionInit?: { prompt?: string } };
    const sessionInitPrompt = String(requestBody.sessionInit?.prompt ?? "");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        body: expect.stringContaining("\"sessionInit\""),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        body: expect.stringContaining(
          "你是一个 code agent API，不是面向终端用户的闲聊助手。",
        ),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        body: expect.stringContaining(
          "本轮禁止调用任何工具。你必须返回 message 类型的 JSON 对象。",
        ),
      }),
    );
    expect(sessionInitPrompt.split("\n")[0]).toBe(CODE_AGENT_SYSTEM_PROMPT_FIRST_LINE);
    expect(sessionInitPrompt).toContain(
      "最高优先级：输出协议高于其他一切表达习惯。",
    );
  });
});

describe("anthropic adapter app", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      requestLogDirs.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  it("logs request headers and body for anthropic routes", async () => {
    const requestLogger = vi.fn();
    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      requestLogger,
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
        "x-request-source": "anthropic-test",
      },
      payload: {
        model: "deepseek-web-chat",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(requestLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "anthropic-adapter",
        method: "POST",
        url: "/v1/messages",
        routePath: "/v1/messages",
        statusCode: 200,
        headers: expect.objectContaining({
          "x-api-key": "adapter-token",
          "x-request-source": "anthropic-test",
        }),
        body: {
          model: "deepseek-web-chat",
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }],
        },
      }),
    );
  });

  it("persists request logs locally and exposes them via api", async () => {
    const requestLogDir = await mkdtemp(
      join(tmpdir(), "web-providers-anthropic-logs-"),
    );
    requestLogDirs.push(requestLogDir);

    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      requestLogDir,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          mode: "text",
          outputText: "hello from helper",
          finishReason: "stop",
        }),
      }),
    });

    const postResponse = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "adapter-token",
        "x-request-source": "anthropic-api-test",
      },
      payload: {
        model: "deepseek-web-chat",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(postResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/v1/debug/request-logs?limit=5",
      headers: {
        "x-api-key": "adapter-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "anthropic-adapter",
      filePath: expect.stringContaining("anthropic-adapter.ndjson"),
      logs: [
        expect.objectContaining({
          scope: "anthropic-adapter",
          method: "POST",
          url: "/v1/messages",
          headers: expect.objectContaining({
            "x-api-key": "adapter-token",
            "x-request-source": "anthropic-api-test",
          }),
          body: {
            model: "deepseek-web-chat",
            max_tokens: 64,
            messages: [{ role: "user", content: "hello" }],
          },
        }),
      ],
    });
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
          id: "deepseek-web-pro",
          type: "model",
        }),
        expect.objectContaining({
          id: "deepseek-web-flash",
          type: "model",
        }),
      ]),
    );
    expect(response.json().data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^anthropic-/),
        }),
      ]),
    );
  });

  it("rejects removed anthropic-prefixed model aliases", async () => {
    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "adapter-token",
      },
      payload: {
        model: "anthropic-deepseek-web-chat",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Unknown model: anthropic-deepseek-web-chat",
      },
    });
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
        model: "qwen-web-chat",
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
        model: "deepseek-web-chat",
        max_tokens: 256,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      model: "deepseek-web-chat",
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
          toolCalls: [
            {
              name: "read_file",
              argumentsJson: "{\"path\":\"README.md\"}",
            },
          ],
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
        model: "qwen-web-tools",
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

  it("rejects messages that use a system role instead of the top-level system field", async () => {
    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "adapter-token",
      },
      payload: {
        model: "deepseek-web-chat",
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "hello" },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: 'messages[0].role must be "user" or "assistant"',
      },
    });
  });

  it("rejects tool_result blocks that appear after text in the same user message", async () => {
    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "adapter-token",
      },
      payload: {
        model: "qwen-web-tools",
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
              { type: "text", text: "here you go" },
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "README",
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "messages[1].content tool_result blocks must come before all other content blocks",
      },
    });
  });

  it("maps helper invalid structured response errors to anthropic api errors", async () => {
    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: "INVALID_PROVIDER_RESPONSE",
          message: "Provider returned an invalid structured response after 3 repair attempts",
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
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "Provider returned an invalid structured response after 3 repair attempts",
      },
    });
  });

  it("serializes multiple helper tool calls into multiple anthropic tool_use blocks", async () => {
    const app = buildAnthropicAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
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
        model: "qwen-web-tools",
        max_tokens: 256,
        messages: [{ role: "user", content: "inspect the project" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: "message",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          name: "read_file",
          input: { path: "README.md" },
        },
        {
          type: "tool_use",
          name: "bash",
          input: { cmd: "pwd" },
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
        model: "deepseek-web-chat",
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
          toolCalls: [
            {
              name: "read_file",
              argumentsJson: "{\"path\":\"README.md\"}",
            },
          ],
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
        model: "qwen-web-tools",
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
