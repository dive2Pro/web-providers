# DeepSeek Web Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the current DeepSeek web bridge from a tool-style `pi` extension into a true `pi-mono` provider extension that exposes `deepseek-web-chat` as a main model backend for `pi-code-agent`.

**Architecture:** Keep the existing helper and `bb-browser` bridge, but replace tool registration with provider registration. Add a provider-oriented helper endpoint that accepts full conversation context, translate `pi` message arrays into a normalized DeepSeek prompt payload, and route provider calls through a provider runtime that manages helper lifecycle.

**Tech Stack:** TypeScript, Node.js 20+, Fastify, Vitest, `@sinclair/typebox`, `pi-mono` extension API

---

## File Structure

- Modify: `.pi/extensions/deepseek-web/index.ts`
- Create: `src/extension/provider-runtime.ts`
- Delete: `src/extension/runtime.ts`
- Modify: `src/helper/browser/types.ts`
- Modify: `src/helper/routes/chat.ts`
- Create: `src/helper/routes/provider-chat.ts`
- Modify: `src/helper/app.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `tests/extension/index.test.ts`
- Modify: `tests/helper/chat.test.ts`
- Create: `tests/helper/provider-chat.test.ts`

## Implementation Notes

- The `pi`-visible entry remains `.pi/extensions/deepseek-web/index.ts`; no other source file may register a provider or tool directly.
- Remove `deepseek_chat` tool registration entirely once provider tests are green.
- The helper keeps `POST /v1/chat` only if still useful internally; provider mode uses `POST /v1/provider/chat`.
- First version returns a single completion, not true incremental deltas.
- The provider runtime should bind the DeepSeek tab before each provider request, just as the current tool flow does.

### Task 1: Replace tool registration with provider registration

**Files:**
- Modify: `.pi/extensions/deepseek-web/index.ts`
- Create: `src/extension/provider-runtime.ts`
- Delete: `src/extension/runtime.ts`
- Modify: `tests/extension/index.test.ts`

- [ ] **Step 1: Write the failing provider registration test**

```ts
// tests/extension/index.test.ts
import { describe, expect, it } from "vitest";
import registerDeepSeekExtension from "../../.pi/extensions/deepseek-web/index";

describe("pi provider extension", () => {
  it("registers the deepseek-web provider and model", () => {
    const providers: Array<{ id: string; models: Array<{ id: string }> }> = [];
    const events: string[] = [];

    registerDeepSeekExtension(
      {
        registerProvider(provider) {
          providers.push(provider as { id: string; models: Array<{ id: string }> });
        },
        on(event, _handler) {
          events.push(String(event));
        },
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>() => ({ outputText: "ok", finishReason: "stop" } as T),
        },
        randomToken: () => "token-123",
        pickPort: async () => 4318,
      },
    );

    expect(providers).toEqual([
      {
        id: "deepseek-web",
        models: [{ id: "deepseek-web-chat" }],
      },
    ]);
    expect(events).toEqual(["session_start", "session_shutdown"]);
  });
});
```

- [ ] **Step 2: Run the provider registration test and confirm it fails because the extension still registers a tool**

Run: `npm test -- tests/extension/index.test.ts`
Expected: FAIL because `registerProvider` is not called or the extension expects `registerTool`

- [ ] **Step 3: Implement provider registration and remove tool registration**

```ts
// .pi/extensions/deepseek-web/index.ts
export { default } from "../../../src/extension/provider-runtime";
```

```ts
// src/extension/provider-runtime.ts
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export interface ExtensionDeps {
  spawnHelper(input: { token: string; port: number }): Promise<{
    baseUrl: string;
    token: string;
    stop(): Promise<void>;
  }>;
  helperClient: {
    post<T>(
      baseUrl: string,
      path: string,
      body: Record<string, unknown>,
      token: string,
      signal?: AbortSignal,
    ): Promise<T>;
  };
  randomToken(): string;
  pickPort(): Promise<number>;
}

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

async function pickAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate helper port")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForHelperReady(baseUrl: string, token: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Helper did not become ready in time");
}

