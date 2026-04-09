# Qwen Multi-Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the DeepSeek-only web bridge into a single-helper multi-provider architecture that exposes `deepseek-web` and `qwen-web` separately and adds a first `chat.qwen.ai` adapter.

**Architecture:** Make helper contracts, helper state, and helper routes explicitly provider-aware; migrate existing DeepSeek browser logic behind a provider adapter interface; register multiple extension providers from one shared runtime; then add a minimal Qwen adapter that supports binding and text turns through the same provider pipeline.

**Tech Stack:** TypeScript, Fastify, bb-browser, local helper process, provider adapter pattern, Vitest.

---

## File Structure

- `src/shared/contracts.ts`
  Generalize request contracts from DeepSeek-only literals to provider-aware request types.
- `src/helper/types.ts`
  Add provider-scoped session/debug types.
- `src/helper/state.ts`
  Replace single bound session/debug record storage with provider-keyed storage.
- `src/helper/providers/types.ts`
  Define the helper-side provider adapter interfaces and ids.
- `src/helper/providers/registry.ts`
  Register `deepseek-web` and `qwen-web` adapters.
- `src/helper/providers/deepseek/adapter.ts`
  Move DeepSeek-specific validation/bind/send logic behind the adapter contract.
- `src/helper/providers/deepseek/page-bridge.ts`
  Move the current DeepSeek page bridge under the provider folder.
- `src/helper/providers/qwen/adapter.ts`
  Implement the first Qwen adapter.
- `src/helper/providers/qwen/page-bridge.ts`
  Add the Qwen page bridge/evaluation helpers.
- `src/helper/browser/types.ts`
  Change the browser client interface from DeepSeek-only methods to provider-aware methods.
- `src/helper/browser/bb-browser-client.ts`
  Dispatch tab discovery, reset, send, and page eval through the provider registry.
- `src/helper/app.ts`
  Wire provider registry into the app context if needed.
- `src/helper/routes/bind.ts`
  Require `provider` and bind per provider slot.
- `src/helper/routes/provider-chat.ts`
  Require `provider` and dispatch through the adapter-selected session.
- `src/helper/routes/reset.ts`
  Reset one provider slot at a time.
- `src/helper/routes/debug-provider-last.ts`
  Expose provider-aware debug records.
- `src/extension/provider-runtime.ts`
  Register multiple providers from shared descriptors and send provider-aware helper requests.
- `tests/helper/bind-reset.test.ts`
  Cover provider-aware bind/reset isolation.
- `tests/helper/provider-chat.test.ts`
  Cover provider-aware route dispatch and multi-provider state.
- `tests/helper/app.test.ts`
  Cover provider-aware debug route shape if needed.
- `tests/extension/index.test.ts`
  Cover dual provider registration and provider-aware helper requests.
- `tests/helper/qwen-adapter.test.ts`
  Add Qwen-specific adapter tests.

### Task 1: Generalize Contracts and Helper State for Provider-Aware Routing

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/helper/types.ts`
- Modify: `src/helper/state.ts`
- Test: `tests/helper/bind-reset.test.ts`
- Test: `tests/helper/provider-chat.test.ts`

- [ ] **Step 1: Write the failing helper tests for provider-scoped state and request contracts**

```ts
// append to tests/helper/bind-reset.test.ts
it("keeps DeepSeek and Qwen binds isolated", async () => {
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
      resetProvider: async () => undefined,
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

  expect(deepseekReset.statusCode).toBe(200);
});

// append to tests/helper/provider-chat.test.ts
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
    },
  });

  await app.inject({
    method: "POST",
    url: "/v1/bind",
    headers: { authorization: "Bearer test-token" },
    payload: { provider: "qwen-web" },
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/provider/chat",
    headers: { authorization: "Bearer test-token" },
    payload: {
      provider: "qwen-web",
      model: "qwen-web-chat",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    mode: "text",
    outputText: "qwen:hello",
    modelLabel: "Qwen Web",
  });
});
```

- [ ] **Step 2: Run the helper tests to verify they fail**

Run: `npm test -- tests/helper/bind-reset.test.ts tests/helper/provider-chat.test.ts`
Expected: FAIL because bind/reset/provider chat requests do not yet accept `provider` and helper state only stores one bound session/debug record.

- [ ] **Step 3: Implement provider-aware contracts and helper state**

```ts
// replace the request contracts in src/shared/contracts.ts
export type ProviderId = "deepseek-web" | "qwen-web";

