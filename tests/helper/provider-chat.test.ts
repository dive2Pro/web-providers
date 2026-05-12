import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/helper/app";
import { HelperError } from "../../src/helper/errors";
import {
  JSON_PROTOCOL_REPAIR_ACTION_RULE,
  JSON_PROTOCOL_REPAIR_HEADER,
  JSON_PROTOCOL_REPAIR_REQUIREMENT,
} from "../../src/shared/code-agent-prompt";

function messageResponse(
  content: string,
  input?: {
    modelLabel?: string;
    thinkingText?: string;
    debug?: Record<string, unknown>;
  },
) {
  return {
    mode: "text" as const,
    outputText: JSON.stringify({ type: "message", content }),
    modelLabel: input?.modelLabel ?? "DeepSeek Web",
    ...(typeof input?.thinkingText === "string"
      ? { thinkingText: input.thinkingText }
      : {}),
    ...(input?.debug ? { debug: input.debug } : {}),
  };
}

describe("provider chat route", () => {
  it("reuses a manually bound DeepSeek tab before creating a model-scoped binding", async () => {
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
            tabId: input.tabId ?? "tab-1",
            url: "https://chat.deepseek.com/a/chat/s/manual-bind",
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
        resetProvider: async () => undefined,
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) =>
          messageResponse(`reply:${prompt}`),
      } as never,
    });

    const bindResponse = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: {
        authorization: "Bearer test-token",
      },
      payload: {
        provider: "deepseek-web",
      },
    });

    const chatResponse = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: {
        authorization: "Bearer test-token",
      },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(bindResponse.statusCode).toBe(200);
    expect(chatResponse.statusCode).toBe(200);
    expect(bindCalls).toEqual([
      expect.objectContaining({ provider: "deepseek-web" }),
      expect.objectContaining({ provider: "deepseek-web", tabId: "tab-1" }),
    ]);
  });

  it("uses x-web-providers-session-id to reuse the same bound tab across public provider chat requests", async () => {
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
        resetProvider: async () => undefined,
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) =>
          messageResponse(`reply:${prompt}`),
      } as never,
    });

    for (const prompt of ["one", "two"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/provider/chat",
        headers: {
          authorization: "Bearer test-token",
          "x-web-providers-session-id": "public-session-a",
        },
        payload: {
          provider: "deepseek-web",
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: prompt }],
        },
      });

      expect(response.statusCode).toBe(200);
    }

    expect(bindCalls).toEqual([
      expect.objectContaining({ provider: "deepseek-web", openNew: true }),
      expect.objectContaining({ provider: "deepseek-web", tabId: "tab-1" }),
    ]);
  });

  it("does not reopen a new tab when rebinding the existing session fails with a non-stale error", async () => {
    const bindCalls: Array<Record<string, unknown>> = [];

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        getProviderTabUrl: async () => "https://chat.deepseek.com/",
        bindProviderTab: async (input: {
          provider: string;
          tabId?: string;
          openNew?: boolean;
        }) => {
          bindCalls.push(input);

          if (!input.tabId) {
            return {
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
            };
          }

          throw new HelperError(
            "NOT_BOUND",
            "DeepSeek tab is still loading. Wait for the page to finish loading and retry.",
          );
        },
        resetProvider: async () => undefined,
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) =>
          messageResponse(`reply:${prompt}`),
      } as never,
    });

    const firstResponse = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: {
        authorization: "Bearer test-token",
        "x-web-providers-session-id": "public-session-a",
      },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "one" }],
      },
    });

    const secondResponse = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: {
        authorization: "Bearer test-token",
        "x-web-providers-session-id": "public-session-a",
      },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "two" }],
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json()).toEqual({
      error: "NOT_BOUND",
      message: "DeepSeek tab is still loading. Wait for the page to finish loading and retry.",
    });
    expect(bindCalls).toEqual([
      expect.objectContaining({ provider: "deepseek-web", openNew: true }),
      expect.objectContaining({ provider: "deepseek-web", tabId: "tab-1" }),
    ]);
  });

  it("opens a new tab with the remembered url when the tab id changes", async () => {
    const bindCalls: Array<Record<string, unknown>> = [];

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async (input: {
          provider: string;
          tabId?: string;
          openNew?: boolean;
          openUrl?: string;
          passive?: boolean;
        }) => {
          bindCalls.push(input);

          if (input.openNew || input.passive) {
            return {
              tabId: "tab-1",
              url: "https://chat.deepseek.com/a/chat/s/session-1",
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

          if (input.tabId) {
            throw new Error("Tab not found: tab-1");
          }

          return {
            tabId: "tab-2",
            url: input.openUrl ?? "https://chat.deepseek.com/a/chat/s/session-1",
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
        resetProvider: async () => undefined,
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) =>
          messageResponse(`reply:${prompt}`),
      } as never,
    });

    for (const prompt of ["one", "two"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/provider/chat",
        headers: {
          authorization: "Bearer test-token",
          "x-web-providers-session-id": "public-session-a",
        },
        payload: {
          provider: "deepseek-web",
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: prompt }],
        },
      });

      expect(response.statusCode).toBe(200);
    }

    expect(bindCalls).toEqual([
      expect.objectContaining({ provider: "deepseek-web", openNew: true }),
      expect.objectContaining({ provider: "deepseek-web", tabId: "tab-1" }),
      expect.objectContaining({
        provider: "deepseek-web",
        openNew: true,
        openUrl: "https://chat.deepseek.com/a/chat/s/session-1",
      }),
    ]);
  });

  it("keeps DeepSeek bindings isolated by model within the same session", async () => {
    const bindCalls: Array<Record<string, unknown>> = [];
    let tabCount = 0;

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
              url: input.tabId === "tab-1"
                ? "https://chat.deepseek.com/a/chat/s/model-chat"
                : "https://chat.deepseek.com/a/chat/s/model-tools",
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

          tabCount += 1;
          return {
            tabId: `tab-${tabCount}`,
            url:
              tabCount === 1
                ? "https://chat.deepseek.com/a/chat/s/model-chat"
                : "https://chat.deepseek.com/a/chat/s/model-tools",
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
        resetProvider: async () => undefined,
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) =>
          messageResponse(`reply:${prompt}`),
      } as never,
    });

    for (const model of [
      "deepseek-web-chat",
      "deepseek-web-tools",
      "deepseek-web-chat",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/provider/chat",
        headers: {
          authorization: "Bearer test-token",
          "x-web-providers-session-id": "public-session-a",
        },
        payload: {
          provider: "deepseek-web",
          model,
          messages: [{ role: "user", content: model }],
        },
      });

      expect(response.statusCode).toBe(200);
    }

    expect(bindCalls).toEqual([
      expect.objectContaining({ provider: "deepseek-web", openNew: true }),
      expect.objectContaining({ provider: "deepseek-web", openNew: true }),
      expect.objectContaining({ provider: "deepseek-web", tabId: "tab-1" }),
    ]);
  });

  it("requires provider on provider chat requests and stores debug state per provider", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async () => ({
          tabId: "tab-qwen",
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
        resetProvider: async () => undefined,
        startNewChat: async () => undefined,
        sendChatPrompt: async () =>
          messageResponse("qwen:hello", {
            modelLabel: "Qwen Web",
          }),
      } as never,
    });

    const bindResponse = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "qwen-web" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: {
        authorization: "Bearer test-token",
      },
      payload: {
        provider: "qwen-web",
        model: "qwen-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    const debugResponse = await app.inject({
      method: "GET",
      url: "/v1/debug/provider-last?provider=qwen-web",
    });

    expect(bindResponse.statusCode).toBe(200);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: "text",
      outputText: "qwen:hello",
      modelLabel: "Qwen Web",
    });
    expect(debugResponse.statusCode).toBe(200);
    expect(debugResponse.json()).toMatchObject({
      provider: "qwen-web",
      rawRequest: expect.objectContaining({
        provider: "qwen-web",
        model: "qwen-web-chat",
      }),
    });
  });

  it("retries a stale remembered tab id reported as NOT_BOUND without opening a fresh tab first", async () => {
    const bindCalls: Array<{
      provider: string;
      tabId?: string;
      openNew?: boolean;
      openUrl?: string;
    }> = [];

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async (input: {
          provider: string;
          tabId?: string;
          openNew?: boolean;
          openUrl?: string;
          passive?: boolean;
        }) => {
          bindCalls.push(input);

          if (input.openNew || input.passive) {
            return {
              tabId: "tab-1",
              url: "https://chat.deepseek.com/a/chat/s/session-1",
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

          if (input.tabId) {
            throw new HelperError(
              "NOT_BOUND",
              "No browser tab is available for tab-1",
            );
          }

          return {
            tabId: "tab-2",
            url: input.openUrl ?? "https://chat.deepseek.com/a/chat/s/session-1",
            loginState: "logged_in",
            bridgeInjected: true,
            pageState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: null,
              assistantCount: 0,
              blockingMessage: null,
            },
          };
        },
        resetProvider: async () => undefined,
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) =>
          messageResponse(`reply:${prompt}`),
      } as never,
    });

    for (const prompt of ["one", "two"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/provider/chat",
        headers: {
          authorization: "Bearer test-token",
          "x-web-providers-session-id": "public-session-stale-not-bound",
        },
        payload: {
          provider: "deepseek-web",
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: prompt }],
        },
      });

      expect(response.statusCode).toBe(200);
    }

    expect(bindCalls).toEqual([
      expect.objectContaining({ provider: "deepseek-web", openNew: true }),
      expect.objectContaining({ provider: "deepseek-web", tabId: "tab-1" }),
      expect.objectContaining({
        provider: "deepseek-web",
        openNew: true,
        openUrl: "https://chat.deepseek.com/a/chat/s/session-1",
      }),
    ]);
  });

  it("accepts provider messages and returns structured text output", async () => {
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
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) =>
          messageResponse(`reply:${prompt}`, {
            debug: {
              source: "bridge_dom_fallback",
              freshSession: false,
              completionObserved: false,
            },
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
      mode: "text",
      outputText: "reply:hello",
      finishReason: "stop",
      modelLabel: "DeepSeek Web",
    });
  });

  it("preserves thinking text on structured text output", async () => {
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
        startNewChat: async () => undefined,
        sendChatPrompt: async () =>
          messageResponse("final answer", {
            thinkingText: "think step",
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
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mode: "text",
      thinkingText: "think step",
      outputText: "final answer",
      finishReason: "stop",
      modelLabel: "DeepSeek Web",
    });
  });

  it("accepts provider messages and returns structured tool-call output", async () => {
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
        startNewChat: async () => undefined,
        sendChatPrompt: async () => ({
          mode: "json_fallback",
          toolCalls: [
            {
              name: "read",
              argumentsJson: "{\"path\":\"src/index.ts\"}",
            },
          ],
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
        messages: [{ role: "user", content: "read src/index.ts" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mode: "json_fallback",
      toolCalls: [
        {
          name: "read",
          argumentsJson: "{\"path\":\"src/index.ts\"}",
        },
      ],
      finishReason: "stop",
      modelLabel: "DeepSeek Web",
    });
  });

  it("repairs an invalid structured response within the same provider chat", async () => {
    const prompts: string[] = [];
    let freshChatCount = 0;

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
        startNewChat: async () => {
          freshChatCount += 1;
        },
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          if (prompts.length === 1) {
            return {
              mode: "json_fallback",
              toolCalls: [],
              modelLabel: "DeepSeek Web",
            };
          }

          return {
            mode: "text",
            outputText: "{\"type\":\"message\",\"content\":\"fixed answer\"}",
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

    const response = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: {
        authorization: "Bearer test-token",
      },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          prompt: "You are terse.",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mode: "text",
      outputText: "fixed answer",
      finishReason: "stop",
      modelLabel: "DeepSeek Web",
    });
    expect(freshChatCount).toBe(1);
    expect(prompts[0]).toBe("You are terse.\n\nhello");
    expect(prompts[1]).toContain(JSON_PROTOCOL_REPAIR_HEADER);
    expect(prompts[1]).toContain(JSON_PROTOCOL_REPAIR_REQUIREMENT);
    expect(prompts[1]).toContain(JSON_PROTOCOL_REPAIR_ACTION_RULE);
    expect(prompts[1]).toContain("toolCalls must be a non-empty array");
  });

  it("repairs plain-text provider replies into the required json envelope even without tools", async () => {
    const prompts: string[] = [];

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
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          if (prompts.length === 1) {
            return {
              mode: "text",
              outputText: "hello",
              modelLabel: "DeepSeek Web",
            };
          }

          return {
            mode: "text",
            outputText: "{\"type\":\"message\",\"content\":\"fixed answer\"}",
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

    const response = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: {
        authorization: "Bearer test-token",
      },
      payload: {
        model: "deepseek-web-pro",
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          prompt: "You must answer with one JSON object.",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mode: "text",
      outputText: "fixed answer",
      finishReason: "stop",
      modelLabel: "DeepSeek Web",
    });
    expect(prompts[1]).toContain(JSON_PROTOCOL_REPAIR_HEADER);
    expect(prompts[1]).toContain(JSON_PROTOCOL_REPAIR_REQUIREMENT);
    expect(prompts[1]).toContain(JSON_PROTOCOL_REPAIR_ACTION_RULE);
    expect(prompts[1]).toContain("上一条无效回复：");
    expect(prompts[1]).toContain("hello");
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
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          capturedPrompt = prompt;
          return messageResponse("ok");
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

  it("starts a fresh provider chat and prepends initialization prompt on first turn", async () => {
    let capturedPrompt = "";
    let freshChatCount = 0;

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
        startNewChat: async () => {
          freshChatCount += 1;
        },
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          capturedPrompt = prompt;
          return messageResponse("ok");
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
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          prompt: "You are terse.",
        },
      },
    });

    expect(freshChatCount).toBe(1);
    expect(capturedPrompt).toBe("You are terse.\n\nhello");
  });

  it("starts a fresh DeepSeek pro chat on the first turn even without sessionInit", async () => {
    let capturedPrompt = "";
    const startNewChatCalls: Array<{ provider: string; tabId: string; modelId?: string }> = [];

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
        startNewChat: async (input: {
          provider: string;
          tabId: string;
          modelId?: string;
        }) => {
          startNewChatCalls.push(input);
        },
        sendChatPrompt: async ({
          prompt,
          freshSession,
        }: {
          prompt: string;
          freshSession?: boolean;
        }) => {
          capturedPrompt = prompt;
          expect(freshSession).toBe(true);
          return messageResponse("ok");
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
        model: "deepseek-web-pro",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(startNewChatCalls).toEqual(["tab-1"]);
    expect(capturedPrompt).toBe("hello");
  });

  it("reuses the current provider chat on repeated initialized requests", async () => {
    const prompts: string[] = [];
    let freshChatCount = 0;

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
        startNewChat: async () => {
          freshChatCount += 1;
        },
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return messageResponse("ok");
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
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          prompt: "You are terse.",
        },
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "continue" }],
        sessionInit: {
          prompt: "You are terse.",
        },
      },
    });

    expect(freshChatCount).toBe(1);
    expect(prompts).toEqual(["You are terse.\n\nhello", "continue"]);
  });

  it("does not start a fresh provider chat when later requests change the initialization prompt", async () => {
    const prompts: string[] = [];
    let freshChatCount = 0;

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
        startNewChat: async () => {
          freshChatCount += 1;
        },
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return messageResponse("ok");
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
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          prompt: "You are terse.",
        },
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello again" }],
        sessionInit: {
          prompt: "You are detailed.",
        },
      },
    });

    expect(freshChatCount).toBe(1);
    expect(prompts).toEqual(["You are terse.\n\nhello", "hello again"]);
  });

  it("preserves provider initialization across repeated binds on the same tab", async () => {
    const prompts: string[] = [];
    let freshChatCount = 0;

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
        startNewChat: async () => {
          freshChatCount += 1;
        },
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return messageResponse("ok");
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
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          prompt: "You are terse.",
        },
      },
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
        messages: [{ role: "user", content: "continue" }],
        sessionInit: {
          prompt: "You are terse.",
        },
      },
    });

    expect(freshChatCount).toBe(1);
    expect(prompts).toEqual(["You are terse.\n\nhello", "continue"]);
  });

  it("preserves provider initialization when the same tab URL changes between binds", async () => {
    const prompts: string[] = [];
    let freshChatCount = 0;
    let bindCount = 0;

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindDeepSeekTab: async () => {
          bindCount += 1;
          return {
            tabId: "tab-1",
            url:
              bindCount === 1
                ? "https://chat.deepseek.com/"
                : "https://chat.deepseek.com/a/chat/some-conversation-id",
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
        resetPageBridge: async () => undefined,
        startNewChat: async () => {
          freshChatCount += 1;
        },
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return messageResponse("ok");
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
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          prompt: "You are terse.",
        },
      },
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
        messages: [{ role: "user", content: "continue" }],
        sessionInit: {
          prompt: "You are terse.",
        },
      },
    });

    expect(freshChatCount).toBe(1);
    expect(prompts).toEqual(["You are terse.\n\nhello", "continue"]);
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
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) =>
          messageResponse(`reply:${prompt}`, {
            debug: {
              source: "bridge_dom_fallback",
              freshSession: false,
              completionObserved: false,
            },
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
        mode: "text",
        outputText: "reply:hello",
        finishReason: "stop",
        modelLabel: "DeepSeek Web",
      },
      automation: {
        source: "bridge_dom_fallback",
        freshSession: false,
        completionObserved: false,
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
        startNewChat: async () => undefined,
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

  it("accepts DeepSeek message envelopes preserved via rawOutputText", async () => {
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
        startNewChat: async () => undefined,
        sendChatPrompt: async () => ({
          mode: "text" as const,
          outputText: "Hey! What are you working on?",
          rawOutputText:
            "{\"type\":\"message\",\"content\":\"Hey! What are you working on?\"}",
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
      headers: { authorization: "Bearer test-token" },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hey" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mode: "text",
      outputText: "Hey! What are you working on?",
      finishReason: "stop",
      modelLabel: "DeepSeek Web",
    });
  });

  it("preserves automation debug when provider chat fails with HelperError", async () => {
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
        startNewChat: async () => undefined,
        sendChatPrompt: async () => {
          throw new HelperError("TIMEOUT", "The page did not finish streaming in time", {
            source: "client_error",
            freshSession: false,
            completionObserved: true,
            trace: [
              {
                phase: "poll",
                completionStatus: "finished",
                completionTurnPreview: "{\"",
              },
            ],
          });
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
      status: "failed",
      prompt: "hey",
      automation: {
        source: "client_error",
        freshSession: false,
        completionObserved: true,
        trace: [
          {
            phase: "poll",
            completionStatus: "finished",
            completionTurnPreview: "{\"",
          },
        ],
      },
      error: {
        code: "TIMEOUT",
        message: "The page did not finish streaming in time",
      },
    });
  });

  it("fails after three invalid structured repair attempts", async () => {
    const prompts: string[] = [];

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
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return {
            mode: "json_fallback",
            toolCalls: [],
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

    const response = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "INVALID_PROVIDER_RESPONSE",
      message: "Provider returned an invalid structured response after 3 repair attempts",
    });
    expect(prompts).toHaveLength(4);
    expect(prompts[1]).toContain("修复轮次：1。");
    expect(prompts[2]).toContain("修复轮次：2。");
    expect(prompts[3]).toContain("修复轮次：3。");
  });

  it("aborts the current provider request when the client aborts the HTTP request", async () => {
    let observedAbort = false;
    let requestCount = 0;

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
        startNewChat: async () => undefined,
        sendChatPrompt: async ({ signal }: { signal?: AbortSignal }) => {
          requestCount += 1;
          if (requestCount > 1) {
            return messageResponse("second request ok");
          }

          if (signal?.aborted) {
            observedAbort = true;
            throw new Error("Operation aborted");
          }

          return await new Promise((resolve, reject) => {
            const onAbort = () => {
              observedAbort = true;
              reject(new Error("Operation aborted"));
            };

            signal?.addEventListener("abort", onAbort, { once: true });
          });
        },
      } as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine test server address");
    }

    const controller = new AbortController();
    const abortedRequest = fetch(
      `http://127.0.0.1:${address.port}/v1/provider/chat`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: "abort me" }],
        }),
        signal: controller.signal,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await abortedRequest.catch(() => undefined);

    for (let attempt = 0; attempt < 20 && !observedAbort; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(observedAbort).toBe(true);

    const secondRequest = app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "run next" }],
      },
    });

    const secondResponse = await secondRequest;
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toMatchObject({
      mode: "text",
      outputText: "second request ok",
    });

    await app.close();
  });
});