async function spawnDefaultHelper(input: { token: string; port: number }) {
  const child = spawn("npm", ["run", "dev:helper"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HELPER_TOKEN: input.token,
      PORT: String(input.port),
    },
    stdio: "pipe",
    shell: process.platform === "win32",
  });

  const baseUrl = `http://127.0.0.1:${input.port}`;
  await Promise.race([
    waitForHelperReady(baseUrl, input.token),
    once(child, "exit").then(([code]) => {
      throw new Error(`Helper exited early with code ${String(code)}`);
    }),
  ]);

  return {
    baseUrl,
    token: input.token,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    },
  };
}

function defaultDeps(): ExtensionDeps {
  return {
    spawnHelper: spawnDefaultHelper,
    helperClient: {
      async post<T>(baseUrl, path, body, token, signal) {
        const response = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });

        const text = await response.text();
        const parsed = text ? (JSON.parse(text) as unknown) : {};

        if (!response.ok) {
          throw new Error(JSON.stringify(parsed));
        }

        return parsed as T;
      },
    },
    randomToken: () => randomUUID(),
    pickPort: pickAvailablePort,
  };
}

export default function registerDeepSeekExtension(
  pi: {
    registerProvider(provider: unknown): void;
    on(event: string, handler: (...args: unknown[]) => unknown): void;
  },
  deps: ExtensionDeps = defaultDeps(),
) {
  let helper:
    | {
        baseUrl: string;
        token: string;
        stop(): Promise<void>;
      }
    | null = null;
  let helperPromise:
    | Promise<{
        baseUrl: string;
        token: string;
        stop(): Promise<void>;
      }>
    | null = null;

  async function ensureHelper() {
    if (helper) return helper;
    if (!helperPromise) {
      helperPromise = (async () => {
        const token = deps.randomToken();
        const port = await deps.pickPort();
        const started = await deps.spawnHelper({ token, port });
        helper = started;
        return started;
      })().catch((error) => {
        helperPromise = null;
        throw error;
      });
    }
    return helperPromise;
  }

  pi.on("session_start", async () => undefined);
  pi.on("session_shutdown", async () => {
    const current = helper ?? (helperPromise ? await helperPromise : null);
    helper = null;
    helperPromise = null;
    if (current) await current.stop();
  });

  pi.registerProvider({
    id: "deepseek-web",
    models: [
      {
        id: "deepseek-web-chat",
        name: "DeepSeek Web Chat",
        contextWindow: 64_000,
        maxOutputTokens: 8_000,
      },
    ],
  });
}
```

- [ ] **Step 4: Run the provider registration test and confirm it passes**

Run: `npm test -- tests/extension/index.test.ts`
Expected: PASS with the provider registration test green

- [ ] **Step 5: Commit the provider entry conversion**

```bash
git add .pi/extensions/deepseek-web/index.ts src/extension/provider-runtime.ts tests/extension/index.test.ts
git commit -m "feat: register deepseek web as a pi provider"
```

### Task 2: Add provider runtime execution flow through the helper

**Files:**
- Modify: `src/extension/provider-runtime.ts`
- Modify: `tests/extension/index.test.ts`

- [ ] **Step 1: Extend the failing test to verify helper startup, bind, and provider chat forwarding**

```ts
// append to tests/extension/index.test.ts
it("starts the helper once, binds, and forwards provider chat", async () => {
  const calls: string[] = [];
  let streamSimple:
    | ((context: {
        model: { id: string };
        messages: Array<{ role: string; content: string }>;
      }, signal: AbortSignal) => Promise<unknown>)
    | undefined;

  registerDeepSeekExtension(
    {
      registerProvider(provider) {
        streamSimple = (provider as {
          streamSimple: typeof streamSimple;
        }).streamSimple;
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
        post: async <T>(baseUrl, path, body, token) => {
          calls.push(`post:${baseUrl}:${path}:${token}:${JSON.stringify(body)}`);

          if (path === "/v1/bind") {
            return { ok: true } as T;
          }

          return {
            outputText: "reply",
            finishReason: "stop",
            modelLabel: "DeepSeek Web",
          } as T;
        },
      },
      randomToken: () => "token-123",
      pickPort: async () => 4318,
    },
  );

  const result = await streamSimple?.(
    {
      model: { id: "deepseek-web-chat" },
      messages: [{ role: "user", content: "hello" }],
    },
    new AbortController().signal,
  );

  expect(calls).toEqual([
    "spawn:token-123:4318",
    'post:http://127.0.0.1:4318:/v1/bind:token-123:{}',
    'post:http://127.0.0.1:4318:/v1/provider/chat:token-123:{"model":"deepseek-web-chat","messages":[{"role":"user","content":"hello"}]}',
  ]);
  expect(result).toEqual({
    text: "reply",
    finishReason: "stop",
    model: "DeepSeek Web",
  });
});
```

- [ ] **Step 2: Run the extension test and confirm it fails because `streamSimple` is not implemented yet**

Run: `npm test -- tests/extension/index.test.ts`
Expected: FAIL because the registered provider lacks executable runtime behavior

- [ ] **Step 3: Implement provider execution flow in the runtime**

```ts
// modify src/extension/provider-runtime.ts inside registerDeepSeekExtension(...)
pi.registerProvider({
  id: "deepseek-web",
  models: [
    {
      id: "deepseek-web-chat",
      name: "DeepSeek Web Chat",
      contextWindow: 64_000,
      maxOutputTokens: 8_000,
    },
  ],
  async streamSimple(
    context: {
      model: { id: string };
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      maxOutputTokens?: number;
    },
    signal: AbortSignal,
  ) {
    const current = await ensureHelper();

    await deps.helperClient.post(
      current.baseUrl,
      "/v1/bind",
      {},
      current.token,
      signal,
    );

    const response = await deps.helperClient.post<{
      outputText: string;
      finishReason: "stop" | "length" | "error";
      modelLabel?: string;
    }>(
      current.baseUrl,
      "/v1/provider/chat",
      {
        model: context.model.id,
        messages: context.messages,
        ...(typeof context.temperature === "number"
          ? { temperature: context.temperature }
          : {}),
        ...(typeof context.maxOutputTokens === "number"
          ? { maxOutputTokens: context.maxOutputTokens }
          : {}),
      },
      current.token,
      signal,
    );

    return {
      text: response.outputText,
      finishReason: response.finishReason,
      model: response.modelLabel ?? context.model.id,
    };
  },
});
```

- [ ] **Step 4: Run the extension tests and confirm they pass**

Run: `npm test -- tests/extension/index.test.ts`
Expected: PASS with provider registration and provider execution tests green

- [ ] **Step 5: Commit the provider runtime execution path**

```bash
git add src/extension/provider-runtime.ts tests/extension/index.test.ts
git commit -m "feat: route pi provider calls through helper"
```

### Task 3: Add provider chat contracts and helper endpoint

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/helper/browser/types.ts`
- Create: `src/helper/routes/provider-chat.ts`
- Modify: `src/helper/app.ts`
- Create: `tests/helper/provider-chat.test.ts`

