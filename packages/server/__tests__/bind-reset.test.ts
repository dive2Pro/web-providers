import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { HelperError } from "../src/errors";

describe("bind and reset", () => {
  it("keeps DeepSeek and Qwen binds isolated", async () => {
    const resetCalls: Array<{ provider: string; tabId: string }> = [];

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async ({ provider }: { provider: string }) => ({
          tabId: provider === "deepseek-web" ? "tab-deepseek" : "tab-qwen",
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
        resetProvider: async ({
          provider,
          tabId,
        }: {
          provider: string;
          tabId: string;
        }) => {
          resetCalls.push({ provider, tabId });
        },
      } as never,
    });

    const deepseekBind = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });

    const qwenBind = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "qwen-web" },
    });

    const deepseekReset = await app.inject({
      method: "POST",
      url: "/v1/reset",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });

    expect(deepseekBind.statusCode).toBe(200);
    expect(qwenBind.statusCode).toBe(200);
    expect(deepseekReset.statusCode).toBe(200);
    expect(resetCalls).toEqual([
      {
        provider: "deepseek-web",
        tabId: "tab-deepseek",
      },
    ]);
  });

  it("binds a DeepSeek tab and reports bound health", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindDeepSeekTab: async () => ({
          tabId: "tab-1",
          url: "https://chat.deepseek.com/",
          loginState: "logged_in",
          bridgeInjected: true,
          pageState: {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
          },
        }),
        resetPageBridge: async () => undefined,
      } as never,
    });

    const bindResponse = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    expect(bindResponse.statusCode).toBe(200);
    expect(bindResponse.json().tabId).toBe("tab-1");

    const healthResponse = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer test-token" },
    });

    expect(healthResponse.json()).toMatchObject({
      bindState: "bound",
      browser: "connected",
    });
  });

  it("reset clears the active bind state when the browser reset succeeds", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindDeepSeekTab: async () => ({
          tabId: "tab-1",
          url: "https://chat.deepseek.com/",
          loginState: "logged_in",
          bridgeInjected: true,
          pageState: {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
          },
        }),
        resetPageBridge: async () => undefined,
      } as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    const resetResponse = await app.inject({
      method: "POST",
      url: "/v1/reset",
      headers: { authorization: "Bearer test-token" },
    });

    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json()).toEqual({ ok: true });
  });

  it("returns NOT_BOUND when bind cannot find a DeepSeek tab", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindDeepSeekTab: async () => {
          throw new HelperError("NOT_BOUND", "No logged-in DeepSeek tab is available");
        },
        resetPageBridge: async () => undefined,
        sendChatPrompt: async () => ({
          reply: "unused",
        }),
      } as never,
    });

    const bindResponse = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    expect(bindResponse.statusCode).toBe(409);
    expect(bindResponse.json()).toEqual({
      error: "NOT_BOUND",
      message: "No logged-in DeepSeek tab is available",
    });
  });
});
