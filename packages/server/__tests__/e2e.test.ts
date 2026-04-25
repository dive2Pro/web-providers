import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { HelperError } from "../src/errors";

function createMockBrowserClient(opts: {
  bindDelayMs?: number;
  failBindCount?: number;
  connectionStatus?: "connected" | "disconnected";
} = {}) {
  const { bindDelayMs = 0, failBindCount = 0, connectionStatus = "connected" } = opts;
  let bindAttempts = 0;

  return {
    getConnectionStatus: async () => connectionStatus as "connected" | "disconnected",
    bindProviderTab: async ({ provider }: { provider: string }) => {
      bindAttempts++;
      if (bindAttempts <= failBindCount) {
        throw new HelperError(
          "NOT_BOUND",
          `Opened ${provider === "deepseek-web" ? "DeepSeek" : "Qwen"} in bb-browser. Finish login in that page and retry.`,
        );
      }
      if (bindDelayMs > 0) {
        await new Promise((r) => setTimeout(r, bindDelayMs));
      }
      return {
        tabId: `tab-${provider}`,
        url: provider === "deepseek-web" ? "https://chat.deepseek.com/" : "https://chat.qwen.ai/",
        loginState: "logged_in" as const,
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
    resetPageBridge: async () => undefined,
    startNewChat: async () => undefined,
    sendChatPrompt: async ({ provider, prompt }: { provider: string; prompt: string }) => ({
      mode: "text" as const,
      outputText: `[${provider}] reply to: ${prompt}`,
      modelLabel: provider === "deepseek-web" ? "DeepSeek Web" : "Qwen Web",
    }),
  };
}

describe("server e2e", () => {
  // ── Health ──────────────────────────────────────────────

  it("health returns ok with connection status", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient(),
    } as never);

    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer test-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      browser: "connected",
      bindState: "unbound",
    });
  });

  it("health reports browser disconnected when transport fails", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient({ connectionStatus: "disconnected" }),
    } as never);

    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer test-token" },
    });

    expect(res.json()).toMatchObject({ browser: "disconnected" });
  });

  // ── Auth ────────────────────────────────────────────────

  it("returns 401 when authorization header is missing", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient(),
    } as never);

    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when token is wrong", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient(),
    } as never);

    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("debug endpoint does not require auth", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient(),
    } as never);

    const res = await app.inject({
      method: "GET",
      url: "/v1/debug/provider-last",
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Bind & Retry ────────────────────────────────────────

  it("retries bind after NOT_BOUND and succeeds on second attempt", async () => {
    // 模拟：第一次 bind 因为页面还没初始化好而失败，重试后成功
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient({ failBindCount: 1 }),
    } as never);

    // 第一次 bind — 页面还在初始化
    const first = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });

    expect(first.statusCode).toBe(409);
    expect(first.json().error).toBe("NOT_BOUND");
    expect(first.json().message).toContain("Finish login");

    // 第二次 bind — 页面已经就绪
    const second = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      tabId: "tab-deepseek-web",
      loginState: "logged_in",
      bridgeInjected: true,
    });
  });

  it("retries bind three times before succeeding (slow page init)", async () => {
    // 模拟页面初始化较慢，需要多次重试
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient({ failBindCount: 3 }),
    } as never);

    // Attempts 1-3: NOT_BOUND
    for (let i = 1; i <= 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/bind",
        headers: { authorization: "Bearer test-token" },
        payload: { provider: "deepseek-web" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("NOT_BOUND");
    }

    // Attempt 4: success
    const res = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tabId).toBe("tab-deepseek-web");
  });

  it("retains NOT_BOUND state when bind keeps failing", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindProviderTab: async () => {
          throw new HelperError("NOT_BOUND", "No logged-in DeepSeek tab is available");
        },
      } as never,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "NOT_BOUND",
      message: "No logged-in DeepSeek tab is available",
    });

    // 健康检查应反映未绑定状态
    const health = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer test-token" },
    });
    expect(health.json().bindState).toBe("unbound");
  });

  // ── Full lifecycle: bind → chat → debug ─────────────────

  it("completes full bind-chat-debug lifecycle", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient(),
    } as never);

    // 1. Bind
    const bind = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });
    expect(bind.statusCode).toBe(200);

    // 2. Provider chat
    const chat = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({
      mode: "text",
      outputText: "[deepseek-web] reply to: hello",
    });

    // 3. Debug (unauthenticated)
    const debug = await app.inject({
      method: "GET",
      url: "/v1/debug/provider-last?provider=deepseek-web",
    });
    expect(debug.statusCode).toBe(200);
    expect(debug.json()).toHaveProperty("provider", "deepseek-web");
    expect(debug.json()).toHaveProperty("rawRequest");
    expect(debug.json()).toHaveProperty("session");
  });

  it("returns NOT_BOUND for chat before bind", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient(),
    } as never);

    const res = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NOT_BOUND");
  });

  // ── Multi-provider isolation ────────────────────────────

  it("isolates bind state across providers", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient(),
    } as never);

    // Bind deepseek
    const dsBind = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });
    expect(dsBind.statusCode).toBe(200);
    expect(dsBind.json().tabId).toBe("tab-deepseek-web");

    // Bind qwen
    const qwBind = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "qwen-web" },
    });
    expect(qwBind.statusCode).toBe(200);
    expect(qwBind.json().tabId).toBe("tab-qwen-web");

    // Health shows bound
    const health = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer test-token" },
    });
    expect(health.json().bindState).toBe("bound");

    // Chat each provider independently
    const dsChat = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "ds question" }],
      },
    });
    expect(dsChat.json().outputText).toContain("[deepseek-web]");

    const qwChat = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "qwen-web",
        model: "qwen-web-chat",
        messages: [{ role: "user", content: "qw question" }],
      },
    });
    expect(qwChat.json().outputText).toContain("[qwen-web]");
  });

  it("provider-specific debug records are isolated", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient(),
    } as never);

    // Bind both providers
    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "qwen-web" },
    });

    // Chat deepseek
    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "ds" }],
      },
    });

    // Chat qwen
    await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "qwen-web",
        model: "qwen-web-chat",
        messages: [{ role: "user", content: "qw" }],
      },
    });

    // DeepSeek debug shows deepseek chat
    const dsDebug = await app.inject({
      method: "GET",
      url: "/v1/debug/provider-last?provider=deepseek-web",
    });
    expect(dsDebug.json()).toHaveProperty("provider", "deepseek-web");

    // Qwen debug shows qwen chat
    const qwDebug = await app.inject({
      method: "GET",
      url: "/v1/debug/provider-last?provider=qwen-web",
    });
    expect(qwDebug.json()).toHaveProperty("provider", "qwen-web");
  });

  // ── Reset ───────────────────────────────────────────────

  it("reset clears bind state", async () => {
    const resetCalls: Array<{ provider: string; tabId: string }> = [];
    const app = buildApp({
      token: "test-token",
      browserClient: {
        ...createMockBrowserClient(),
        resetProvider: async ({ provider, tabId }: { provider: string; tabId: string }) => {
          resetCalls.push({ provider, tabId });
        },
      },
    } as never);

    // Bind
    const bind = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });
    expect(bind.statusCode).toBe(200);

    // Reset
    const reset = await app.inject({
      method: "POST",
      url: "/v1/reset",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ ok: true });
    expect(resetCalls).toEqual([{ provider: "deepseek-web", tabId: "tab-deepseek-web" }]);

    // Health shows unbound after reset
    const health = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer test-token" },
    });
    expect(health.json().bindState).toBe("unbound");
  });

  it("resetting one provider does not affect the other", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: createMockBrowserClient(),
    } as never);

    // Bind both
    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "qwen-web" },
    });

    // Reset only deepseek
    await app.inject({
      method: "POST",
      url: "/v1/reset",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });

    // Health still shows bound (qwen remains)
    const health = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer test-token" },
    });
    expect(health.json().bindState).toBe("bound");
  });

  // ── Error scenarios ─────────────────────────────────────

  it("returns PAGE_UNAVAILABLE when tab URL is unexpected", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindDeepSeekTab: async () => {
          throw new HelperError("PAGE_UNAVAILABLE", "Page URL does not match expected");
        },
      } as never,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "PAGE_UNAVAILABLE",
    });
  });

  it("returns PAGE_UNAVAILABLE for chat when tab becomes stale", async () => {
    let chatCalls = 0;
    const app = buildApp({
      token: "test-token",
      browserClient: {
        ...createMockBrowserClient(),
        sendChatPrompt: async () => {
          chatCalls++;
          throw new HelperError("PAGE_UNAVAILABLE", "Tab is no longer open");
        },
      },
    } as never);

    // Bind
    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });

    // Chat fails with PAGE_UNAVAILABLE
    const chat = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(chat.statusCode).toBe(409);
    expect(chat.json().error).toBe("PAGE_UNAVAILABLE");
    expect(chatCalls).toBe(1);
  });

  it("returns MODEL_BUSY when provider is occupied", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        ...createMockBrowserClient(),
        sendChatPrompt: async () => {
          throw new HelperError("MODEL_BUSY", "Another completion is already in progress");
        },
      },
    } as never);

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
      payload: { provider: "deepseek-web" },
    });

    const chat = await app.inject({
      method: "POST",
      url: "/v1/provider/chat",
      headers: { authorization: "Bearer test-token" },
      payload: {
        provider: "deepseek-web",
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(chat.statusCode).toBe(409);
    expect(chat.json().error).toBe("MODEL_BUSY");
  });
});