export interface BindRequest {
  provider: ProviderId;
}

export interface ResetRequest {
  provider: ProviderId;
}

export interface ProviderChatRequest {
  provider: ProviderId;
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  sessionInit?: {
    fingerprint: string;
    prompt: string;
  };
  temperature?: number;
  maxOutputTokens?: number;
  abortKey?: string;
}

// replace the session/debug types in src/helper/types.ts
export interface BoundSession {
  provider: ProviderId;
  tabId: string;
  url: string;
  loginState: "logged_in" | "logged_out";
  bridgeInjected: boolean;
  pageState: PageStateSummary;
  conversationId: string;
  providerInitialized: boolean;
  providerInitFingerprint: string | null;
}

export interface ProviderRequestDebugRecord {
  provider: ProviderId;
  requestId: string;
  rawRequest: ProviderChatRequest;
  normalizedMessages: ProviderChatRequest["messages"];
  prompt: string;
  session: {
    tabId: string;
    url: string;
  };
  startedAt: string;
  completedAt: string | null;
  status: "running" | "completed" | "failed";
  response: ProviderChatResponse | null;
  automation: SendChatAutomationDebug | null;
  error: {
    code: string;
    message: string;
  } | null;
}

// replace HelperState storage in src/helper/state.ts
export class HelperState {
  private boundSessions = new Map<ProviderId, BoundSession>();
  private activeRequest: ActiveRequest | null = null;
  private lastProviderRequests = new Map<ProviderId, ProviderRequestDebugRecord>();
  private degraded = false;
  private lastBridgeHeartbeatAt: string | null = null;

  getBoundSession(provider: ProviderId) {
    return this.boundSessions.get(provider) ?? null;
  }

  setBoundSession(provider: ProviderId, session: BoundSession | null) {
    if (session) {
      this.boundSessions.set(provider, session);
      return;
    }

    this.boundSessions.delete(provider);
  }

  getLastProviderRequest(provider: ProviderId) {
    return this.lastProviderRequests.get(provider) ?? null;
  }

  setLastProviderRequest(provider: ProviderId, record: ProviderRequestDebugRecord | null) {
    if (record) {
      this.lastProviderRequests.set(provider, record);
      return;
    }

    this.lastProviderRequests.delete(provider);
  }

  getAllLastProviderRequests() {
    return Object.fromEntries(this.lastProviderRequests.entries());
  }

  // keep activeRequest/degraded/heartbeat methods unchanged
}
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `npm test -- tests/helper/bind-reset.test.ts tests/helper/provider-chat.test.ts`
Expected: PASS with provider-aware request/state coverage green.

- [ ] **Step 5: Commit the provider-aware contract/state base**

```bash
git add src/shared/contracts.ts src/helper/types.ts src/helper/state.ts tests/helper/bind-reset.test.ts tests/helper/provider-chat.test.ts
git commit -m "refactor: make helper state and contracts provider aware"
```

### Task 2: Add Helper Provider Adapters and Migrate DeepSeek Behind the Interface

**Files:**
- Create: `src/helper/providers/types.ts`
- Create: `src/helper/providers/registry.ts`
- Create: `src/helper/providers/deepseek/adapter.ts`
- Create: `src/helper/providers/deepseek/page-bridge.ts`
- Modify: `src/helper/browser/types.ts`
- Modify: `src/helper/browser/bb-browser-client.ts`
- Test: `tests/helper/deepseek-page-bridge.test.ts`
- Test: `tests/helper/bb-browser-client.test.ts`

- [ ] **Step 1: Write failing DeepSeek adapter tests around provider dispatch**

