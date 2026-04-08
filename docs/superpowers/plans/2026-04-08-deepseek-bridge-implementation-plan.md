# DeepSeek Web Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-only `pi` extension plus helper that reuses a logged-in DeepSeek webpage session through `bb-browser`, exposes a minimal chat API, and provides a real-time local debug surface.

**Architecture:** Use a TypeScript workspace with one Fastify-based helper process, one shared contract module, and one extension entrypoint. The helper owns browser automation, injected page-bridge lifecycle, request serialization, error normalization, and debug state; the extension only launches the helper, authenticates over loopback, and forwards chat calls.

**Tech Stack:** TypeScript, Node.js 22+, Fastify, Vitest, TSX, Vite-free static debug page served by Fastify

---

## File Structure

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/shared/contracts.ts`
- Create: `src/helper/types.ts`
- Create: `src/helper/errors.ts`
- Create: `src/helper/state.ts`
- Create: `src/helper/debug-store.ts`
- Create: `src/helper/browser/types.ts`
- Create: `src/helper/browser/bb-browser-client.ts`
- Create: `src/helper/browser/deepseek-page-bridge.ts`
- Create: `src/helper/routes/health.ts`
- Create: `src/helper/routes/bind.ts`
- Create: `src/helper/routes/reset.ts`
- Create: `src/helper/routes/chat.ts`
- Create: `src/helper/routes/debug.ts`
- Create: `src/helper/app.ts`
- Create: `src/helper/main.ts`
- Create: `src/helper/public/debug.html`
- Create: `src/helper/public/debug.js`
- Create: `src/extension/index.ts`
- Create: `tests/helper/app.test.ts`
- Create: `tests/helper/bind-reset.test.ts`
- Create: `tests/helper/chat.test.ts`
- Create: `tests/helper/debug.test.ts`
- Create: `tests/extension/index.test.ts`

## Implementation Notes

- Use one in-memory active-request slot. Return `MODEL_BUSY` immediately if a second `POST /v1/chat` arrives before the first one finishes.
- Keep `conversation_id` helper-generated and stable for the current bound tab. Never expose a DeepSeek internal identifier.
- Use polling in the debug page rather than a websocket or SSE. The spec only requires real-time viewing, not push transport.
- Keep the `bb-browser` integration behind a `BrowserAutomationClient` interface so tests can run with a fake implementation.
- Treat selector logic as isolated page-bridge code. All DOM-specific failures must translate to the normalized helper error model before crossing the API boundary.

### Task 1: Bootstrap the TypeScript workspace and helper smoke test

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/shared/contracts.ts`
- Create: `src/helper/app.ts`
- Create: `src/helper/main.ts`
- Test: `tests/helper/app.test.ts`

- [ ] **Step 1: Write the failing smoke test for helper boot and `/v1/health`**

```ts
// tests/helper/app.test.ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/helper/app";

describe("helper app", () => {
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
```

- [ ] **Step 2: Run the smoke test and confirm it fails because the app does not exist yet**

Run: `npm test -- tests/helper/app.test.ts`
Expected: FAIL with a module resolution error for `src/helper/app`

- [ ] **Step 3: Create the workspace, shared contracts, and the minimal helper app**

```json
// package.json
{
  "name": "deepseek-web-bridge",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:helper": "tsx src/helper/main.ts",
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "fastify": "^5.2.1"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.8.3",
    "vitest": "^3.2.4"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      reporter: ["text"],
    },
  },
});
```

```ts
// src/shared/contracts.ts
export type BindState = "unbound" | "bound";
export type BrowserConnectionStatus = "connected" | "disconnected";

export interface HealthResponse {
  ok: true;
  browser: BrowserConnectionStatus;
  bindState: BindState;
  degraded: boolean;
  lastBridgeHeartbeatAt: string | null;
}
```

```ts
// src/helper/app.ts
import Fastify from "fastify";
import type { BrowserConnectionStatus, HealthResponse } from "../shared/contracts";

export interface AppDeps {
  token: string;
  browserClient: {
    getConnectionStatus(): Promise<BrowserConnectionStatus>;
  };
}

export function buildApp(deps: AppDeps) {
  const app = Fastify();

  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${deps.token}`) {
      reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  });

  app.get("/v1/health", async (): Promise<HealthResponse> => {
    return {
      ok: true,
      browser: await deps.browserClient.getConnectionStatus(),
      bindState: "unbound",
      degraded: false,
      lastBridgeHeartbeatAt: null,
    };
  });

  return app;
}
```

```ts
// src/helper/main.ts
import { buildApp } from "./app";

const token = process.env.HELPER_TOKEN;

if (!token) {
  throw new Error("HELPER_TOKEN is required");
}

const app = buildApp({
  token,
  browserClient: {
    async getConnectionStatus() {
      return "disconnected";
    },
  },
});

await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 4318),
});
```

- [ ] **Step 4: Run the smoke test and confirm it passes**

Run: `npm test -- tests/helper/app.test.ts`
Expected: PASS with `1 passed`

- [ ] **Step 5: Commit the bootstrap**

```bash
git init
git add package.json tsconfig.json vitest.config.ts src tests
git commit -m "chore: bootstrap deepseek bridge workspace"
```

### Task 2: Add helper state, auth-safe health output, and bind/reset routes

**Files:**
- Create: `src/helper/types.ts`
- Create: `src/helper/errors.ts`
- Create: `src/helper/state.ts`
- Create: `src/helper/browser/types.ts`
- Create: `src/helper/routes/health.ts`
- Create: `src/helper/routes/bind.ts`
- Create: `src/helper/routes/reset.ts`
- Modify: `src/helper/app.ts`
- Test: `tests/helper/bind-reset.test.ts`

- [ ] **Step 1: Write failing tests for bind and reset state transitions**

```ts
// tests/helper/bind-reset.test.ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/helper/app";

