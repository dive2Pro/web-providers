import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGatewayApp } from "../../src/gateway/app";
import { loadGatewayConfig } from "../../src/gateway/config";

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
  afterEach(() => {
    vi.restoreAllMocks();
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
          id: "deepseek-web-chat",
          object: "model",
        }),
        expect.objectContaining({
          id: "anthropic-deepseek-web-chat",
          type: "model",
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
        model: "anthropic-deepseek-web-chat",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      model: "anthropic-deepseek-web-chat",
      content: [{ type: "text", text: "hello from helper" }],
    });
  });
});