```ts
// append to tests/helper/bb-browser-client.test.ts
it("finds and binds a DeepSeek tab through provider dispatch", async () => {
  const transport = {
    getConnectionStatus: async () => "connected",
    findProviderTab: async ({ provider }: { provider: string }) => ({
      id: provider === "deepseek-web" ? "tab-deepseek" : "tab-qwen",
      url:
        provider === "deepseek-web"
          ? "https://chat.deepseek.com/"
          : "https://chat.qwen.ai/",
    }),
    openProvider: async () => undefined,
    evaluate: async () => ({ ok: true }),
    submitPrompt: async () => undefined,
  };

  const client = createBrowserAutomationClient({ transport });
  const result = await client.bindProviderTab({ provider: "deepseek-web" });

  expect(result.url).toBe("https://chat.deepseek.com/");
});
```

- [ ] **Step 2: Run the browser helper tests to verify they fail**

Run: `npm test -- tests/helper/deepseek-page-bridge.test.ts tests/helper/bb-browser-client.test.ts`
Expected: FAIL because the browser client interface and implementation are still DeepSeek-only.

- [ ] **Step 3: Introduce adapter interfaces and migrate DeepSeek into the provider registry**

```ts
// create src/helper/providers/types.ts
import type { ProviderId } from "../../shared/contracts";
import type { BindResult, SendChatResult } from "../browser/types";

export interface ProviderAdapter {
  providerId: ProviderId;
  matchesTab(url: string): boolean;
  assertSupportedUrl(rawUrl: string): string;
  buildOpenUrl(): string;
  bind(tab: { id: string; url: string }): Promise<BindResult>;
  reset(tabId: string): Promise<void>;
  startNewChat(tabId: string): Promise<void>;
  sendChatPrompt(input: {
    tabId: string;
    prompt: string;
    timeoutMs: number;
    freshSession?: boolean;
  }): Promise<SendChatResult>;
}

// create src/helper/providers/registry.ts
import type { ProviderId } from "../../shared/contracts";
import type { ProviderAdapter } from "./types";
import { createDeepSeekAdapter } from "./deepseek/adapter";
import { createQwenAdapter } from "./qwen/adapter";

export function createProviderRegistry(deps: { transport: BbBrowserTransport }) {
  const adapters: Record<ProviderId, ProviderAdapter> = {
    "deepseek-web": createDeepSeekAdapter(deps),
    "qwen-web": createQwenAdapter(deps),
  };

  return {
    get(provider: ProviderId) {
      return adapters[provider];
    },
    list() {
      return Object.values(adapters);
    },
  };
}

// in src/helper/browser/types.ts, replace provider-specific methods
export interface BrowserAutomationClient {
  getConnectionStatus(): Promise<BrowserConnectionStatus>;
  bindProviderTab(input: { provider: ProviderId }): Promise<BindResult>;
  resetProvider(input: { provider: ProviderId; tabId: string }): Promise<void>;
  startNewChat(input: { provider: ProviderId; tabId: string }): Promise<void>;
  sendChatPrompt(input: {
    provider: ProviderId;
    tabId: string;
    prompt: string;
    timeoutMs: number;
    freshSession?: boolean;
  }): Promise<SendChatResult>;
}
```

- [ ] **Step 4: Run the browser helper tests to verify they pass**

Run: `npm test -- tests/helper/deepseek-page-bridge.test.ts tests/helper/bb-browser-client.test.ts`
Expected: PASS with DeepSeek behavior preserved behind the provider adapter abstraction.

- [ ] **Step 5: Commit the adapterized DeepSeek browser layer**

```bash
git add src/helper/providers src/helper/browser/types.ts src/helper/browser/bb-browser-client.ts tests/helper/deepseek-page-bridge.test.ts tests/helper/bb-browser-client.test.ts
git commit -m "refactor: move deepseek browser logic behind provider adapters"
```

### Task 3: Make Helper Routes Dispatch by Provider and Preserve DeepSeek Behavior

