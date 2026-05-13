import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/helper/app";

describe("helper app", () => {
  const requestLogDirs: string[] = [];
  const sessionBindingDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      requestLogDirs.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
    await Promise.all(
      sessionBindingDirs.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

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
      headers: { authorization: "Bearer test-token", "x-web-providers-session-id": "session-a" },
      payload: { provider: "deepseek-web" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token", "x-web-providers-session-id": "session-a" },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token", "x-web-providers-session-id": "session-a" },
      payload: { provider: "qwen-web" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token", "x-web-providers-session-id": "session-a" },
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

  it("logs request headers and body for helper routes", async () => {
    const requestLogger = vi.fn();
    const app = buildApp({
      token: "test-token",
      requestLogger,
      browserClient: {
        bindProviderTab: async () => ({
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
        getConnectionStatus: async () => "connected",
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: {
        authorization: "Bearer test-token",
        "x-web-providers-session-id": "session-a",
        "x-request-source": "helper-test",
      },
      payload: {
        provider: "deepseek-web",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(requestLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "helper",
        method: "POST",
        url: "/v1/bind",
        routePath: "/v1/bind",
        statusCode: 200,
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
          "x-web-providers-session-id": "session-a",
          "x-request-source": "helper-test",
        }),
        body: {
          provider: "deepseek-web",
        },
      }),
    );
  });

  it("persists request logs locally and exposes them via api", async () => {
    const requestLogDir = await mkdtemp(
      join(tmpdir(), "web-providers-helper-logs-"),
    );
    requestLogDirs.push(requestLogDir);

    const app = buildApp({
      token: "test-token",
      requestLogDir,
      browserClient: {
        bindProviderTab: async () => ({
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
        getConnectionStatus: async () => "connected",
      } as never,
    });

    const postResponse = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: {
        authorization: "Bearer test-token",
        "x-web-providers-session-id": "session-a",
        "x-request-source": "helper-api-test",
      },
      payload: {
        provider: "deepseek-web",
      },
    });

    expect(postResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/v1/debug/request-logs?limit=5",
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "helper",
      filePath: expect.stringContaining("helper.ndjson"),
      logs: [
        expect.objectContaining({
          scope: "helper",
          method: "POST",
          url: "/v1/bind",
          headers: expect.objectContaining({
            authorization: "Bearer test-token",
            "x-web-providers-session-id": "session-a",
            "x-request-source": "helper-api-test",
          }),
          body: {
            provider: "deepseek-web",
          },
        }),
      ],
    });
  });

  it("exposes session to provider to tab bindings via authenticated debug api", async () => {
    let nextTabId = 0;
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async (input: {
          provider: string;
          tabId?: string;
          openNew?: boolean;
        }) => ({
          tabId: input.tabId ?? `tab-${++nextTabId}`,
          url:
            input.provider === "qwen-web"
              ? "https://chat.qwen.ai/"
              : "https://chat.deepseek.com/",
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
        sendChatPrompt: async ({ provider, prompt }: { provider?: string; prompt: string }) => ({
          mode: "text",
          outputText: JSON.stringify({
            type: "message",
            content: `${provider}:${prompt}`,
          }),
          modelLabel: provider === "qwen-web" ? "Qwen Web" : "DeepSeek Web",
        }),
      } as never,
    });

    const publicResponse = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: {
        authorization: "Bearer test-token",
        "x-web-providers-session-id": "public-session-a",
      },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    const piResponse = await app.inject({
      method: "POST",
      url: "/internal/pi/provider/chat",
      headers: {
        authorization: "Bearer test-token",
        "x-pi-session-id": "pi-session-a",
      },
      payload: {
        provider: "qwen-web",
        model: "qwen-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    const debugResponse = await app.inject({
      method: "GET",
      url: "/v1/debug/session-bindings",
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(publicResponse.statusCode).toBe(200);
    expect(piResponse.statusCode).toBe(200);
    expect(debugResponse.statusCode).toBe(200);
    expect(debugResponse.json()).toEqual({
      sessions: [
        {
          sessionId: "pi-session-a",
          createdAt: expect.any(String),
          lastSeenAt: expect.any(String),
          bindings: [
            {
              bindingKey: "qwen-web",
              provider: "qwen-web",
              modelId: null,
              tabId: "tab-2",
              tabUrl: "https://chat.qwen.ai/",
              conversationId: "conv-qwen-web-tab-2",
              loginState: "logged_in",
              bridgeInjected: true,
              providerInitialized: false,
            },
          ],
          providers: {
            "qwen-web": {
              tabId: "tab-2",
              tabUrl: "https://chat.qwen.ai/",
              conversationId: "conv-qwen-web-tab-2",
              loginState: "logged_in",
              bridgeInjected: true,
            },
          },
        },
        {
          sessionId: "public-session-a",
          createdAt: expect.any(String),
          lastSeenAt: expect.any(String),
          bindings: [
            {
              bindingKey: "deepseek-web::deepseek-web-chat",
              provider: "deepseek-web",
              modelId: "deepseek-web-chat",
              tabId: "tab-1",
              tabUrl: "https://chat.deepseek.com/",
              conversationId: "conv-tab-1",
              loginState: "logged_in",
              bridgeInjected: true,
              providerInitialized: true,
            },
          ],
          providers: {
            "deepseek-web": {
              tabId: "tab-1",
              tabUrl: "https://chat.deepseek.com/",
              conversationId: "conv-tab-1",
              loginState: "logged_in",
              bridgeInjected: true,
            },
          },
        },
      ],
    });
  });

  it("restores persisted session bindings and rebinds by remembered url after restart", async () => {
    const sessionBindingDir = await mkdtemp(
      join(tmpdir(), "web-providers-helper-bindings-"),
    );
    sessionBindingDirs.push(sessionBindingDir);

    const firstApp = buildApp({
      token: "test-token",
      sessionBindingDir,
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async () => ({
          tabId: "tab-1",
          url: "https://chat.deepseek.com/a/chat/s/persisted-session",
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
        sendChatPrompt: async ({ prompt }: { prompt: string }) => ({
          mode: "text",
          outputText: JSON.stringify({
            type: "message",
            content: `reply:${prompt}`,
          }),
          modelLabel: "DeepSeek Web",
        }),
      } as never,
    });

    const firstResponse = await firstApp.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: {
        authorization: "Bearer test-token",
        "x-web-providers-session-id": "persisted-session-a",
      },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "one" }],
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    await firstApp.close();

    const bindCalls: Array<Record<string, unknown>> = [];
    const restartedApp = buildApp({
      token: "test-token",
      sessionBindingDir,
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async (input: {
          provider: string;
          tabId?: string;
          openUrl?: string;
        }) => {
          bindCalls.push(input);

          if (input.tabId) {
            throw new Error(`Tab not found: ${input.tabId}`);
          }

          return {
            tabId: "tab-2",
            url: input.openUrl ?? "https://chat.deepseek.com/a/chat/s/persisted-session",
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
        sendChatPrompt: async ({ prompt }: { prompt: string }) => ({
          mode: "text",
          outputText: JSON.stringify({
            type: "message",
            content: `reply:${prompt}`,
          }),
          modelLabel: "DeepSeek Web",
        }),
      } as never,
    });

    const secondResponse = await restartedApp.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: {
        authorization: "Bearer test-token",
        "x-web-providers-session-id": "persisted-session-a",
      },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "two" }],
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(bindCalls).toEqual([
      {
        provider: "deepseek-web",
        openNew: undefined,
        openUrl: undefined,
        tabId: "tab-1",
      },
      {
        provider: "deepseek-web",
        openNew: true,
        openUrl: "https://chat.deepseek.com/a/chat/s/persisted-session",
        tabId: undefined,
      },
    ]);

    await restartedApp.close();
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