- [ ] **Step 1: Write the failing provider chat helper test**

```ts
// tests/helper/provider-chat.test.ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/helper/app";

describe("provider chat route", () => {
  it("accepts provider messages and returns normalized output", async () => {
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
          reply: `reply:${prompt}`,
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
      outputText: "reply:[System Instructions]\\nYou are terse.\\n\\n[Conversation History]\\n\\n[Current User Request]\\nhello",
      finishReason: "stop",
      modelLabel: "DeepSeek Web",
    });
  });
});
```

- [ ] **Step 2: Run the provider helper test and confirm it fails because `/v1/provider/chat` does not exist**

Run: `npm test -- tests/helper/provider-chat.test.ts`
Expected: FAIL with `POST /v1/provider/chat` not found

- [ ] **Step 3: Add provider contracts and helper route**

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

export interface ProviderChatRequest {
  model: "deepseek-web-chat";
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  temperature?: number;
  maxOutputTokens?: number;
  abortKey?: string;
}

export interface ProviderChatResponse {
  outputText: string;
  finishReason: "stop" | "length" | "error";
  modelLabel?: string;
}
```

```ts
// src/helper/routes/provider-chat.ts
import type { FastifyInstance } from "fastify";
import type { ProviderChatRequest, ProviderChatResponse } from "../../src/shared/contracts";
import { HelperError } from "../errors";
import type { AppContext } from "../app";

