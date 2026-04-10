import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/helper/app";

describe("helper app", () => {
  it("returns provider-keyed debug records when multiple providers have history", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async ({ provider }: { provider: string }) => ({
          tabId: provider === "deepseek-web" ? "tab-1" : "tab-2",
          url:
            provider === "deepseek-web"
              ? "https://chat.deepseek.com/"
              : "https://chat.qwen.ai/",
          loginState: "logged_in",
          bridgeInjected: true,
          pageState: {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
          },
        }),
        resetProvider: async () => undefined,
        startNewChat: async () => undefined,
        sendChatPrompt: async ({
          provider,
          prompt,
        }: {
          provider?: string;
          prompt: string;
        }) => ({
          mode: "text",
          outputText: `${provider}:${prompt}`,
          modelLabel: provider === "qwen-web" ? "Qwen Web" : "DeepSeek Web",
        }),
      } as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "qwen-web" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "qwen-web",
        model: "qwen-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/debug/provider-last",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      "deepseek-web": {
        provider: "deepseek-web",
        requestId: expect.any(String),
      },
      "qwen-web": {
        provider: "qwen-web",
        requestId: expect.any(String),
      },
    });
  });

  it("allows unauthenticated access to provider debug state", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "disconnected",
      } as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/debug/provider-last",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  it("still requires authorization for non-debug helper routes", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "disconnected",
      } as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "UNAUTHORIZED",
    });
  });

  it("allows unauthenticated access when helper token is not configured", async () => {
    const app = buildApp({
      browserClient: {
        getConnectionStatus: async () => "disconnected",
      } as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      browser: "disconnected",
      bindState: "unbound",
      degraded: false,
      lastBridgeHeartbeatAt: null,
    });
  });

  it("returns health state for an unbound helper", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "disconnected",
      } as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      browser: "disconnected",
      bindState: "unbound",
      degraded: false,
      lastBridgeHeartbeatAt: null,
    });
  });
});