**Files:**
- Modify: `src/helper/app.ts`
- Modify: `src/helper/routes/bind.ts`
- Modify: `src/helper/routes/provider-chat.ts`
- Modify: `src/helper/routes/reset.ts`
- Modify: `src/helper/routes/debug-provider-last.ts`
- Test: `tests/helper/bind-reset.test.ts`
- Test: `tests/helper/provider-chat.test.ts`
- Test: `tests/helper/app.test.ts`

- [ ] **Step 1: Write failing route tests for provider dispatch and provider-specific debug state**

```ts
// append to tests/helper/app.test.ts
it("returns provider-keyed debug records when no filter is supplied", async () => {
  const app = buildApp({
    token: "test-token",
    browserClient: {
      getConnectionStatus: async () => "connected",
    },
  });

  app.context.state.setLastProviderRequest("deepseek-web", {
    provider: "deepseek-web",
    requestId: "req-1",
    rawRequest: {
      provider: "deepseek-web",
      model: "deepseek-web-chat",
      messages: [{ role: "user", content: "hi" }],
    },
    normalizedMessages: [{ role: "user", content: "hi" }],
    prompt: "hi",
    session: { tabId: "tab-1", url: "https://chat.deepseek.com/" },
    startedAt: "2026-04-09T00:00:00.000Z",
    completedAt: null,
    status: "running",
    response: null,
    automation: null,
    error: null,
  });

  const response = await app.inject({ method: "GET", url: "/v1/debug/provider-last" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    "deepseek-web": { provider: "deepseek-web", requestId: "req-1" },
  });
});
```

- [ ] **Step 2: Run the helper route tests to verify they fail**

Run: `npm test -- tests/helper/app.test.ts tests/helper/bind-reset.test.ts tests/helper/provider-chat.test.ts`
Expected: FAIL because routes and debug state still assume single-provider methods and payloads.

- [ ] **Step 3: Update routes to require provider and dispatch through provider-aware browser methods**

```ts
// replace bind route body in src/helper/routes/bind.ts
app.post("/v1/bind", async (request, reply) => {
  const body = request.body as BindRequest;

  try {
    const result = await ctx.browserClient.bindProviderTab({ provider: body.provider });
    const previousSession = ctx.state.getBoundSession(body.provider);
    const sameTab = previousSession?.tabId === result.tabId;

    ctx.state.setBoundSession(body.provider, {
      provider: body.provider,
      ...result,
      conversationId: sameTab ? previousSession.conversationId : `conv-${body.provider}-${result.tabId}`,
      providerInitialized: sameTab ? previousSession.providerInitialized : false,
      providerInitFingerprint: sameTab ? previousSession.providerInitFingerprint : null,
    });

    return { provider: body.provider, ...result };
  } catch (error) {
    if (error instanceof HelperError) {
      return reply.code(409).send({ error: error.code, message: error.message });
    }

    throw error;
  }
});

// replace provider session access inside src/helper/routes/provider-chat.ts
const body = request.body as ProviderChatRequest;
const session = ctx.state.getBoundSession(body.provider);

if (!session) {
  return reply.code(409).send({
    error: "NOT_BOUND",
    message: `Bind a ${body.provider} tab before provider chat`,
  });
}

const result = await ctx.browserClient.sendChatPrompt({
  provider: body.provider,
  tabId: session.tabId,
  prompt,
  timeoutMs: 30_000,
  freshSession: promptInput.shouldStartFresh,
});

ctx.state.setLastProviderRequest(body.provider, {
  ...baseDebugRecord,
  provider: body.provider,
  completedAt: new Date().toISOString(),
  status: "completed",
  response,
  automation: result.debug ?? null,
});

// replace reset route in src/helper/routes/reset.ts
app.post("/v1/reset", async (request) => {
  const body = request.body as ResetRequest;
  const session = ctx.state.getBoundSession(body.provider);

  if (session) {
    await ctx.browserClient.resetProvider({ provider: body.provider, tabId: session.tabId });
    ctx.state.setBoundSession(body.provider, null);
    ctx.state.setLastProviderRequest(body.provider, null);
  }

  return { ok: true, provider: body.provider };
});
```