describe("bind and reset", () => {
  it("binds a DeepSeek tab and reports bound health", async () => {
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
          },
        }),
        resetPageBridge: async () => undefined,
      } as never,
    });

    const bindResponse = await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    expect(bindResponse.statusCode).toBe(200);
    expect(bindResponse.json().tabId).toBe("tab-1");

    const healthResponse = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer test-token" },
    });

    expect(healthResponse.json()).toMatchObject({
      bindState: "bound",
      browser: "connected",
    });
  });

  it("reset clears the active bind state when the browser reset succeeds", async () => {
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
          },
        }),
        resetPageBridge: async () => undefined,
      } as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/bind",
      headers: { authorization: "Bearer test-token" },
    });

    const resetResponse = await app.inject({
      method: "POST",
      url: "/v1/reset",
      headers: { authorization: "Bearer test-token" },
    });

    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run the new bind/reset tests and confirm they fail**

Run: `npm test -- tests/helper/bind-reset.test.ts`
Expected: FAIL with `POST /v1/bind` and `POST /v1/reset` not found

- [ ] **Step 3: Add state management, browser contracts, and the bind/reset routes**

```ts
// src/helper/browser/types.ts
import type { BrowserConnectionStatus } from "../../shared/contracts";

export interface PageStateSummary {
  inputReady: boolean;
  busy: boolean;
  latestAssistantPreview: string | null;
}

export interface BindResult {
  tabId: string;
  url: string;
  loginState: "logged_in" | "logged_out";
  bridgeInjected: boolean;
  pageState: PageStateSummary;
}

export interface BrowserAutomationClient {
  getConnectionStatus(): Promise<BrowserConnectionStatus>;
  bindDeepSeekTab(): Promise<BindResult>;
  resetPageBridge(tabId: string): Promise<void>;
}
```

```ts
// src/helper/types.ts
import type { PageStateSummary } from "./browser/types";

export interface BoundSession {
  tabId: string;
  url: string;
  loginState: "logged_in" | "logged_out";
  bridgeInjected: boolean;
  pageState: PageStateSummary;
  conversationId: string;
}

export interface ActiveRequest {
  requestId: string;
  prompt: string;
  accumulatedReply: string;
  startedAt: string;
  lastEventAt: string;
  status: "running" | "completed" | "failed";
  finalErrorCode: string | null;
}
```

```ts
// src/helper/errors.ts
export class HelperError extends Error {
  constructor(
    public readonly code:
      | "NOT_BOUND"
      | "PAGE_UNAVAILABLE"
      | "MODEL_BUSY"
      | "TIMEOUT"
      | "AUTOMATION_DESYNC",
    message: string,
  ) {
    super(message);
  }
}
```

```ts
// src/helper/state.ts
import type { ActiveRequest, BoundSession } from "./types";

export class HelperState {
  private boundSession: BoundSession | null = null;
  private activeRequest: ActiveRequest | null = null;
  private degraded = false;
  private lastBridgeHeartbeatAt: string | null = null;

  getBoundSession() {
    return this.boundSession;
  }

  setBoundSession(session: BoundSession | null) {
    this.boundSession = session;
  }

  getActiveRequest() {
    return this.activeRequest;
  }

  setActiveRequest(request: ActiveRequest | null) {
    this.activeRequest = request;
  }

  getDegraded() {
    return this.degraded;
  }

  setDegraded(value: boolean) {
    this.degraded = value;
  }

  getLastBridgeHeartbeatAt() {
    return this.lastBridgeHeartbeatAt;
  }

  setLastBridgeHeartbeatAt(value: string | null) {
    this.lastBridgeHeartbeatAt = value;
  }

  resetRuntime() {
    this.activeRequest = null;
    this.degraded = false;
    this.lastBridgeHeartbeatAt = null;
  }
}
```

```ts
// src/helper/routes/health.ts
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";

export function registerHealthRoute(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/health", async () => ({
    ok: true,
    browser: await ctx.browserClient.getConnectionStatus(),
    bindState: ctx.state.getBoundSession() ? "bound" : "unbound",
    degraded: ctx.state.getDegraded(),
    lastBridgeHeartbeatAt: ctx.state.getLastBridgeHeartbeatAt(),
  }));
}
```

```ts
// src/helper/routes/bind.ts
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";

export function registerBindRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/bind", async () => {
    const result = await ctx.browserClient.bindDeepSeekTab();
    ctx.state.setBoundSession({
      ...result,
      conversationId: `conv-${result.tabId}`,
    });

    return result;
  });
}
```

```ts
// src/helper/routes/reset.ts
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";

export function registerResetRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/reset", async () => {
    const session = ctx.state.getBoundSession();

    if (session) {
      await ctx.browserClient.resetPageBridge(session.tabId);
      ctx.state.setBoundSession(null);
    }

    ctx.state.resetRuntime();
    return { ok: true };
  });
}
```

```ts
// src/helper/app.ts
import Fastify from "fastify";
import { registerBindRoute } from "./routes/bind";
import { registerHealthRoute } from "./routes/health";
import { registerResetRoute } from "./routes/reset";
import { HelperState } from "./state";
import type { BrowserAutomationClient } from "./browser/types";

export interface AppDeps {
  token: string;
  browserClient: BrowserAutomationClient;
}

export interface AppContext {
  browserClient: BrowserAutomationClient;
  state: HelperState;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify();
  const ctx: AppContext = {
    browserClient: deps.browserClient,
    state: new HelperState(),
  };

  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${deps.token}`) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  });

  registerHealthRoute(app, ctx);
  registerBindRoute(app, ctx);
  registerResetRoute(app, ctx);

  return app;
}
```

- [ ] **Step 4: Run the bind/reset tests and confirm they pass**

Run: `npm test -- tests/helper/bind-reset.test.ts tests/helper/app.test.ts`
Expected: PASS with `3 passed`

- [ ] **Step 5: Commit the helper state and basic routes**

```bash
git add src/helper src/shared tests/helper
git commit -m "feat: add helper bind reset and health routes"
```

### Task 3: Add chat contracts, request serialization, and normalized failure handling

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/helper/browser/types.ts`
- Modify: `src/helper/state.ts`
- Create: `src/helper/routes/chat.ts`
- Modify: `src/helper/app.ts`
- Test: `tests/helper/chat.test.ts`

- [ ] **Step 1: Write failing tests for chat success, busy rejection, and missing bind**

