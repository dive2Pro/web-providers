import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { HelperError } from "../src/errors";

describe("provider chat route", () => {
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
        sendChatPrompt: async () => ({
          mode: "text",
          outputText: "qwen:hello",
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
        sendChatPrompt: async ({ prompt }: { prompt: string }) => ({
          mode: "text",
          outputText: `reply:${prompt}`,
          debug: {
            source: "bridge_dom_fallback",
            freshSession: false,
            completionObserved: false,
          },
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
        sendChatPrompt: async () => ({
          mode: "text",
          thinkingText: "think step",
          outputText: "final answer",
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
        sendChatPrompt: async () => ({
          mode: "json_fallback",
          toolCall: {
            name: "read",
            argumentsJson: "{\"path\":\"src/index.ts\"}",
          },
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
      toolCall: {
        name: "read",
        argumentsJson: "{\"path\":\"src/index.ts\"}",
      },
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
            mode: "text",
            outputText: "ok",
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
          return {
            mode: "text",
            outputText: "ok",
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
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          fingerprint: "fp-1",
          sessionKey: "session-1",
          prompt: "You are terse.",
        },
      },
    });

    expect(freshChatCount).toBe(1);
    expect(capturedPrompt).toBe("You are terse.\n\nhello");
  });

  it("reuses the current provider chat when the initialization fingerprint is unchanged", async () => {
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
          return {
            mode: "text",
            outputText: "ok",
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
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          fingerprint: "fp-1",
          sessionKey: "session-1",
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
          fingerprint: "fp-1",
          sessionKey: "session-1",
          prompt: "You are terse.",
        },
      },
    });

    expect(freshChatCount).toBe(1);
    expect(prompts).toEqual(["You are terse.\n\nhello", "continue"]);
  });

  it("starts a fresh provider chat when the session key changes even if the fingerprint is unchanged", async () => {
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
          return {
            mode: "text",
            outputText: "ok",
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
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          fingerprint: "fp-1",
          sessionKey: "session-1",
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
          fingerprint: "fp-1",
          sessionKey: "session-2",
          prompt: "You are terse.",
        },
      },
    });

    expect(freshChatCount).toBe(2);
    expect(prompts).toEqual(["You are terse.\n\nhello", "You are terse.\n\nhello again"]);
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
          return {
            mode: "text",
            outputText: "ok",
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
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          fingerprint: "fp-1",
          sessionKey: "session-1",
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
          fingerprint: "fp-1",
          sessionKey: "session-1",
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
          return {
            mode: "text",
            outputText: "ok",
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
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          fingerprint: "fp-1",
          sessionKey: "session-1",
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
          fingerprint: "fp-1",
          sessionKey: "session-1",
          prompt: "You are terse.",
        },
      },
    });

    expect(freshChatCount).toBe(1);
    expect(prompts).toEqual(["You are terse.\n\nhello", "continue"]);
  });

  it("rebinds to the current fresh DeepSeek tab instead of rediscovering a stale one", async () => {
    const prompts: string[] = [];
    const bindPreferredTabIds: Array<string | undefined> = [];
    let freshChatCount = 0;

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async ({
          provider,
          preferredTabId,
        }: {
          provider: string;
          preferredTabId?: string;
        }) => {
          bindPreferredTabIds.push(preferredTabId);
          const tabId = preferredTabId === "tab-fresh" ? "tab-fresh" : "tab-stale";
          return {
            tabId,
            url:
              provider === "deepseek-web"
                ? `https://chat.deepseek.com/a/chat/${tabId}`
                : "https://chat.qwen.ai/",
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
          return { tabId: "tab-fresh" };
        },
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return {
            mode: "text",
            outputText: "ok",
            modelLabel: "DeepSeek Web",
          };
        },
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
        messages: [{ role: "user", content: "hello" }],
        sessionInit: {
          fingerprint: "fp-1",
          sessionKey: "session-1",
          prompt: "You are terse.",
        },
      },
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
        messages: [{ role: "user", content: "continue" }],
        sessionInit: {
          fingerprint: "fp-1",
          sessionKey: "session-1",
          prompt: "You are terse.",
        },
      },
    });

    expect(bindPreferredTabIds).toEqual([undefined, "tab-fresh"]);
    expect(freshChatCount).toBe(1);
    expect(prompts).toEqual(["You are terse.\n\nhello", "continue"]);
  });

  it("isolates bound tabs and initialization state by pi session id", async () => {
    const prompts: string[] = [];
    const bindPreferredTabIds: Array<string | undefined> = [];
    let bindCount = 0;
    let freshChatCount = 0;

    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async ({
          provider,
          preferredTabId,
        }: {
          provider: string;
          preferredTabId?: string;
        }) => {
          bindPreferredTabIds.push(preferredTabId);
          bindCount += 1;
          const tabId =
            preferredTabId ??
            (bindCount === 1 ? "tab-session-a" : "tab-session-b");
          return {
            tabId,
            url:
              provider === "deepseek-web"
                ? `https://chat.deepseek.com/a/chat/${tabId}`
                : "https://chat.qwen.ai/",
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
          return undefined;
        },
        sendChatPrompt: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return {
            mode: "text",
            outputText: "ok",
            modelLabel: "DeepSeek Web",
          };
        },
      } as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web", piSessionId: "pi-session-a" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "deepseek-web",
        piSessionId: "pi-session-a",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello from a" }],
        sessionInit: {
          fingerprint: "fp-a",
          sessionKey: "session-a",
          prompt: "You are terse.",
        },
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web", piSessionId: "pi-session-b" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "deepseek-web",
        piSessionId: "pi-session-b",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello from b" }],
        sessionInit: {
          fingerprint: "fp-b",
          sessionKey: "session-b",
          prompt: "You are terse.",
        },
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web", piSessionId: "pi-session-a" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "deepseek-web",
        piSessionId: "pi-session-a",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "continue a" }],
        sessionInit: {
          fingerprint: "fp-a",
          sessionKey: "session-a",
          prompt: "You are terse.",
        },
      },
    });

    expect(bindPreferredTabIds).toEqual([undefined, undefined, "tab-session-a"]);
    expect(freshChatCount).toBe(2);
    expect(prompts).toEqual([
      "You are terse.\n\nhello from a",
      "You are terse.\n\nhello from b",
      "continue a",
    ]);
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
          mode: "text",
          outputText: `reply:${prompt}`,
          debug: {
            source: "bridge_dom_fallback",
            freshSession: false,
            completionObserved: false,
          },
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
});