- [ ] **Step 4: Run the helper route tests to verify they pass**

Run: `npm test -- tests/helper/app.test.ts tests/helper/bind-reset.test.ts tests/helper/provider-chat.test.ts`
Expected: PASS with provider-aware bind/chat/reset/debug behavior green and existing DeepSeek route behavior preserved.

- [ ] **Step 5: Commit the provider-aware helper routes**

```bash
git add src/helper/app.ts src/helper/routes/bind.ts src/helper/routes/provider-chat.ts src/helper/routes/reset.ts src/helper/routes/debug-provider-last.ts tests/helper/app.test.ts tests/helper/bind-reset.test.ts tests/helper/provider-chat.test.ts
git commit -m "refactor: dispatch helper routes by provider"
```

### Task 4: Register Multiple Extension Providers From One Shared Runtime

**Files:**
- Modify: `src/extension/provider-runtime.ts`
- Test: `tests/extension/index.test.ts`

- [ ] **Step 1: Write failing extension tests for dual-provider registration and provider-aware helper requests**

```ts
// append to tests/extension/index.test.ts
it("registers deepseek-web and qwen-web from one runtime", () => {
  const providers: Array<{ name: string; config: ProviderConfig }> = [];

  registerDeepSeekExtension(
    {
      registerProvider(name, config) {
        providers.push({ name: String(name), config: config as ProviderConfig });
      },
      on() {},
    },
    {
      spawnHelper: async () => ({
        baseUrl: "http://127.0.0.1:4318",
        token: "token-123",
        stop: async () => undefined,
      }),
      helperClient: {
        post: async <T>() => ({ mode: "text", outputText: "ok", finishReason: "stop" } as T),
      },
      randomToken: () => "token-123",
    },
  );

  expect(providers.map((entry) => entry.name)).toEqual(["deepseek-web", "qwen-web"]);
});

it("sends provider-aware helper requests for qwen-web", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let qwenConfig: ProviderConfig | undefined;

  registerDeepSeekExtension(
    {
      registerProvider(name, config) {
        if (name === "qwen-web") {
          qwenConfig = config as ProviderConfig;
        }
      },
      on() {},
    },
    {
      spawnHelper: async () => ({
        baseUrl: "http://127.0.0.1:4318",
        token: "token-123",
        stop: async () => undefined,
      }),
      helperClient: {
        post: async <T>(_baseUrl, path, body) => {
          calls.push({ path, body });
          if (path === "/v1/bind") return { ok: true } as T;
          return { mode: "text", outputText: "qwen reply", finishReason: "stop" } as T;
        },
      },
      randomToken: () => "token-123",
    },
  );

  const stream = qwenConfig?.streamSimple?.(
    { id: "qwen-web-chat", api: "qwen-web-api", provider: "qwen-web" },
    {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    },
  );

  await stream?.result();

  const bindCall = calls.find((call) => call.path === "/v1/bind");
  const chatCall = calls.find((call) => call.path === "/v1/provider/chat");
  expect(bindCall?.body).toEqual({ provider: "qwen-web" });
  expect(chatCall?.body).toMatchObject({
    provider: "qwen-web",
    model: "qwen-web-chat",
  });
});
```

- [ ] **Step 2: Run the extension tests to verify they fail**

Run: `npm test -- tests/extension/index.test.ts`
Expected: FAIL because the extension still registers only `deepseek-web` and does not send `provider` in helper requests.

- [ ] **Step 3: Refactor the runtime to use provider descriptors and provider-aware helper payloads**