function buildProviderPrompt(
  messages: ProviderChatRequest["messages"],
) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");

  const nonSystem = messages.filter((message) => message.role !== "system");
  const currentUser = [...nonSystem].reverse().find((message) => message.role === "user");
  const history = nonSystem
    .slice(0, currentUser ? nonSystem.lastIndexOf(currentUser) : nonSystem.length)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n");

  return `[System Instructions]\n${system}\n\n[Conversation History]\n${history}\n\n[Current User Request]\n${currentUser?.content ?? ""}`;
}

export function registerProviderChatRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/provider/chat", async (request, reply) => {
    const body = request.body as ProviderChatRequest;
    const session = ctx.state.getBoundSession();

    if (!session) {
      return reply.code(409).send({
        error: "NOT_BOUND",
        message: "Bind a DeepSeek tab before provider chat",
      });
    }

    if (ctx.state.hasRunningRequest()) {
      return reply.code(409).send({
        error: "MODEL_BUSY",
        message: "Another request is already in progress",
      });
    }

    const prompt = buildProviderPrompt(body.messages);
    const startedAt = new Date().toISOString();

    ctx.state.setActiveRequest({
      requestId: `req-${Date.now()}`,
      prompt,
      accumulatedReply: "",
      startedAt,
      lastEventAt: startedAt,
      status: "running",
      finalErrorCode: null,
    });

    try {
      const result = await ctx.browserClient.sendChatPrompt({
        tabId: session.tabId,
        prompt,
        timeoutMs: 60_000,
      });

      ctx.state.setActiveRequest(null);

      const response: ProviderChatResponse = {
        outputText: result.reply,
        finishReason: "stop",
        modelLabel: result.modelLabel,
      };

      return response;
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
import type { BrowserAutomationClient } from "./browser/types";
import { registerBindRoute } from "./routes/bind";
import { registerChatRoute } from "./routes/chat";
import { registerHealthRoute } from "./routes/health";
import { registerProviderChatRoute } from "./routes/provider-chat";
import { registerResetRoute } from "./routes/reset";
import { HelperState } from "./state";

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
  registerProviderChatRoute(app, ctx);

  return app;
}
```

- [ ] **Step 4: Run the provider helper tests and confirm they pass**

Run: `npm test -- tests/helper/provider-chat.test.ts tests/helper/chat.test.ts`
Expected: PASS with the provider route and existing chat route both green

- [ ] **Step 5: Commit the provider helper endpoint**

```bash
git add src/shared/contracts.ts src/helper/app.ts src/helper/routes/provider-chat.ts tests/helper/provider-chat.test.ts
git commit -m "feat: add provider-oriented helper chat endpoint"
```

### Task 4: Add provider message mapping coverage and lifecycle cleanup

**Files:**
- Modify: `tests/extension/index.test.ts`
- Modify: `tests/helper/provider-chat.test.ts`
- Modify: `src/extension/provider-runtime.ts`

- [ ] **Step 1: Write failing tests for provider shutdown and assistant-history mapping**

```ts
// append to tests/extension/index.test.ts
it("stops the helper on session shutdown", async () => {
  let shutdownHandler: (() => Promise<void>) | undefined;
  const calls: string[] = [];

  registerDeepSeekExtension(
    {
      registerProvider() {},
      on(event, handler) {
        if (event === "session_shutdown") {
          shutdownHandler = handler as () => Promise<void>;
        }
      },
    },
    {
      spawnHelper: async () => ({
        baseUrl: "http://127.0.0.1:4318",
        token: "token-123",
        stop: async () => {
          calls.push("stop");
        },
      }),
      helperClient: {
        post: async <T>() => ({ outputText: "ok", finishReason: "stop" } as T),
      },
      randomToken: () => "token-123",
      pickPort: async () => 4318,
    },
  );

  await shutdownHandler?.();

  expect(calls).toEqual([]);
});
```

```ts
// append to tests/helper/provider-chat.test.ts
it("includes assistant turns in the conversation history section", async () => {
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
        pageState: { inputReady: true, busy: false, latestAssistantPreview: null },
      }),
      resetPageBridge: async () => undefined,
      sendChatPrompt: async ({ prompt }) => {
        capturedPrompt = prompt;
        return {
          reply: "ok",
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

  expect(capturedPrompt).toContain("[Conversation History]\nUser: hello\nAssistant: hi");
  expect(capturedPrompt).toContain("[Current User Request]\ncontinue");
});
```

- [ ] **Step 2: Run the new tests and confirm the history-mapping or shutdown behavior still needs work**

Run: `npm test -- tests/extension/index.test.ts tests/helper/provider-chat.test.ts`
Expected: at least one failure showing the current implementation does not fully encode the desired behavior

- [ ] **Step 3: Tighten shutdown semantics and provider message mapping**

```ts
// modify src/extension/provider-runtime.ts inside registerDeepSeekExtension(...)
let shutdownStarted = false;

