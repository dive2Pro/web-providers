import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/helper/app";

describe("provider chat route", () => {
  it("accepts provider messages and returns normalized output", async () => {
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
        sendChatPrompt: async ({ prompt }: { prompt: string }) => ({
          reply: `reply:${prompt}`,
          modelLabel: "DeepSeek Web",
        }),
      } as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: {
        authorization: "Bearer test-token",
      },
      payload: {
        model: "deepseek-web-chat",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "hello" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      outputText: "reply:hello",
      finishReason: "stop",
      modelLabel: "DeepSeek Web",
    });
  });

  it("forwards only the latest user turn because DeepSeek web keeps its own chat history", async () => {
    let capturedPrompt = "";

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
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          capturedPrompt = prompt;
          return {
            reply: "ok",
            modelLabel: "DeepSeek Web",
          };
        },
      } as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        model: "deepseek-web-chat",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "continue" },
        ],
      },
    });

    expect(capturedPrompt).toBe("continue");
  });

  it("records the latest provider request for debugging", async () => {
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
        sendChatPrompt: async ({ prompt }: { prompt: string }) => ({
          reply: `reply:${prompt}`,
          modelLabel: "DeepSeek Web",
        }),
      } as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        model: "deepseek-web-chat",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "hello" },
        ],
        temperature: 0.4,
        maxOutputTokens: 256,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/debug/provider-last",
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      rawRequest: {
        model: "deepseek-web-chat",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "hello" },
        ],
        temperature: 0.4,
        maxOutputTokens: 256,
      },
      normalizedMessages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "hello" },
      ],
      prompt: "hello",
      session: {
        tabId: "tab-1",
        url: "https://chat.deepseek.com/",
      },
      response: {
        outputText: "reply:hello",
        finishReason: "stop",
        modelLabel: "DeepSeek Web",
      },
      error: null,
    });
  });

  it("records provider errors for debugging", async () => {
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
        sendChatPrompt: async () => {
          throw new Error("boom");
        },
      } as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    const requestResponse = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hey" }],
      },
    });

    expect(requestResponse.statusCode).toBe(409);

    const debugResponse = await app.inject({
      method: "GET",
      url: "/v1/debug/provider-last",
      headers: { authorization: "Bearer test-token" },
    });

    expect(debugResponse.statusCode).toBe(200);
    expect(debugResponse.json()).toMatchObject({
      rawRequest: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hey" }],
      },
      prompt: "hey",
      response: null,
      error: {
        code: "AUTOMATION_DESYNC",
        message: "Unexpected automation failure: boom",
      },
    });
  });
});
