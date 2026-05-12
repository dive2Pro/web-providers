import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGatewayApp } from "../../src/gateway/app";
import { loadGatewayConfig } from "../../src/gateway/config";

const requestLogDirs: string[] = [];

describe("gateway config", () => {
  it("uses shared gateway token as fallback and defaults to port 4321", () => {
    expect(
      loadGatewayConfig({
        GATEWAY_TOKEN: "shared-token",
      }),
    ).toEqual({
      openAiToken: "shared-token",
      anthropicToken: "shared-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: undefined,
      port: 4321,
    });
  });
});

describe("gateway app", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      requestLogDirs.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  it("logs request headers and body for gateway routes", async () => {
    const requestLogger = vi.fn();
    const app = buildGatewayApp({
      openAiToken: "openai-token",
      anthropicToken: "anthropic-token",
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
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer openai-token",
        "x-request-source": "gateway-test",
      },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(requestLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "gateway",
        method: "POST",
        url: "/v1/chat/completions",
        routePath: "/v1/chat/completions",
        statusCode: 200,
        headers: expect.objectContaining({
          authorization: "Bearer openai-token",
          "x-request-source": "gateway-test",
        }),
        body: {
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: "hello" }],
        },
      }),
    );
  });

  it("persists request logs locally and exposes them via api", async () => {
    const requestLogDir = await mkdtemp(
      join(tmpdir(), "web-providers-gateway-logs-"),
    );
    requestLogDirs.push(requestLogDir);

    const app = buildGatewayApp({
      openAiToken: "openai-token",
      anthropicToken: "anthropic-token",
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
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer openai-token",
        "x-request-source": "gateway-api-test",
      },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(postResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/v1/debug/request-logs?limit=5",
      headers: {
        authorization: "Bearer openai-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "gateway",
      filePath: expect.stringContaining("gateway.ndjson"),
      logs: [
        expect.objectContaining({
          scope: "gateway",
          method: "POST",
          url: "/v1/chat/completions",
          headers: expect.objectContaining({
            authorization: "Bearer openai-token",
            "x-request-source": "gateway-api-test",
          }),
          body: {
            model: "deepseek-web-chat",
            messages: [{ role: "user", content: "hello" }],
          },
        }),
      ],
    });
  });

  it("requires authorization for gateway request log api", async () => {
    const requestLogDir = await mkdtemp(
      join(tmpdir(), "web-providers-gateway-logs-"),
    );
    requestLogDirs.push(requestLogDir);

    const app = buildGatewayApp({
      openAiToken: "openai-token",
      anthropicToken: "anthropic-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      requestLogDir,
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/debug/request-logs",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Unauthorized",
      },
    });
  });

  it("proxies helper session bindings through gateway", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            {
              sessionId: "claude-session-1",
              providers: {
                "deepseek-web": {
                  tabId: "tab-1",
                },
              },
            },
          ],
        }),
        status: 200,
      });

    const app = buildGatewayApp({
      openAiToken: "openai-token",
      anthropicToken: "anthropic-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: fetchMock as typeof fetch,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/debug/session-bindings",
      headers: {
        authorization: "Bearer openai-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessions: [
        {
          sessionId: "claude-session-1",
          providers: {
            "deepseek-web": {
              tabId: "tab-1",
            },
          },
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/debug/session-bindings",
      {
        method: "GET",
        headers: {
          authorization: "Bearer helper-token",
        },
      },
    );
  });

  it("returns a unified model list", async () => {
    const app = buildGatewayApp({
      openAiToken: "openai-token",
      anthropicToken: "anthropic-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const openAiResponse = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer openai-token",
      },
    });

    expect(openAiResponse.statusCode).toBe(200);
    expect(openAiResponse.json()).toMatchObject({
      object: "list",
      has_more: false,
    });
    expect(openAiResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "deepseek-web-pro",
          object: "model",
        }),
        expect.objectContaining({
          id: "deepseek-web-flash",
          object: "model",
        }),
      ]),
    );
    expect(openAiResponse.json().data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^anthropic-/),
        }),
      ]),
    );
  });

  it("serves openai chat completions routes from the merged process", async () => {
    const app = buildGatewayApp({
      openAiToken: "openai-token",
      anthropicToken: "anthropic-token",
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
        authorization: "Bearer openai-token",
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

  it("serves anthropic messages routes from the merged process", async () => {
    const app = buildGatewayApp({
      openAiToken: "openai-token",
      anthropicToken: "anthropic-token",
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
        "x-api-key": "anthropic-token",
      },
      payload: {
        model: "deepseek-web-chat",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      model: "deepseek-web-chat",
      content: [{ type: "text", text: "hello from helper" }],
    });
  });

  it("maps helper MODEL_BUSY to anthropic rate_limit_error", async () => {
    const app = buildGatewayApp({
      openAiToken: "openai-token",
      anthropicToken: "anthropic-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: "MODEL_BUSY",
          message: "Another request is already in progress",
        }),
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "anthropic-token",
      },
      payload: {
        model: "deepseek-web-chat",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Another request is already in progress",
      },
    });
  });

  it("forwards x-claude-code-session-id through gateway anthropic routes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "text",
        outputText: "hello from helper",
        finishReason: "stop",
      }),
    });

    const app = buildGatewayApp({
      openAiToken: "openai-token",
      anthropicToken: "anthropic-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: fetchMock,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "anthropic-token",
        "x-claude-code-session-id": "claude-session-1",
      },
      payload: {
        model: "deepseek-web-chat",
        max_tokens: 64,
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
});