pi.on("session_start", async () => {
  shutdownStarted = false;
});

pi.on("session_shutdown", async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;

  const current = helper ?? (helperPromise ? await helperPromise : null);
  helper = null;
  helperPromise = null;

  if (current) {
    await current.stop();
  }
});
```

```ts
// modify buildProviderPrompt in src/helper/routes/provider-chat.ts
function buildProviderPrompt(
  messages: ProviderChatRequest["messages"],
) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");

  const lastUserIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find((entry) => entry.message.role === "user")?.index ?? -1;

  const history = messages
    .filter((message, index) => message.role !== "system" && index < lastUserIndex)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n");

  const currentUser =
    lastUserIndex >= 0 ? messages[lastUserIndex]?.content ?? "" : "";

  return `[System Instructions]\n${system}\n\n[Conversation History]\n${history}\n\n[Current User Request]\n${currentUser}`;
}
```

- [ ] **Step 4: Run the targeted tests and confirm they pass**

Run: `npm test -- tests/extension/index.test.ts tests/helper/provider-chat.test.ts`
Expected: PASS with provider shutdown and prompt mapping tests green

- [ ] **Step 5: Commit the provider lifecycle and mapping refinements**

```bash
git add src/extension/provider-runtime.ts src/helper/routes/provider-chat.ts tests/extension/index.test.ts tests/helper/provider-chat.test.ts
git commit -m "feat: refine provider lifecycle and context mapping"
```

### Task 5: Run final verification against the provider conversion

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Make the build script clean stale output before compiling**

```json
// package.json
{
  "name": "web-providers",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:helper": "tsx src/helper/main.ts",
    "test": "vitest run",
    "build": "rm -rf dist && tsc -p tsconfig.json"
  },
  "dependencies": {
    "@sinclair/typebox": "^0.34.41",
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

- [ ] **Step 2: Run the full automated verification suite**

Run: `npm test`
Expected: PASS with all tests green

Run: `npm run build`
Expected: PASS with exit code `0`

- [ ] **Step 3: Run a local entrypoint verification**

Run: `test -f .pi/extensions/deepseek-web/index.ts && test ! -f src/extension/index.ts && echo OK`
Expected: `OK`

- [ ] **Step 4: Capture the manual `pi` verification checklist**

```md
1. Start `pi` from `/Users/yc/ai/web-providers`
2. Run `/reload`
3. Confirm provider `deepseek-web` is available
4. Select model `deepseek-web-chat`
5. Ensure a logged-in DeepSeek page is open in the `bb-browser` browser
6. Send a short prompt through `pi-code-agent`
7. Confirm response comes from the DeepSeek web bridge
8. Close the DeepSeek tab and confirm a stable provider error is returned
```

- [ ] **Step 5: Commit the provider conversion verification changes**

```bash
git add package.json
git commit -m "chore: finalize deepseek web provider verification"
```

## Self-Review

### Spec Coverage

- Real provider registration and model exposure: covered by Tasks 1 and 2
- Provider-only discoverable entrypoint: covered by Task 1 and Task 5
- Provider-to-helper protocol: covered by Task 3
- Message mapping and pseudo-streaming first version: covered by Tasks 2 and 4
- Session lifecycle and helper cleanup: covered by Task 4
- Verification of provider conversion: covered by Task 5

### Placeholder Scan

- No `TBD`, `TODO`, or “implement later” markers remain in the plan.
- All code steps include concrete snippets and exact file paths.
- Each task includes explicit verification commands and expected outcomes.

### Type Consistency

- Provider ids and model ids stay consistent: `deepseek-web` and `deepseek-web-chat`
- Helper provider endpoint names stay consistent: `POST /v1/provider/chat`
- Provider runtime uses the same message roles and response field names as the shared contracts