```ts
// tests/helper/chat.test.ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/helper/app";

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
          pageState: { inputReady: true, busy: false, latestAssistantPreview: null },
        }),
        resetPageBridge: async () => undefined,
        sendChatPrompt: async () => ({
          reply: "hello from deepseek",
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
});
```

- [ ] **Step 2: Run the chat tests and confirm they fail**

Run: `npm test -- tests/helper/chat.test.ts`
Expected: FAIL with `POST /v1/chat` not found

- [ ] **Step 3: Add chat request types and a serialized chat route**

```ts
// src/shared/contracts.ts
export type BindState = "unbound" | "bound";
export type BrowserConnectionStatus = "connected" | "disconnected";
export type ErrorCode =
  | "NOT_BOUND"
  | "PAGE_UNAVAILABLE"
  | "MODEL_BUSY"
  | "TIMEOUT"
  | "AUTOMATION_DESYNC";

export interface HealthResponse {
  ok: true;
  browser: BrowserConnectionStatus;
  bindState: BindState;
  degraded: boolean;
  lastBridgeHeartbeatAt: string | null;
}

export interface ChatRequest {
  prompt: string;
  conversationId?: string;
  timeoutMs?: number;
}

export interface ChatResponse {
  reply: string;
  conversationId: string;
  modelLabel?: string;
  rawStatus: "completed" | "timeout" | "failed";
}
```

```ts
// src/helper/browser/types.ts
import type { BrowserConnectionStatus } from "../../shared/contracts";

export interface PageStateSummary {
  inputReady: boolean;
  busy: boolean;
  latestAssistantPreview: string | null;
}

export interface BindResult {
  tabId: string;
  url: string;
  loginState: "logged_in" | "logged_out";
  bridgeInjected: boolean;
  pageState: PageStateSummary;
}

export interface SendChatResult {
  reply: string;
  modelLabel?: string;
}

export interface BrowserAutomationClient {
  getConnectionStatus(): Promise<BrowserConnectionStatus>;
  bindDeepSeekTab(): Promise<BindResult>;
  resetPageBridge(tabId: string): Promise<void>;
  sendChatPrompt(input: {
    tabId: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<SendChatResult>;
}
```

```ts
// src/helper/state.ts
import type { ActiveRequest, BoundSession } from "./types";

export class HelperState {
  private boundSession: BoundSession | null = null;
  private activeRequest: ActiveRequest | null = null;
  private degraded = false;
  private lastBridgeHeartbeatAt: string | null = null;

  getBoundSession() {
    return this.boundSession;
  }

  setBoundSession(session: BoundSession | null) {
    this.boundSession = session;
  }

  getActiveRequest() {
    return this.activeRequest;
  }

  setActiveRequest(request: ActiveRequest | null) {
    this.activeRequest = request;
  }

  hasRunningRequest() {
    return this.activeRequest?.status === "running";
  }

  getDegraded() {
    return this.degraded;
  }

  setDegraded(value: boolean) {
    this.degraded = value;
  }

  getLastBridgeHeartbeatAt() {
    return this.lastBridgeHeartbeatAt;
  }

  setLastBridgeHeartbeatAt(value: string | null) {
    this.lastBridgeHeartbeatAt = value;
  }

  resetRuntime() {
    this.activeRequest = null;
    this.degraded = false;
    this.lastBridgeHeartbeatAt = null;
  }
}
```

```ts
// src/helper/routes/chat.ts
import type { FastifyInstance } from "fastify";
import { HelperError } from "../errors";
import type { AppContext } from "../app";

export function registerChatRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/chat", async (request, reply) => {
    const body = request.body as {
      prompt?: string;
      timeoutMs?: number;
    };

    const session = ctx.state.getBoundSession();
    if (!session) {
      return reply.code(409).send({
        error: "NOT_BOUND",
        message: "Bind a DeepSeek tab before chatting",
      });
    }

    if (!body.prompt) {
      return reply.code(400).send({
        error: "AUTOMATION_DESYNC",
        message: "Prompt is required",
      });
    }

    if (ctx.state.hasRunningRequest()) {
      return reply.code(409).send({
        error: "MODEL_BUSY",
        message: "Another request is already in progress",
      });
    }

    ctx.state.setActiveRequest({
      requestId: `req-${Date.now()}`,
      prompt: body.prompt,
      accumulatedReply: "",
      startedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString(),
      status: "running",
      finalErrorCode: null,
    });

    try {
      const result = await ctx.browserClient.sendChatPrompt({
        tabId: session.tabId,
        prompt: body.prompt,
        timeoutMs: body.timeoutMs ?? 60_000,
      });

      ctx.state.setActiveRequest(null);

      return {
        reply: result.reply,
        conversationId: session.conversationId,
        modelLabel: result.modelLabel,
        rawStatus: "completed",
      };
    } catch (error) {
      const helperError =
        error instanceof HelperError
          ? error
          : new HelperError("AUTOMATION_DESYNC", "Unexpected automation failure");

      ctx.state.setActiveRequest(null);
      return reply.code(409).send({
        error: helperError.code,
        message: helperError.message,
      });
    }
  });
}
```

```ts
// src/helper/app.ts
import Fastify from "fastify";
import { registerBindRoute } from "./routes/bind";
import { registerChatRoute } from "./routes/chat";
import { registerHealthRoute } from "./routes/health";
import { registerResetRoute } from "./routes/reset";
import { HelperState } from "./state";
import type { BrowserAutomationClient } from "./browser/types";

export interface AppDeps {
  token: string;
  browserClient: BrowserAutomationClient;
}

export interface AppContext {
  browserClient: BrowserAutomationClient;
  state: HelperState;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify();
  const ctx: AppContext = {
    browserClient: deps.browserClient,
    state: new HelperState(),
  };

  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${deps.token}`) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  });

  registerHealthRoute(app, ctx);
  registerBindRoute(app, ctx);
  registerResetRoute(app, ctx);
  registerChatRoute(app, ctx);

  return app;
}
```

- [ ] **Step 4: Run the chat tests and confirm they pass**

Run: `npm test -- tests/helper/chat.test.ts tests/helper/bind-reset.test.ts`
Expected: PASS with `4 passed`

- [ ] **Step 5: Commit the serialized chat route**

```bash
git add src/helper src/shared tests/helper/chat.test.ts
git commit -m "feat: add serialized chat api with normalized errors"
```

### Task 4: Add debug event storage and debug endpoints

**Files:**
- Create: `src/helper/debug-store.ts`
- Create: `src/helper/routes/debug.ts`
- Modify: `src/helper/types.ts`
- Modify: `src/helper/routes/chat.ts`
- Modify: `src/helper/app.ts`
- Test: `tests/helper/debug.test.ts`

- [ ] **Step 1: Write failing tests for last-call, events, and page snapshot debug routes**

```ts
// tests/helper/debug.test.ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/helper/app";

