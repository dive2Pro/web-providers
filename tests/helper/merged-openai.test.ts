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
