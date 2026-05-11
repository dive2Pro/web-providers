import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/helper/app";
import { HelperError } from "../../src/helper/errors";

describe("merged helper openai routes", () => {
  it("serves the public model list from the merged app", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
      } as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      data: expect.arrayContaining([
        expect.objectContaining({ id: "deepseek-web-chat", object: "model" }),
      ]),
    });
  });

  it("runs chat completions through the merged runtime", async () => {
    const bindCalls: Array<Record<string, unknown>> = [];

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
            tabId: input.tabId ?? "tab-openai",
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
        sendChatPrompt: async ({ prompt }: { prompt: string }) => ({
          mode: "text",
          outputText: `reply:${prompt}`,
          modelLabel: "DeepSeek Web",
        }),
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test-token" },
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
        expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            content: "reply:hello",
          }),
        }),
      ],
    });
    expect(bindCalls).toEqual([
      { provider: "deepseek-web", openNew: true, tabId: undefined },
    ]);
  });

  it("maps helper runtime errors to stable public openai errors", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async () => {
          throw new HelperError(
            "PAGE_UNAVAILABLE",
            "No page target found",
          );
        },
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test-token" },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: "upstream_failure",
        message: "No page target found",
      },
    });
  });

  it("does not reuse the same public openai tab across separate requests by default", async () => {
    const bindCalls: Array<Record<string, unknown>> = [];
    let openedCount = 0;

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
          openedCount += 1;
          return {
            tabId: `tab-${openedCount}`,
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
        sendChatPrompt: async ({ prompt }: { prompt: string }) => ({
          mode: "text",
          outputText: `reply:${prompt}`,
          modelLabel: "DeepSeek Web",
        }),
      } as never,
    });

    for (const prompt of ["one", "two"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer test-token" },
        payload: {
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: prompt }],
        },
      });

      expect(response.statusCode).toBe(200);
    }

    expect(bindCalls).toEqual([
      { provider: "deepseek-web", openNew: true, tabId: undefined },
      { provider: "deepseek-web", openNew: true, tabId: undefined },
    ]);
  });

  it("reuses the same public openai tab when x-web-providers-session-id stays the same", async () => {
    const bindCalls: Array<Record<string, unknown>> = [];
    let openedCount = 0;
    const tabUrls = new Map<string, string>([["tab-1", "https://chat.deepseek.com/"]]);

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        getProviderTabUrl: async ({ tabId }: { provider: string; tabId: string }) =>
          tabUrls.get(tabId) ?? null,
        bindProviderTab: async (input: {
          provider: string;
          tabId?: string;
          openNew?: boolean;
          openUrl?: string;
        }) => {
          bindCalls.push(input);
          if (input.tabId) {
            return {
              tabId: input.tabId,
              url: tabUrls.get(input.tabId) ?? "https://chat.deepseek.com/",
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

          openedCount += 1;
          const tabId = `tab-${openedCount}`;
          return {
            tabId,
            url: tabUrls.get(tabId) ?? "https://chat.deepseek.com/",
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
        sendChatPrompt: async ({ prompt }: { prompt: string }) => ({
          mode: "text",
          outputText: `reply:${prompt}`,
          modelLabel: "DeepSeek Web",
        }),
      } as never,
    });

    for (const prompt of ["one", "two"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer test-token",
          "x-web-providers-session-id": "public-session-a",
        },
        payload: {
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: prompt }],
        },
      });

      expect(response.statusCode).toBe(200);

      if (prompt === "one") {
        tabUrls.set("tab-1", "https://chat.deepseek.com/a/chat/s/session-1");
      }
    }

    expect(bindCalls).toEqual([
      { provider: "deepseek-web", openNew: true, tabId: undefined },
      { provider: "deepseek-web", openNew: undefined, tabId: "tab-1" },
    ]);
  });

  it("reopens and rebinds a fresh public openai tab when the remembered tab has been closed", async () => {
    const bindCalls: Array<Record<string, unknown>> = [];
    const tabUrls = new Map<string, string>([["tab-1", "https://chat.deepseek.com/a/chat/s/original-session"]]);

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        getProviderTabUrl: async ({ tabId }: { provider: string; tabId: string }) =>
          tabUrls.get(tabId) ?? null,
        bindProviderTab: async (input: {
          provider: string;
          tabId?: string;
          openNew?: boolean;
          openUrl?: string;
        }) => {
          bindCalls.push(input);

          if (input.openNew) {
            return {
              tabId: bindCalls.length === 1 ? "tab-1" : "tab-2",
              url: input.openUrl ?? "https://chat.deepseek.com/",
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

          throw new Error("Tab not found: tab-1");
        },
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) => ({
          mode: "text",
          outputText: `reply:${prompt}`,
          modelLabel: "DeepSeek Web",
        }),
      } as never,
    });

    for (const prompt of ["one", "two"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer test-token",
          "x-web-providers-session-id": "public-session-stale",
        },
        payload: {
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: prompt }],
        },
      });

      expect(response.statusCode).toBe(200);
    }

    expect(bindCalls).toEqual([
      { provider: "deepseek-web", openNew: true, tabId: undefined },
      { provider: "deepseek-web", openNew: undefined, tabId: "tab-1" },
      {
        provider: "deepseek-web",
        openNew: undefined,
        openUrl: "https://chat.deepseek.com/a/chat/s/original-session",
        tabId: undefined,
      },
      {
        provider: "deepseek-web",
        openNew: true,
        openUrl: "https://chat.deepseek.com/a/chat/s/original-session",
        tabId: undefined,
      },
    ]);
  });

  it("returns 400 when the merged openai route receives no model", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test-token" },
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
});