describe("debug routes", () => {
  it("exposes the last successful request and recorded events", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "connected",
        bindDeepSeekTab: async () => ({
          tabId: "tab-1",
          url: "https://chat.deepseek.com/",
          loginState: "logged_in",
          bridgeInjected: true,
          pageState: { inputReady: true, busy: false, latestAssistantPreview: null },
        }),
        resetPageBridge: async () => undefined,
        sendChatPrompt: async ({ prompt }) => ({
          reply: `echo:${prompt}`,
          modelLabel: "DeepSeek Web",
        }),
        getPageSnapshot: async () => ({
          url: "https://chat.deepseek.com/",
          loginState: "logged_in",
          bridgeHealthy: true,
          busy: false,
          inputReady: true,
          latestAssistantPreview: "echo:hello",
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
      url: "/v1/chat",
      headers: { authorization: "Bearer test-token" },
      payload: { prompt: "hello" },
    });

    const lastResponse = await app.inject({
      method: "GET",
      url: "/v1/debug/last",
      headers: { authorization: "Bearer test-token" },
    });

    const eventsResponse = await app.inject({
      method: "GET",
      url: "/v1/debug/events",
      headers: { authorization: "Bearer test-token" },
    });

    const snapshotResponse = await app.inject({
      method: "GET",
      url: "/v1/debug/page-snapshot",
      headers: { authorization: "Bearer test-token" },
    });

    expect(lastResponse.json().reply).toBe("echo:hello");
    expect(eventsResponse.json().events.length).toBeGreaterThan(0);
    expect(snapshotResponse.json().bridgeHealthy).toBe(true);
  });
});
```

- [ ] **Step 2: Run the debug tests and confirm they fail**

Run: `npm test -- tests/helper/debug.test.ts`
Expected: FAIL with debug routes missing

- [ ] **Step 3: Add debug storage and routes wired into the chat lifecycle**

```ts
// src/helper/types.ts
import type { PageStateSummary } from "./browser/types";

export interface BoundSession {
  tabId: string;
  url: string;
  loginState: "logged_in" | "logged_out";
  bridgeInjected: boolean;
  pageState: PageStateSummary;
  conversationId: string;
}

export interface ActiveRequest {
  requestId: string;
  prompt: string;
  accumulatedReply: string;
  startedAt: string;
  lastEventAt: string;
  status: "running" | "completed" | "failed";
  finalErrorCode: string | null;
}

export interface DebugEvent {
  time: string;
  requestId: string | null;
  type: string;
  payload: Record<string, unknown>;
}

export interface LastCallRecord {
  requestId: string;
  prompt: string;
  reply: string;
  durationMs: number;
  resultCode: "completed" | "failed";
  targetTabId: string;
  startedAt: string;
}
```

```ts
// src/helper/debug-store.ts
import type { DebugEvent, LastCallRecord } from "./types";

export class DebugStore {
  private events: DebugEvent[] = [];
  private lastCall: LastCallRecord | null = null;

  addEvent(event: DebugEvent) {
    this.events.push(event);
    if (this.events.length > 200) {
      this.events = this.events.slice(-200);
    }
  }

  setLastCall(record: LastCallRecord) {
    this.lastCall = record;
  }

  getLastCall() {
    return this.lastCall;
  }

  getEvents() {
    return this.events;
  }
}
```

```ts
// src/helper/routes/debug.ts
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";

export function registerDebugRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/debug/last", async () => ctx.debugStore.getLastCall());

  app.get("/v1/debug/events", async () => ({
    events: ctx.debugStore.getEvents(),
  }));

  app.get("/v1/debug/page-snapshot", async () => {
    const session = ctx.state.getBoundSession();
    if (!session) {
      return {
        url: null,
        loginState: "logged_out",
        bridgeHealthy: false,
        busy: false,
        inputReady: false,
        latestAssistantPreview: null,
      };
    }

    return ctx.browserClient.getPageSnapshot(session.tabId);
  });
}
```

```ts
// src/helper/routes/chat.ts
import type { FastifyInstance } from "fastify";
import { HelperError } from "../errors";
import type { AppContext } from "../app";

