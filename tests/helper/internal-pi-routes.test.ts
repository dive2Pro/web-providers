import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/helper/app";

describe("internal pi routes", () => {
  it("returns MODEL_BUSY for concurrent turns on the same pi session/provider without opening a second tab", async () => {
    const bindCalls: Array<Record<string, unknown>> = [];
    let started: (() => void) | undefined;
    let resolvePrompt: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async (input: {
          provider: string;
          tabId?: string;
          openNew?: boolean;
        }) => {
          bindCalls.push(input);
          return {
            tabId: input.tabId ?? "tab-1",
            url: "https://chat.deepseek.com/",
            loginState: "logged_in",
            bridgeInjected: true,
            pageState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: null,
              assistantCount: 0,
            },
          };
        },
        startNewChat: async () => undefined,
        resetProvider: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          started?.();
          await new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          });

          return {
            mode: "text",
            outputText: `reply:${prompt}`,
            modelLabel: "DeepSeek Web",
          };
        },
      } as never,
    });

    const firstRequest = app.inject({
      method: "POST",
      url: "/internal/pi/provider/chat",
      headers: {
        authorization: "Bearer test-token",
        "x-pi-session-id": "session-a",
      },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    await startedPromise;

    const secondResponse = await app.inject({
      method: "POST",
      url: "/internal/pi/provider/chat",
      headers: {
        authorization: "Bearer test-token",
        "x-pi-session-id": "session-a",
      },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "again" }],
      },
    });

    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json()).toEqual({
      error: "MODEL_BUSY",
      message: "Another request is already in progress",
    });
    expect(bindCalls).toEqual([
      expect.objectContaining({ provider: "deepseek-web", passive: true }),
    ]);

    resolvePrompt?.();
    await firstRequest;
  });

  it("keeps provider binds isolated per pi session and reuses the bound tab inside one session", async () => {
    const bindCalls: Array<Record<string, unknown>> = [];
    let newTabCount = 0;

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async (input: {
          provider: string;
          tabId?: string;
          openNew?: boolean;
        }) => {
          bindCalls.push(input);
          if (input.tabId) {
            return {
              tabId: input.tabId,
              url: "https://chat.deepseek.com/",
              loginState: "logged_in",
              bridgeInjected: true,
              pageState: {
                inputReady: true,
                busy: false,
                latestAssistantPreview: null,
                assistantCount: 0,
              },
            };
          }

          newTabCount += 1;
          return {
            tabId: `tab-${newTabCount}`,
            url: "https://chat.deepseek.com/",
            loginState: "logged_in",
            bridgeInjected: true,
            pageState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: null,
              assistantCount: 0,
            },
          };
        },
        startNewChat: async () => undefined,
        resetProvider: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) => ({
          mode: "text",
          outputText: `reply:${prompt}`,
          modelLabel: "DeepSeek Web",
        }),
      } as never,
    });

    const headers = {
      authorization: "Bearer test-token",
      "x-pi-session-id": "session-a",
    };

    const first = await app.inject({
      method: "POST",
      url: "/internal/pi/provider/chat",
      headers,
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    const second = await app.inject({
      method: "POST",
      url: "/internal/pi/provider/chat",
      headers,
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "again" }],
      },
    });
    const otherSession = await app.inject({
      method: "POST",
      url: "/internal/pi/provider/chat",
      headers: {
        authorization: "Bearer test-token",
        "x-pi-session-id": "session-b",
      },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "other" }],
      },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(otherSession.statusCode).toBe(200);
    expect(bindCalls).toEqual([
      expect.objectContaining({ provider: "deepseek-web", passive: true }),
      expect.objectContaining({ provider: "deepseek-web", tabId: "tab-1" }),
      expect.objectContaining({ provider: "deepseek-web", passive: true }),
    ]);
  });

  it("allows concurrent turns for different pi sessions when they bind different tabs", async () => {
    let newTabCount = 0;
    let currentConcurrent = 0;
    let maxConcurrent = 0;
    let startedCount = 0;
    let releaseBoth: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async (input: {
          provider: string;
          tabId?: string;
          openNew?: boolean;
        }) => ({
          tabId: input.tabId ?? `tab-${++newTabCount}`,
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
        startNewChat: async () => undefined,
        resetProvider: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          currentConcurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          startedCount += 1;
          if (startedCount === 2) {
            releaseBoth?.();
          }
          await bothStarted;
          currentConcurrent -= 1;

          return {
            mode: "text",
            outputText: `reply:${prompt}`,
            modelLabel: "DeepSeek Web",
          };
        },
      } as never,
    });

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/internal/pi/provider/chat",
        headers: {
          authorization: "Bearer test-token",
          "x-pi-session-id": "session-a",
        },
        payload: {
          provider: "deepseek-web",
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: "one" }],
        },
      }),
      app.inject({
        method: "POST",
        url: "/internal/pi/provider/chat",
        headers: {
          authorization: "Bearer test-token",
          "x-pi-session-id": "session-b",
        },
        payload: {
          provider: "deepseek-web",
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: "two" }],
        },
      }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(maxConcurrent).toBe(2);
  });

  it("cleans up one pi session without touching another", async () => {
    const resetCalls: Array<{ provider: string; tabId: string }> = [];
    let newTabCount = 0;

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async (input: {
          provider: string;
          tabId?: string;
          openNew?: boolean;
        }) => ({
          tabId: input.tabId ?? `tab-${++newTabCount}`,
          url: "https://chat.qwen.ai/",
          loginState: "logged_in",
          bridgeInjected: true,
          pageState: {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
          },
        }),
        startNewChat: async () => undefined,
        resetProvider: async ({
          provider,
          tabId,
        }: {
          provider: string;
          tabId: string;
        }) => {
          resetCalls.push({ provider, tabId });
        },
        sendChatPrompt: async ({ prompt }: { prompt: string }) => ({
          mode: "text",
          outputText: `reply:${prompt}`,
          modelLabel: "Qwen Web",
        }),
      } as never,
    });

    for (const sessionId of ["session-a", "session-b"]) {
      await app.inject({
        method: "POST",
        url: "/internal/pi/provider/chat",
        headers: {
          authorization: "Bearer test-token",
          "x-pi-session-id": sessionId,
        },
        payload: {
          provider: "qwen-web",
          model: "qwen-web-chat",
          messages: [{ role: "user", content: sessionId }],
        },
      });
    }

    const shutdown = await app.inject({
      method: "POST",
      url: "/internal/pi/session/shutdown",
      headers: { authorization: "Bearer test-token" },
      payload: { sessionId: "session-a" },
    });

    await app.inject({
      method: "POST",
      url: "/internal/pi/provider/chat",
      headers: {
        authorization: "Bearer test-token",
        "x-pi-session-id": "session-a",
      },
      payload: {
        provider: "qwen-web",
        model: "qwen-web-chat",
        messages: [{ role: "user", content: "restarted" }],
      },
    });

    expect(shutdown.statusCode).toBe(200);
    expect(resetCalls).toEqual([{ provider: "qwen-web", tabId: "tab-1" }]);
  });
});