```ts
// near the top of src/extension/provider-runtime.ts
const PROVIDERS = [
  {
    provider: "deepseek-web",
    api: "deepseek-web-api",
    apiKey: "deepseek-web-local",
    model: {
      id: "deepseek-web-chat",
      name: "DeepSeek Web Chat",
    },
  },
  {
    provider: "qwen-web",
    api: "qwen-web-api",
    apiKey: "qwen-web-local",
    model: {
      id: "qwen-web-chat",
      name: "Qwen Web Chat",
    },
  },
] as const;

// replace the single registration block with a loop
for (const descriptor of PROVIDERS) {
  pi.registerProvider(descriptor.provider, {
    baseUrl: PROVIDER_BASE_URL,
    apiKey: descriptor.apiKey,
    api: descriptor.api,
    models: [
      {
        id: descriptor.model.id,
        name: descriptor.model.name,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64_000,
        maxTokens: 8_000,
      },
    ],
    streamSimple(model, context, options) {
      // keep the existing shared implementation, but change helper calls to:
      await deps.helperClient.post(current.baseUrl, "/v1/bind", {
        provider: model.provider,
      }, current.token, options?.signal);

      const requestPayload = {
        provider: model.provider,
        model: model.id,
        messages,
        ...(sessionInit ? { sessionInit } : {}),
      };
    },
  });
}
```

- [ ] **Step 4: Run the extension tests to verify they pass**

Run: `npm test -- tests/extension/index.test.ts`
Expected: PASS with dual provider registration, shared helper lifecycle, and provider-aware helper requests green.

- [ ] **Step 5: Commit the multi-provider extension runtime**

```bash
git add src/extension/provider-runtime.ts tests/extension/index.test.ts
git commit -m "feat: register deepseek and qwen providers from shared runtime"
```

### Task 5: Add the First Qwen Adapter and Provider Coverage

**Files:**
- Create: `src/helper/providers/qwen/adapter.ts`
- Create: `src/helper/providers/qwen/page-bridge.ts`
- Modify: `src/helper/providers/registry.ts`
- Modify: `src/helper/browser/bb-browser-client.ts`
- Test: `tests/helper/qwen-adapter.test.ts`
- Test: `tests/helper/provider-chat.test.ts`
- Test: `tests/extension/index.test.ts`

- [ ] **Step 1: Write failing tests for Qwen host validation and text-turn routing**

```ts
// create tests/helper/qwen-adapter.test.ts
import { describe, expect, it } from "vitest";
import { assertQwenUrl } from "../../src/helper/providers/qwen/page-bridge";

describe("qwen adapter", () => {
  it("accepts chat.qwen.ai URLs", () => {
    expect(assertQwenUrl("https://chat.qwen.ai/")).toBe("https://chat.qwen.ai/");
  });

  it("rejects unsupported hosts", () => {
    expect(() => assertQwenUrl("https://example.com/")).toThrow(/Unsupported Qwen host/);
  });
});

// append to tests/helper/provider-chat.test.ts
it("routes qwen provider chat through the qwen binding slot", async () => {
  const calls: Array<{ provider: string; prompt: string }> = [];

  const app = buildApp({
    token: "test-token",
    browserClient: {
      getConnectionStatus: async () => "connected",
      bindProviderTab: async ({ provider }: { provider: string }) => ({
        tabId: provider === "qwen-web" ? "tab-qwen" : "tab-deepseek",
        url: provider === "qwen-web" ? "https://chat.qwen.ai/" : "https://chat.deepseek.com/",
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
      sendChatPrompt: async ({ provider, prompt }: { provider: string; prompt: string }) => {
        calls.push({ provider, prompt });
        return {
          mode: "text",
          outputText: `reply:${provider}:${prompt}`,
          modelLabel: provider === "qwen-web" ? "Qwen Web" : "DeepSeek Web",
        };
      },
    },
  });

  await app.inject({
    method: "POST",
    url: "/v1/bind",
    headers: { authorization: "Bearer test-token" },
    payload: { provider: "qwen-web" },
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/provider/chat",
    headers: { authorization: "Bearer test-token" },
    payload: {
      provider: "qwen-web",
      model: "qwen-web-chat",
      messages: [{ role: "user", content: "hello qwen" }],
    },
  });

  expect(response.json()).toMatchObject({ outputText: "reply:qwen-web:hello qwen" });
  expect(calls).toEqual([{ provider: "qwen-web", prompt: "hello qwen" }]);
});
```