export function registerChatRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/chat", async (request, reply) => {
    const body = request.body as { prompt?: string; timeoutMs?: number };
    const session = ctx.state.getBoundSession();

    if (!session) {
      return reply.code(409).send({
        error: "NOT_BOUND",
        message: "Bind a DeepSeek tab before chatting",
      });
    }

    if (!body.prompt) {
      return reply.code(400).send({
        error: "AUTOMATION_DESYNC",
        message: "Prompt is required",
      });
    }

    if (ctx.state.hasRunningRequest()) {
      return reply.code(409).send({
        error: "MODEL_BUSY",
        message: "Another request is already in progress",
      });
    }

    const startedAt = new Date().toISOString();
    const requestId = `req-${Date.now()}`;

    ctx.state.setActiveRequest({
      requestId,
      prompt: body.prompt,
      accumulatedReply: "",
      startedAt,
      lastEventAt: startedAt,
      status: "running",
      finalErrorCode: null,
    });
    ctx.debugStore.addEvent({
      time: startedAt,
      requestId,
      type: "message_send_started",
      payload: { prompt: body.prompt },
    });

    try {
      const result = await ctx.browserClient.sendChatPrompt({
        tabId: session.tabId,
        prompt: body.prompt,
        timeoutMs: body.timeoutMs ?? 60_000,
      });

      const finishedAt = Date.now();
      ctx.debugStore.addEvent({
        time: new Date(finishedAt).toISOString(),
        requestId,
        type: "assistant_stream_completed",
        payload: { replyLength: result.reply.length },
      });
      ctx.debugStore.setLastCall({
        requestId,
        prompt: body.prompt,
        reply: result.reply,
        durationMs: finishedAt - new Date(startedAt).getTime(),
        resultCode: "completed",
        targetTabId: session.tabId,
        startedAt,
      });
      ctx.state.setActiveRequest(null);

      return {
        reply: result.reply,
        conversationId: session.conversationId,
        modelLabel: result.modelLabel,
        rawStatus: "completed",
      };
    } catch (error) {
      const helperError =
        error instanceof HelperError
          ? error
          : new HelperError("AUTOMATION_DESYNC", "Unexpected automation failure");

      ctx.debugStore.addEvent({
        time: new Date().toISOString(),
        requestId,
        type: "assistant_stream_aborted",
        payload: { error: helperError.code },
      });
      ctx.state.setActiveRequest(null);
      return reply.code(409).send({
        error: helperError.code,
        message: helperError.message,
      });
    }
  });
}
```

```ts
// src/helper/app.ts
import Fastify from "fastify";
import type { BrowserAutomationClient } from "./browser/types";
import { DebugStore } from "./debug-store";
import { registerBindRoute } from "./routes/bind";
import { registerChatRoute } from "./routes/chat";
import { registerDebugRoutes } from "./routes/debug";
import { registerHealthRoute } from "./routes/health";
import { registerResetRoute } from "./routes/reset";
import { HelperState } from "./state";

export interface AppDeps {
  token: string;
  browserClient: BrowserAutomationClient;
}

