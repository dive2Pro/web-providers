import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

describe("chat route", () => {
  it("returns a completed reply for a bound session", async () => {
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
        sendChatPrompt: async () => ({
          mode: "text",
          outputText: "hello from deepseek",
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
      url: "/v1/chat",
      headers: { authorization: "Bearer test-token" },
      payload: { prompt: "hello" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      reply: "hello from deepseek",
      conversationId: "conv-tab-1",
      modelLabel: "DeepSeek Web",
      rawStatus: "completed",
    });
  });

  it("returns NOT_BOUND when no tab is bound", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer test-token" },
      payload: { prompt: "hello" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "NOT_BOUND",
      message: "Bind a DeepSeek tab before chatting",
    });
  });

  it("returns MODEL_BUSY while another request is running", async () => {
    let started: (() => void) | undefined;
    let resolvePrompt: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });

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
          started?.();
          await new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          });

          return {
            mode: "text",
            outputText: "hello from deepseek",
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

    const firstRequest = app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer test-token" },
      payload: { prompt: "hello" },
    });

    await startedPromise;

    const secondResponse = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer test-token" },
      payload: { prompt: "hello again" },
    });

    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json()).toEqual({
      error: "MODEL_BUSY",
      message: "Another request is already in progress",
    });

    resolvePrompt?.();
    await firstRequest;
  });
});