- [ ] **Step 2: Run the Qwen-focused tests to verify they fail**

Run: `npm test -- tests/helper/qwen-adapter.test.ts tests/helper/provider-chat.test.ts tests/extension/index.test.ts`
Expected: FAIL because the Qwen adapter/page bridge do not exist and provider registry cannot dispatch real Qwen behavior yet.

- [ ] **Step 3: Implement the first Qwen adapter and page bridge with minimal text support**

```ts
// create src/helper/providers/qwen/page-bridge.ts
import { HelperError } from "../../errors";

export const QWEN_HOST_ALLOWLIST = new Set(["chat.qwen.ai"]);

export function assertQwenUrl(rawUrl: string) {
  const url = new URL(rawUrl);

  if (!QWEN_HOST_ALLOWLIST.has(url.host)) {
    throw new HelperError("PAGE_UNAVAILABLE", `Unsupported Qwen host: ${url.host}`);
  }

  return url.toString();
}

// create src/helper/providers/qwen/adapter.ts
export function createQwenAdapter(deps: { transport: BbBrowserTransport }): ProviderAdapter {
  return {
    providerId: "qwen-web",
    matchesTab(url) {
      return url.includes("chat.qwen.ai");
    },
    assertSupportedUrl: assertQwenUrl,
    buildOpenUrl() {
      return "https://chat.qwen.ai/";
    },
    async bind(tab) {
      const url = assertQwenUrl(tab.url);
      const pageState = await deps.transport.evaluate<PageStateSummary>(tab.id, QWEN_BIND_SCRIPT);
      return {
        tabId: tab.id,
        url,
        loginState: "logged_in",
        bridgeInjected: true,
        pageState,
      };
    },
    async reset(tabId) {
      await deps.transport.evaluate(tabId, QWEN_RESET_SCRIPT);
    },
    async startNewChat(tabId) {
      await deps.transport.evaluate(tabId, QWEN_NEW_CHAT_SCRIPT);
    },
    async sendChatPrompt({ tabId, prompt, timeoutMs, freshSession }) {
      await deps.transport.submitPrompt(tabId, prompt);
      const result = await deps.transport.evaluate<{
        reply: string;
        thinking?: string;
      }>(tabId, buildQwenWaitForReplyScript({ timeoutMs, freshSession }));

      return {
        mode: "text",
        ...(result.thinking ? { thinkingText: result.thinking } : {}),
        outputText: result.reply,
        modelLabel: "Qwen Web",
      };
    },
  };
}
```

- [ ] **Step 4: Run the Qwen-focused tests to verify they pass**

Run: `npm test -- tests/helper/qwen-adapter.test.ts tests/helper/provider-chat.test.ts tests/extension/index.test.ts`
Expected: PASS with Qwen host validation, provider routing, and extension/provider integration green.

- [ ] **Step 5: Commit the first Qwen provider adapter**

```bash
git add src/helper/providers/qwen src/helper/providers/registry.ts src/helper/browser/bb-browser-client.ts tests/helper/qwen-adapter.test.ts tests/helper/provider-chat.test.ts tests/extension/index.test.ts
git commit -m "feat: add qwen web provider adapter"
```

### Task 6: Run Final Verification Across DeepSeek and Qwen Provider Paths

**Files:**
- Modify: `tests/helper/provider-chat.test.ts`
- Modify: `tests/extension/index.test.ts`
- Modify: `tests/helper/bind-reset.test.ts`

- [ ] **Step 1: Add final regression coverage for provider isolation across the whole pipeline**