export interface AppContext {
  browserClient: BrowserAutomationClient;
  state: HelperState;
  debugStore: DebugStore;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify();
  const ctx: AppContext = {
    browserClient: deps.browserClient,
    state: new HelperState(),
    debugStore: new DebugStore(),
  };

  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${deps.token}`) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  });

  registerHealthRoute(app, ctx);
  registerBindRoute(app, ctx);
  registerResetRoute(app, ctx);
  registerChatRoute(app, ctx);
  registerDebugRoutes(app, ctx);

  return app;
}
```

- [ ] **Step 4: Run the debug tests and confirm they pass**

Run: `npm test -- tests/helper/debug.test.ts tests/helper/chat.test.ts`
Expected: PASS with `3 passed`

- [ ] **Step 5: Commit the debug data model and routes**

```bash
git add src/helper tests/helper/debug.test.ts
git commit -m "feat: add helper debug routes and event store"
```

### Task 5: Implement the real `bb-browser` adapter and page-bridge abstraction

**Files:**
- Create: `src/helper/browser/bb-browser-client.ts`
- Create: `src/helper/browser/deepseek-page-bridge.ts`
- Modify: `src/helper/browser/types.ts`
- Modify: `src/helper/main.ts`
- Test: `tests/helper/chat.test.ts`

- [ ] **Step 1: Extend the chat tests to verify timeout and translated browser failures**

```ts
// append to tests/helper/chat.test.ts
it("translates browser timeout failures into TIMEOUT", async () => {
  const app = buildApp({
    token: "test-token",
    browserClient: {
      getConnectionStatus: async () => "connected",
      bindDeepSeekTab: async () => ({
        tabId: "tab-1",
        url: "https://chat.deepseek.com/",
        loginState: "logged_in",
        bridgeInjected: true,
        pageState: { inputReady: true, busy: false, latestAssistantPreview: null },
      }),
      resetPageBridge: async () => undefined,
      sendChatPrompt: async () => {
        throw new HelperError("TIMEOUT", "The page did not finish streaming in time");
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
    url: "/v1/chat",
    headers: { authorization: "Bearer test-token" },
    payload: { prompt: "hello" },
  });

  expect(response.statusCode).toBe(409);
  expect(response.json().error).toBe("TIMEOUT");
});
```

- [ ] **Step 2: Run the chat tests and confirm the new timeout case fails**

Run: `npm test -- tests/helper/chat.test.ts`
Expected: FAIL because `HelperError` or timeout handling is not wired into the real adapter boundary yet

- [ ] **Step 3: Implement the real adapter and bridge abstraction behind the browser interface**

```ts
// src/helper/browser/deepseek-page-bridge.ts
import { HelperError } from "../errors";

export const DEEPSEEK_HOST_ALLOWLIST = new Set([
  "chat.deepseek.com",
  "www.deepseek.com",
]);

export function assertDeepSeekUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!DEEPSEEK_HOST_ALLOWLIST.has(url.host)) {
    throw new HelperError("PAGE_UNAVAILABLE", `Unsupported DeepSeek host: ${url.host}`);
  }
  return url.toString();
}

export const INJECTED_BRIDGE_SOURCE = `
(() => {
  const BRIDGE_KEY = "__piDeepSeekBridge";
  if (window[BRIDGE_KEY]) return window[BRIDGE_KEY];
  window[BRIDGE_KEY] = {
    getPageState() {
      return {
        inputReady: true,
        busy: false,
        latestAssistantPreview: null
      };
    }
  };
  return window[BRIDGE_KEY];
})();
`;
```

```ts
// src/helper/browser/bb-browser-client.ts
import type { BrowserAutomationClient, BindResult, SendChatResult } from "./types";
import { HelperError } from "../errors";
import { assertDeepSeekUrl, INJECTED_BRIDGE_SOURCE } from "./deepseek-page-bridge";

export interface BbBrowserTransport {
  getConnectionStatus(): Promise<"connected" | "disconnected">;
  findDeepSeekTab(): Promise<{ id: string; url: string }>;
  evaluate<T>(tabId: string, script: string, args?: Record<string, unknown>): Promise<T>;
}

export class BbBrowserClient implements BrowserAutomationClient {
  constructor(private readonly transport: BbBrowserTransport) {}

  async getConnectionStatus() {
    return this.transport.getConnectionStatus();
  }

  async bindDeepSeekTab(): Promise<BindResult> {
    const tab = await this.transport.findDeepSeekTab();
    const normalizedUrl = assertDeepSeekUrl(tab.url);
    await this.transport.evaluate(tab.id, INJECTED_BRIDGE_SOURCE);

    return {
      tabId: tab.id,
      url: normalizedUrl,
      loginState: "logged_in",
      bridgeInjected: true,
      pageState: {
        inputReady: true,
        busy: false,
        latestAssistantPreview: null,
      },
    };
  }

  async resetPageBridge(_tabId: string): Promise<void> {}

  async sendChatPrompt(input: {
    tabId: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<SendChatResult> {
    const result = await this.transport.evaluate<{
      ok: boolean;
      reply?: string;
      error?: "TIMEOUT" | "AUTOMATION_DESYNC";
    }>(input.tabId, "window.__piDeepSeekBridge.sendPrompt(arguments[0])", input);

    if (!result.ok && result.error === "TIMEOUT") {
      throw new HelperError("TIMEOUT", "The page did not finish streaming in time");
    }

    if (!result.ok) {
      throw new HelperError("AUTOMATION_DESYNC", "The page bridge lost sync with DeepSeek");
    }

    return {
      reply: result.reply ?? "",
      modelLabel: "DeepSeek Web",
    };
  }

  async getPageSnapshot(tabId: string) {
    return this.transport.evaluate(tabId, "window.__piDeepSeekBridge.getSnapshot()");
  }
}
```

```ts
// src/helper/browser/types.ts
import type { BrowserConnectionStatus } from "../../shared/contracts";

export interface PageStateSummary {
  inputReady: boolean;
  busy: boolean;
  latestAssistantPreview: string | null;
}

export interface PageSnapshot {
  url: string | null;
  loginState: "logged_in" | "logged_out";
  bridgeHealthy: boolean;
  busy: boolean;
  inputReady: boolean;
  latestAssistantPreview: string | null;
}

export interface BindResult {
  tabId: string;
  url: string;
  loginState: "logged_in" | "logged_out";
  bridgeInjected: boolean;
  pageState: PageStateSummary;
}

export interface SendChatResult {
  reply: string;
  modelLabel?: string;
}

export interface BrowserAutomationClient {
  getConnectionStatus(): Promise<BrowserConnectionStatus>;
  bindDeepSeekTab(): Promise<BindResult>;
  resetPageBridge(tabId: string): Promise<void>;
  sendChatPrompt(input: {
    tabId: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<SendChatResult>;
  getPageSnapshot(tabId: string): Promise<PageSnapshot>;
}
```

```ts
// src/helper/main.ts
import { buildApp } from "./app";
import { BbBrowserClient } from "./browser/bb-browser-client";

const token = process.env.HELPER_TOKEN;
if (!token) {
  throw new Error("HELPER_TOKEN is required");
}

const transport = {
  async getConnectionStatus() {
    return "connected" as const;
  },
  async findDeepSeekTab() {
    throw new Error("Implement bb-browser tab discovery");
  },
  async evaluate() {
    throw new Error("Implement bb-browser script evaluation");
  },
};

const app = buildApp({
  token,
  browserClient: new BbBrowserClient(transport),
});

await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 4318),
});
```

- [ ] **Step 4: Run the helper tests and confirm timeout translation still passes**

Run: `npm test -- tests/helper/chat.test.ts tests/helper/debug.test.ts`
Expected: PASS with all helper route tests green

- [ ] **Step 5: Commit the real browser adapter boundary**

```bash
git add src/helper/browser src/helper/main.ts tests/helper/chat.test.ts
git commit -m "feat: add bb-browser adapter and deepseek bridge boundary"
```

### Task 6: Serve the local debug page with live polling

**Files:**
- Create: `src/helper/public/debug.html`
- Create: `src/helper/public/debug.js`
- Modify: `src/helper/app.ts`
- Test: `tests/helper/debug.test.ts`

- [ ] **Step 1: Extend the debug tests to verify the local `/debug` page is served**

```ts
// append to tests/helper/debug.test.ts
it("serves the local debug page", async () => {
  const app = buildApp({
    token: "test-token",
    browserClient: {
      getConnectionStatus: async () => "connected",
      bindDeepSeekTab: async () => ({
        tabId: "tab-1",
        url: "https://chat.deepseek.com/",
        loginState: "logged_in",
        bridgeInjected: true,
        pageState: { inputReady: true, busy: false, latestAssistantPreview: null },
      }),
      resetPageBridge: async () => undefined,
      sendChatPrompt: async ({ prompt }) => ({
        reply: `echo:${prompt}`,
        modelLabel: "DeepSeek Web",
      }),
      getPageSnapshot: async () => ({
        url: "https://chat.deepseek.com/",
        loginState: "logged_in",
        bridgeHealthy: true,
        busy: false,
        inputReady: true,
        latestAssistantPreview: "echo:hello",
      }),
    } as never,
  });

  const response = await app.inject({
    method: "GET",
    url: "/debug",
    headers: { authorization: "Bearer test-token" },
  });

  expect(response.statusCode).toBe(200);
  expect(response.body).toContain("DeepSeek Bridge Debug");
});
```

- [ ] **Step 2: Run the debug tests and confirm `/debug` fails before the page is added**

Run: `npm test -- tests/helper/debug.test.ts`
Expected: FAIL with `/debug` not found

- [ ] **Step 3: Add the debug page assets and static route**

```html
<!-- src/helper/public/debug.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>DeepSeek Bridge Debug</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: ui-monospace, monospace; margin: 0; background: #111827; color: #e5e7eb; }
      main { display: grid; gap: 16px; padding: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
      section { background: #1f2937; border: 1px solid #374151; border-radius: 12px; padding: 16px; }
      pre { white-space: pre-wrap; word-break: break-word; }
    </style>
  </head>
  <body>
    <main>
      <section><h2>Status</h2><pre id="status"></pre></section>
      <section><h2>Last Call</h2><pre id="last"></pre></section>
      <section><h2>Events</h2><pre id="events"></pre></section>
      <section><h2>Page Snapshot</h2><pre id="snapshot"></pre></section>
    </main>
    <script type="module" src="/debug.js"></script>
  </body>
</html>
```

```js
// src/helper/public/debug.js
const ids = {
  status: document.getElementById("status"),
  last: document.getElementById("last"),
  events: document.getElementById("events"),
  snapshot: document.getElementById("snapshot"),
};

async function readJson(path) {
  const response = await fetch(path, {
    headers: {
      authorization: `Bearer ${new URLSearchParams(location.search).get("token") ?? ""}`,
    },
  });
  return response.json();
}

async function refresh() {
  const [health, last, events, snapshot] = await Promise.all([
    readJson("/v1/health"),
    readJson("/v1/debug/last"),
    readJson("/v1/debug/events"),
    readJson("/v1/debug/page-snapshot"),
  ]);

  ids.status.textContent = JSON.stringify(health, null, 2);
  ids.last.textContent = JSON.stringify(last, null, 2);
  ids.events.textContent = JSON.stringify(events, null, 2);
  ids.snapshot.textContent = JSON.stringify(snapshot, null, 2);
}

setInterval(refresh, 1000);
refresh();
```

```ts
// src/helper/app.ts
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAutomationClient } from "./browser/types";
import { DebugStore } from "./debug-store";
import { registerBindRoute } from "./routes/bind";
import { registerChatRoute } from "./routes/chat";
import { registerDebugRoutes } from "./routes/debug";
import { registerHealthRoute } from "./routes/health";
import { registerResetRoute } from "./routes/reset";
import { HelperState } from "./state";

export interface AppDeps {
  token: string;
  browserClient: BrowserAutomationClient;
}

export interface AppContext {
  browserClient: BrowserAutomationClient;
  state: HelperState;
  debugStore: DebugStore;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify();
  const ctx: AppContext = {
    browserClient: deps.browserClient,
    state: new HelperState(),
    debugStore: new DebugStore(),
  };

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/debug" || request.url === "/debug.js") {
      return;
    }

    if (request.headers.authorization !== `Bearer ${deps.token}`) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  });

  app.get("/debug", async (_request, reply) => {
    reply.type("text/html");
    return readFile(join(process.cwd(), "src/helper/public/debug.html"), "utf8");
  });

  app.get("/debug.js", async (_request, reply) => {
    reply.type("text/javascript");
    return readFile(join(process.cwd(), "src/helper/public/debug.js"), "utf8");
  });

  registerHealthRoute(app, ctx);
  registerBindRoute(app, ctx);
  registerResetRoute(app, ctx);
  registerChatRoute(app, ctx);
  registerDebugRoutes(app, ctx);

  return app;
}
```

- [ ] **Step 4: Run the debug tests and confirm they pass**

Run: `npm test -- tests/helper/debug.test.ts`
Expected: PASS with the debug route tests and `/debug` page test green

- [ ] **Step 5: Commit the local debug page**

```bash
git add src/helper/public src/helper/app.ts tests/helper/debug.test.ts
git commit -m "feat: add local debug page for bridge inspection"
```

### Task 7: Add the `pi` extension wrapper and helper lifecycle tests

**Files:**
- Create: `src/extension/index.ts`
- Create: `tests/extension/index.test.ts`

- [ ] **Step 1: Write the failing extension tests for helper launch and chat forwarding**

```ts
// tests/extension/index.test.ts
import { describe, expect, it } from "vitest";
import { createDeepSeekExtension } from "../../src/extension/index";

describe("pi extension wrapper", () => {
  it("launches the helper with a one-time token and forwards chat", async () => {
    const calls: string[] = [];

    const extension = createDeepSeekExtension({
      spawnHelper: async ({ token }) => {
        calls.push(`spawn:${token.length}`);
        return { baseUrl: "http://127.0.0.1:4318" };
      },
      httpClient: {
        async post(path, body) {
          calls.push(`post:${path}:${body.prompt}`);
          return {
            reply: "reply",
            conversationId: "conv-tab-1",
            rawStatus: "completed",
          };
        },
      },
      randomToken: () => "token-123",
    });

    const response = await extension.chat("hello");

    expect(response.reply).toBe("reply");
    expect(calls).toEqual([
      "spawn:9",
      "post:/v1/chat:hello",
    ]);
  });
});
```

- [ ] **Step 2: Run the extension tests and confirm they fail**

Run: `npm test -- tests/extension/index.test.ts`
Expected: FAIL with `src/extension/index.ts` missing

- [ ] **Step 3: Implement the extension wrapper that owns helper startup and request forwarding**

```ts
// src/extension/index.ts
import type { ChatResponse } from "../shared/contracts";

export interface ExtensionDeps {
  spawnHelper(input: {
    token: string;
  }): Promise<{
    baseUrl: string;
  }>;
  httpClient: {
    post(path: string, body: Record<string, unknown>, token: string): Promise<ChatResponse>;
  };
  randomToken(): string;
}

export function createDeepSeekExtension(deps: ExtensionDeps) {
  let helper:
    | {
        baseUrl: string;
        token: string;
      }
    | undefined;

  async function ensureHelper() {
    if (!helper) {
      const token = deps.randomToken();
      const started = await deps.spawnHelper({ token });
      helper = {
        baseUrl: started.baseUrl,
        token,
      };
    }

    return helper;
  }

  return {
    async chat(prompt: string): Promise<ChatResponse> {
      const current = await ensureHelper();
      return deps.httpClient.post(
        "/v1/chat",
        { prompt },
        current.token,
      );
    },
  };
}
```

- [ ] **Step 4: Run the extension tests and full suite**

Run: `npm test`
Expected: PASS with all helper and extension tests green

- [ ] **Step 5: Commit the extension wrapper**

```bash
git add src/extension tests/extension
git commit -m "feat: add pi extension wrapper for local helper"
```

### Task 8: Replace stubs with real `bb-browser` calls and run manual verification

**Files:**
- Modify: `src/helper/browser/bb-browser-client.ts`
- Modify: `src/helper/browser/deepseek-page-bridge.ts`
- Modify: `src/helper/main.ts`

- [ ] **Step 1: Write the manual verification checklist before changing the live adapter**

```md
1. Start the helper with `HELPER_TOKEN=local-test npm run dev:helper`
2. Open a logged-in DeepSeek tab in the browser managed by `bb-browser`
3. `POST /v1/bind`
4. `POST /v1/chat` with a short prompt
5. Open `http://127.0.0.1:4318/debug?token=<HELPER_TOKEN>`
6. Confirm live event updates, final reply, and page snapshot
7. Refresh the DeepSeek tab and repeat
8. Close the tab and confirm `PAGE_UNAVAILABLE` or `NOT_BOUND`
```

- [ ] **Step 2: Run the current automated test suite before replacing the transport stubs**

Run: `npm test`
Expected: PASS with the suite green before live adapter changes

- [ ] **Step 3: Replace the transport stub with real `bb-browser` commands and a production page bridge**

```ts
// src/helper/main.ts
import { buildApp } from "./app";
import { BbBrowserClient } from "./browser/bb-browser-client";
import { createBbBrowserTransport } from "./browser/bb-browser-client";

const token = process.env.HELPER_TOKEN;
if (!token) {
  throw new Error("HELPER_TOKEN is required");
}

const app = buildApp({
  token,
  browserClient: new BbBrowserClient(createBbBrowserTransport()),
});

await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 4318),
});
```

```ts
// add to src/helper/browser/bb-browser-client.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createBbBrowserTransport(): BbBrowserTransport {
  return {
    async getConnectionStatus() {
      try {
        await execFileAsync("bb-browser", ["ping"]);
        return "connected";
      } catch {
        return "disconnected";
      }
    },
    async findDeepSeekTab() {
      const { stdout } = await execFileAsync("bb-browser", ["tabs", "--json"]);
      const tabs = JSON.parse(stdout) as Array<{ id: string; url: string }>;
      const tab = tabs.find((entry) => entry.url.includes("deepseek.com"));
      if (!tab) {
        throw new HelperError("NOT_BOUND", "No logged-in DeepSeek tab is available");
      }
      return tab;
    },
    async evaluate(tabId, script, args) {
      const { stdout } = await execFileAsync("bb-browser", [
        "evaluate",
        "--tab",
        tabId,
        "--script",
        script,
        "--arg-json",
        JSON.stringify(args ?? {}),
      ]);
      return JSON.parse(stdout);
    },
  };
}
```

```ts
// replace INJECTED_BRIDGE_SOURCE in src/helper/browser/deepseek-page-bridge.ts
export const INJECTED_BRIDGE_SOURCE = `
(() => {
  const KEY = "__piDeepSeekBridge";
  if (window[KEY]) return window[KEY];

  const state = {
    lastReply: "",
    lastHeartbeatAt: null,
  };

  function findComposer() {
    return document.querySelector("textarea");
  }

  function latestAssistantNode() {
    return Array.from(document.querySelectorAll("[data-role='assistant'], .assistant"))
      .at(-1);
  }

  async function waitForReply(timeoutMs) {
    const startedAt = Date.now();
    let previous = "";

    while (Date.now() - startedAt < timeoutMs) {
      const node = latestAssistantNode();
      const next = node ? node.textContent ?? "" : "";
      state.lastHeartbeatAt = new Date().toISOString();
      if (next && next !== previous) {
        previous = next;
        state.lastReply = next;
      }
      if (next && document.querySelector("button[aria-label='Send']")) {
        return { ok: true, reply: next };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return { ok: false, error: "TIMEOUT" };
  }

  window[KEY] = {
    getPageState() {
      const composer = findComposer();
      return {
        inputReady: Boolean(composer),
        busy: Boolean(document.querySelector("button[aria-label='Stop']")),
        latestAssistantPreview: state.lastReply || null,
      };
    },
    getSnapshot() {
      const current = this.getPageState();
      return {
        url: location.href,
        loginState: current.inputReady ? "logged_in" : "logged_out",
        bridgeHealthy: true,
        busy: current.busy,
        inputReady: current.inputReady,
        latestAssistantPreview: current.latestAssistantPreview,
      };
    },
    async sendPrompt({ prompt, timeoutMs }) {
      const composer = findComposer();
      if (!composer) {
        return { ok: false, error: "AUTOMATION_DESYNC" };
      }
      composer.value = prompt;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.form?.requestSubmit();
      return waitForReply(timeoutMs);
    },
  };

  return window[KEY];
})();
`;
```

- [ ] **Step 4: Run the automated suite, then execute the manual verification checklist**

Run: `npm test`
Expected: PASS

Run: `HELPER_TOKEN=local-test npm run dev:helper`
Expected: helper listening on `127.0.0.1:4318`

Manual expected result:
- `/v1/bind` succeeds on a logged-in DeepSeek tab
- `/v1/chat` returns a reply
- `/debug` shows live status, last call, event stream, and page snapshot

- [ ] **Step 5: Commit the live adapter integration**

```bash
git add src/helper
git commit -m "feat: connect helper to bb-browser and deepseek page bridge"
```

## Self-Review

### Spec Coverage

- Local-only helper and extension boundary: covered by Tasks 1, 7, and 8
- Health, bind, reset, and chat APIs: covered by Tasks 1, 2, and 3
- Stable error model and one-request serialization: covered by Task 3
- Debug endpoints and local debug page: covered by Tasks 4 and 6
- `bb-browser` and page-bridge integration: covered by Task 5 and finalized in Task 8
- Real-time observability and page snapshot inspection: covered by Tasks 4, 6, and 8

### Placeholder Scan

- No `TBD`, `TODO`, or “implement later” markers remain in the plan.
- Every coding step contains concrete file contents or appendable code blocks.
- Every task includes an explicit verification command and expected outcome.

### Type Consistency

- `conversationId`, `modelLabel`, and `rawStatus` are used consistently across shared contracts, helper responses, and extension forwarding.
- The normalized error codes are the same in the plan, helper errors, and route responses.
- `BrowserAutomationClient` owns all browser-side operations throughout the plan, so tests can continue to use fakes.