```ts
// append to tests/extension/index.test.ts
it("reuses one helper instance across deepseek and qwen streams", async () => {
  const calls: string[] = [];
  const configs = new Map<string, ProviderConfig>();

  registerDeepSeekExtension(
    {
      registerProvider(name, config) {
        configs.set(String(name), config as ProviderConfig);
      },
      on() {},
    },
    {
      spawnHelper: async ({ token, port }) => {
        calls.push(`spawn:${token}:${port}`);
        return {
          baseUrl: `http://127.0.0.1:${port}`,
          token,
          stop: async () => undefined,
        };
      },
      helperClient: {
        post: async <T>(_baseUrl, path, body) => {
          calls.push(`${path}:${JSON.stringify(body)}`);
          if (path === "/v1/bind") return { ok: true } as T;
          return { mode: "text", outputText: "ok", finishReason: "stop" } as T;
        },
      },
      randomToken: () => "token-123",
    },
  );

  await configs
    .get("deepseek-web")
    ?.streamSimple?.(
      { id: "deepseek-web-chat", api: "deepseek-web-api", provider: "deepseek-web" },
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    )
    .result();

  await configs
    .get("qwen-web")
    ?.streamSimple?.(
      { id: "qwen-web-chat", api: "qwen-web-api", provider: "qwen-web" },
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    )
    .result();

  expect(calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
  expect(calls.some((call) => call.includes('"provider":"deepseek-web"'))).toBe(true);
  expect(calls.some((call) => call.includes('"provider":"qwen-web"'))).toBe(true);
});
```

- [ ] **Step 2: Run the targeted full verification suite and confirm it fails only if gaps remain**

Run: `npm test -- tests/helper/bind-reset.test.ts tests/helper/provider-chat.test.ts tests/helper/app.test.ts tests/helper/bb-browser-client.test.ts tests/helper/deepseek-page-bridge.test.ts tests/helper/qwen-adapter.test.ts tests/extension/index.test.ts`
Expected: PASS after all prior tasks are complete.

- [ ] **Step 3: Run the project test suite**

Run: `npm test`
Expected: PASS with no regressions across helper, extension, and provider adapter coverage.

- [ ] **Step 4: Manual smoke checklist**

Run these manual checks after the automated suite is green:

1. Launch the helper: `PORT=4318 HELPER_TOKEN=manual-provider npm run dev:helper`
2. Open a logged-in DeepSeek tab and a logged-in Qwen tab in `bb-browser`.
3. Bind DeepSeek:
   `curl -s -X POST http://127.0.0.1:4318/v1/bind -H 'Authorization: Bearer manual-provider' -H 'Content-Type: application/json' -d '{"provider":"deepseek-web"}'`
4. Bind Qwen:
   `curl -s -X POST http://127.0.0.1:4318/v1/bind -H 'Authorization: Bearer manual-provider' -H 'Content-Type: application/json' -d '{"provider":"qwen-web"}'`
5. Send a DeepSeek provider chat:
   `curl -s -X POST http://127.0.0.1:4318/v1/provider/chat -H 'Authorization: Bearer manual-provider' -H 'Content-Type: application/json' -d '{"provider":"deepseek-web","model":"deepseek-web-chat","messages":[{"role":"user","content":"reply with the word deepseek"}]}'`
6. Send a Qwen provider chat:
   `curl -s -X POST http://127.0.0.1:4318/v1/provider/chat -H 'Authorization: Bearer manual-provider' -H 'Content-Type: application/json' -d '{"provider":"qwen-web","model":"qwen-web-chat","messages":[{"role":"user","content":"reply with the word qwen"}]}'`
7. Reset only DeepSeek and verify Qwen still responds.
8. Query provider debug state:
   `curl -s http://127.0.0.1:4318/v1/debug/provider-last`

- [ ] **Step 5: Commit the verification coverage**

```bash
git add tests/helper/bind-reset.test.ts tests/helper/provider-chat.test.ts tests/extension/index.test.ts
git commit -m "test: verify deepseek and qwen provider isolation"
```

## Self-Review

- Spec coverage: contract/provider state, adapterization, DeepSeek migration, Qwen minimal path, extension registration, provider-aware routing, and verification are all mapped to Tasks 1 through 6.
- Placeholder scan: no `TODO`, `TBD`, or deferred "handle later" steps remain in the plan.
- Type consistency: the plan consistently uses `provider`, `model`, `bindProviderTab`, `resetProvider`, `ProviderId`, `deepseek-web`, and `qwen-web` across contracts, routes, browser interfaces, and tests.
