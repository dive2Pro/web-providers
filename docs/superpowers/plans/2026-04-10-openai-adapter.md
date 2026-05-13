# OpenAI Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `openai-adapter` service that exposes OpenAI-compatible `models`, `chat/completions`, and `responses` endpoints on top of the existing helper service.

**Architecture:** Add a new `src/openai-adapter` subtree with a small Fastify app, a model registry, request normalizers, a helper HTTP client, serializers, and a shared error translator. Keep the existing helper unchanged except for consuming its current HTTP contract from the adapter. Drive the work through tests first, using stubbed helper responses for adapter coverage.

**Tech Stack:** TypeScript, Fastify, Vitest, Node `fetch`

---

## File Structure

### New files

- `src/openai-adapter/app.ts`: Fastify app builder, auth hook, route registration
- `src/openai-adapter/main.ts`: runtime entrypoint for the adapter service
- `src/openai-adapter/config.ts`: env loading and adapter config types
- `src/openai-adapter/models.ts`: public model registry and lookup helpers
- `src/openai-adapter/types.ts`: normalized request and execution result types
- `src/openai-adapter/helper-client.ts`: HTTP client for the helper service
- `src/openai-adapter/normalize.ts`: convert Chat Completions and Responses requests into one normalized shape
- `src/openai-adapter/serialize-chat.ts`: serialize normalized execution results to Chat Completions payloads
- `src/openai-adapter/serialize-responses.ts`: serialize normalized execution results to Responses payloads
- `src/openai-adapter/errors.ts`: public error envelope and helper-to-adapter error mapping
- `src/openai-adapter/routes/models.ts`: `GET /v1/models`
- `src/openai-adapter/routes/chat-completions.ts`: `POST /v1/chat/completions`
- `src/openai-adapter/routes/responses.ts`: `POST /v1/responses`
- `tests/openai-adapter/models.test.ts`: registry coverage
- `tests/openai-adapter/normalize.test.ts`: request normalization coverage
- `tests/openai-adapter/serialize-chat.test.ts`: chat serializer coverage
- `tests/openai-adapter/serialize-responses.test.ts`: responses serializer coverage
- `tests/openai-adapter/app.test.ts`: route, auth, helper-client, and error translation coverage

### Existing files to modify

- `package.json`: add a `dev:openai-adapter` script

## Task 1: Create the adapter model registry

**Files:**
- Create: `src/openai-adapter/models.ts`
- Test: `tests/openai-adapter/models.test.ts`

- [ ] **Step 1: Write the failing registry tests**

```ts
import { describe, expect, it } from "vitest";
import {
  getPublicModel,
  listPublicModels,
} from "../../src/openai-adapter/models";

describe("openai adapter model registry", () => {
  it("lists stable public models", () => {
    expect(listPublicModels()).toEqual([
      expect.objectContaining({
        id: "deepseek-web-chat",
        provider: "deepseek-web",
        supportsTools: false,
      }),
      expect.objectContaining({
        id: "deepseek-web-tools",
        provider: "deepseek-web",
        supportsTools: true,
      }),
      expect.objectContaining({
        id: "qwen-web-chat",
        provider: "qwen-web",
        supportsTools: false,
      }),
      expect.objectContaining({
        id: "qwen-web-tools",
        provider: "qwen-web",
        supportsTools: true,
      }),
    ]);
  });

  it("returns a model by public id", () => {
    expect(getPublicModel("qwen-web-tools")).toMatchObject({
      id: "qwen-web-tools",
      provider: "qwen-web",
      supportsTools: true,
      defaultTimeoutMs: 30000,
    });
  });

  it("returns null for an unknown model", () => {
    expect(getPublicModel("missing-model")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/openai-adapter/models.test.ts`
Expected: FAIL with `Cannot find module '../../src/openai-adapter/models'`

- [ ] **Step 3: Write the minimal registry implementation**

```ts
export type PublicModel = {
  id: string;
  provider: "deepseek-web" | "qwen-web";
  supportsTools: boolean;
  defaultTimeoutMs: number;
  allowThinkingText: boolean;
  sessionMode: "reuse-bound-session";
};

const PUBLIC_MODELS: PublicModel[] = [
  {
    id: "deepseek-web-chat",
    provider: "deepseek-web",
    supportsTools: false,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
  },
  {
    id: "deepseek-web-tools",
    provider: "deepseek-web",
    supportsTools: true,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
  },
  {
    id: "qwen-web-chat",
    provider: "qwen-web",
    supportsTools: false,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
  },
  {
    id: "qwen-web-tools",
    provider: "qwen-web",
    supportsTools: true,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
  },
];

export function listPublicModels() {
  return [...PUBLIC_MODELS];
}

export function getPublicModel(modelId: string) {
  return PUBLIC_MODELS.find((model) => model.id === modelId) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/openai-adapter/models.test.ts`
Expected: PASS with 3 tests passed

- [ ] **Step 5: Commit**

```bash
git add tests/openai-adapter/models.test.ts src/openai-adapter/models.ts
git commit -m "feat: add openai adapter model registry"
```

## Task 2: Add normalized request types and parsers

**Files:**
- Create: `src/openai-adapter/types.ts`
- Create: `src/openai-adapter/normalize.ts`
- Test: `tests/openai-adapter/normalize.test.ts`

- [ ] **Step 1: Write failing normalization tests**

```ts
import { describe, expect, it } from "vitest";
import {
  normalizeChatCompletionsRequest,
  normalizeResponsesRequest,
} from "../../src/openai-adapter/normalize";
import { getPublicModel } from "../../src/openai-adapter/models";

describe("openai adapter normalization", () => {
  const toolModel = getPublicModel("deepseek-web-tools");
  const chatModel = getPublicModel("qwen-web-chat");

  it("normalizes a chat completions request with tools", () => {
    const normalized = normalizeChatCompletionsRequest(
      {
        model: "deepseek-web-tools",
        messages: [{ role: "user", content: "list files" }],
        tools: [
          {
            type: "function",
            function: {
              name: "list_files",
              description: "List files",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: 120,
      },
      toolModel!,
    );

    expect(normalized).toMatchObject({
      publicModel: "deepseek-web-tools",
      provider: "deepseek-web",
      responseFormat: "chat_completions",
      toolChoice: "auto",
      temperature: 0.2,
      maxOutputTokens: 120,
      messages: [{ role: "user", content: "list files" }],
      tools: [
        {
          name: "list_files",
          description: "List files",
        },
      ],
    });
  });

  it("normalizes a responses request without tools", () => {
    const normalized = normalizeResponsesRequest(
      {
        model: "qwen-web-chat",
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: "Be terse." }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
      },
      chatModel!,
    );

    expect(normalized).toMatchObject({
      publicModel: "qwen-web-chat",
      provider: "qwen-web",
      responseFormat: "responses",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hello" },
      ],
      tools: [],
      toolChoice: "none",
    });
  });

  it("rejects streaming chat completions requests", () => {
    expect(() =>
      normalizeChatCompletionsRequest(
        {
          model: "deepseek-web-chat",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
        getPublicModel("deepseek-web-chat")!,
      ),
    ).toThrowError("Streaming is not supported");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/openai-adapter/normalize.test.ts`
Expected: FAIL with `Cannot find module '../../src/openai-adapter/normalize'`

- [ ] **Step 3: Add normalized types and parser implementation**

```ts
export type NormalizedMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type NormalizedTool = {
  name: string;
  description?: string;
  parametersJson: string;
};

export type NormalizedToolChoice =
  | "auto"
  | "none"
  | { type: "function"; name: string };

export type NormalizedRequest = {
  publicModel: string;
  provider: "deepseek-web" | "qwen-web";
  responseFormat: "chat_completions" | "responses";
  messages: NormalizedMessage[];
  tools: NormalizedTool[];
  toolChoice: NormalizedToolChoice;
  temperature?: number;
  maxOutputTokens?: number;
};

function textFromResponseInput(
  content: Array<{ type: string; text?: string }>,
) {
  return content
    .filter((item) => item.type === "input_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

export function normalizeChatCompletionsRequest(body: any, model: any): NormalizedRequest {
  if (body.stream === true) {
    throw new Error("Streaming is not supported");
  }

  return {
    publicModel: model.id,
    provider: model.provider,
    responseFormat: "chat_completions",
    messages: (body.messages ?? []).map((message: any) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content : "",
    })),
    tools: (body.tools ?? []).map((tool: any) => ({
      name: tool.function.name,
      description: tool.function.description,
      parametersJson: JSON.stringify(tool.function.parameters ?? {}),
    })),
    toolChoice:
      body.tool_choice === undefined ? "none" : body.tool_choice,
    temperature:
      typeof body.temperature === "number" ? body.temperature : undefined,
    maxOutputTokens:
      typeof body.max_tokens === "number" ? body.max_tokens : undefined,
  };
}

export function normalizeResponsesRequest(body: any, model: any): NormalizedRequest {
  if (body.stream === true) {
    throw new Error("Streaming is not supported");
  }

  return {
    publicModel: model.id,
    provider: model.provider,
    responseFormat: "responses",
    messages: (body.input ?? []).map((message: any) => ({
      role: message.role,
      content: textFromResponseInput(message.content ?? []),
    })),
    tools: (body.tools ?? []).map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      parametersJson: JSON.stringify(tool.parameters ?? {}),
    })),
    toolChoice: body.tool_choice ?? "none",
    temperature:
      typeof body.temperature === "number" ? body.temperature : undefined,
    maxOutputTokens:
      typeof body.max_output_tokens === "number"
        ? body.max_output_tokens
        : undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/openai-adapter/normalize.test.ts`
Expected: PASS with 3 tests passed

- [ ] **Step 5: Commit**

```bash
git add tests/openai-adapter/normalize.test.ts src/openai-adapter/types.ts src/openai-adapter/normalize.ts
git commit -m "feat: add openai adapter request normalization"
```

## Task 3: Add serializers for Chat Completions and Responses

**Files:**
- Create: `src/openai-adapter/serialize-chat.ts`
- Create: `src/openai-adapter/serialize-responses.ts`
- Test: `tests/openai-adapter/serialize-chat.test.ts`
- Test: `tests/openai-adapter/serialize-responses.test.ts`

- [ ] **Step 1: Write failing serializer tests**

```ts
import { describe, expect, it } from "vitest";
import { serializeChatCompletions } from "../../src/openai-adapter/serialize-chat";
import { serializeResponses } from "../../src/openai-adapter/serialize-responses";

describe("chat completions serializer", () => {
  it("serializes text output", () => {
    expect(
      serializeChatCompletions({
        id: "resp-1",
        created: 1710000000,
        model: "qwen-web-chat",
        result: {
          mode: "text",
          outputText: "hello",
          finishReason: "stop",
          modelLabel: "Qwen Web",
        },
      }),
    ).toMatchObject({
      id: "resp-1",
      object: "chat.completion",
      model: "qwen-web-chat",
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "hello",
          },
        },
      ],
    });
  });

  it("serializes tool call output", () => {
    expect(
      serializeChatCompletions({
        id: "resp-2",
        created: 1710000000,
        model: "deepseek-web-tools",
        result: {
          mode: "native_tool_call",
          toolCall: {
            name: "read_file",
            argumentsJson: "{\"path\":\"src/index.ts\"}",
          },
          finishReason: "stop",
        },
      }),
    ).toMatchObject({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [
              {
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"src/index.ts\"}",
                },
              },
            ],
          },
        },
      ],
    });
  });
});

describe("responses serializer", () => {
  it("serializes text output", () => {
    expect(
      serializeResponses({
        id: "resp-3",
        created: 1710000000,
        model: "qwen-web-chat",
        result: {
          mode: "text",
          outputText: "done",
          finishReason: "stop",
        },
      }),
    ).toMatchObject({
      id: "resp-3",
      object: "response",
      model: "qwen-web-chat",
      output: [
        {
          type: "message",
          role: "assistant",
        },
      ],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/openai-adapter/serialize-chat.test.ts tests/openai-adapter/serialize-responses.test.ts`
Expected: FAIL with missing serializer modules

- [ ] **Step 3: Implement the serializers**

```ts
function toFinishReason(result: {
  mode: "text" | "native_tool_call" | "json_fallback";
  finishReason: "stop" | "length" | "error";
}) {
  if (result.mode === "text") {
    return result.finishReason;
  }

  return "tool_calls";
}

export function serializeChatCompletions(input: {
  id: string;
  created: number;
  model: string;
  result: {
    mode: "text" | "native_tool_call" | "json_fallback";
    outputText?: string;
    finishReason: "stop" | "length" | "error";
    toolCall?: { name: string; argumentsJson: string };
  };
}) {
  if (input.result.mode === "text") {
    return {
      id: input.id,
      object: "chat.completion",
      created: input.created,
      model: input.model,
      choices: [
        {
          index: 0,
          finish_reason: toFinishReason(input.result),
          message: {
            role: "assistant",
            content: input.result.outputText ?? "",
          },
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `${input.id}-tool-1`,
              type: "function",
              function: {
                name: input.result.toolCall!.name,
                arguments: input.result.toolCall!.argumentsJson,
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function serializeResponses(input: {
  id: string;
  created: number;
  model: string;
  result: {
    mode: "text" | "native_tool_call" | "json_fallback";
    outputText?: string;
    finishReason: "stop" | "length" | "error";
    toolCall?: { name: string; argumentsJson: string };
  };
}) {
  if (input.result.mode === "text") {
    return {
      id: input.id,
      object: "response",
      created_at: input.created,
      model: input.model,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: input.result.outputText ?? "",
            },
          ],
        },
      ],
      parallel_tool_calls: false,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  return {
    id: input.id,
    object: "response",
    created_at: input.created,
    model: input.model,
    output: [
      {
        type: "function_call",
        name: input.result.toolCall!.name,
        arguments: input.result.toolCall!.argumentsJson,
        call_id: `${input.id}-tool-1`,
      },
    ],
    parallel_tool_calls: false,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/openai-adapter/serialize-chat.test.ts tests/openai-adapter/serialize-responses.test.ts`
Expected: PASS with serializer tests green

- [ ] **Step 5: Commit**

```bash
git add tests/openai-adapter/serialize-chat.test.ts tests/openai-adapter/serialize-responses.test.ts src/openai-adapter/serialize-chat.ts src/openai-adapter/serialize-responses.ts
git commit -m "feat: add openai adapter response serializers"
```

## Task 4: Add helper client and error translator

**Files:**
- Create: `src/openai-adapter/helper-client.ts`
- Create: `src/openai-adapter/errors.ts`
- Modify: `src/openai-adapter/types.ts`
- Test: `tests/openai-adapter/app.test.ts`

- [ ] **Step 1: Write failing helper-client tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createHelperClient } from "../../src/openai-adapter/helper-client";

describe("openai adapter helper client", () => {
  it("maps normalized requests into helper provider chat payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "text",
        outputText: "helper says hi",
        finishReason: "stop",
      }),
    });

    const client = createHelperClient({
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: fetchMock,
    });

    const result = await client.run({
      publicModel: "qwen-web-chat",
      provider: "qwen-web",
      responseFormat: "chat_completions",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "none",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer helper-token",
        }),
        body: JSON.stringify({
          provider: "qwen-web",
          model: "qwen-web-chat",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );
    expect(result).toMatchObject({
      mode: "text",
      outputText: "helper says hi",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/openai-adapter/app.test.ts`
Expected: FAIL with missing helper client module

- [ ] **Step 3: Implement helper client and error translator**

```ts
export class AdapterError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function mapHelperError(payload: { error?: string; message?: string }) {
  switch (payload.error) {
    case "NOT_BOUND":
      return new AdapterError(409, "provider_not_bound", payload.message ?? "Provider is not bound");
    case "MODEL_BUSY":
      return new AdapterError(429, "model_busy", payload.message ?? "Model is busy");
    case "TIMEOUT":
      return new AdapterError(504, "timeout", payload.message ?? "Request timed out");
    case "AUTOMATION_DESYNC":
    case "PAGE_UNAVAILABLE":
      return new AdapterError(502, "upstream_failure", payload.message ?? "Upstream automation failed");
    default:
      return new AdapterError(500, "internal_error", payload.message ?? "Unexpected helper error");
  }
}

export function createHelperClient(input: {
  helperBaseUrl: string;
  helperToken: string;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async run(request: {
      publicModel: string;
      provider: "deepseek-web" | "qwen-web";
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      tools: Array<{ name: string; description?: string; parametersJson: string }>;
      toolChoice: "auto" | "none" | { type: "function"; name: string };
      temperature?: number;
      maxOutputTokens?: number;
    }) {
      const response = await fetchImpl(
        `${input.helperBaseUrl}/v1/provider/chat`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.helperToken}`,
          },
          body: JSON.stringify({
            provider: request.provider,
            model: request.publicModel,
            messages: request.messages,
            ...(typeof request.temperature === "number"
              ? { temperature: request.temperature }
              : {}),
            ...(typeof request.maxOutputTokens === "number"
              ? { maxOutputTokens: request.maxOutputTokens }
              : {}),
          }),
        },
      );

      const payload = await response.json();
      if (!response.ok) {
        throw mapHelperError(payload);
      }

      return payload;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/openai-adapter/app.test.ts`
Expected: PASS for the helper-client-specific test block

- [ ] **Step 5: Commit**

```bash
git add tests/openai-adapter/app.test.ts src/openai-adapter/helper-client.ts src/openai-adapter/errors.ts src/openai-adapter/types.ts
git commit -m "feat: add openai adapter helper client"
```

## Task 5: Build the adapter app and public routes

**Files:**
- Create: `src/openai-adapter/config.ts`
- Create: `src/openai-adapter/app.ts`
- Create: `src/openai-adapter/main.ts`
- Create: `src/openai-adapter/routes/models.ts`
- Create: `src/openai-adapter/routes/chat-completions.ts`
- Create: `src/openai-adapter/routes/responses.ts`
- Modify: `package.json`
- Test: `tests/openai-adapter/app.test.ts`

- [ ] **Step 1: Expand the app integration tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAiAdapterApp } from "../../src/openai-adapter/app";

describe("openai adapter app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires bearer auth for public routes", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Unauthorized",
      },
    });
  });

  it("returns the public model list", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer adapter-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [
        { id: "deepseek-web-chat", object: "model" },
        { id: "qwen-web-tools", object: "model" },
      ],
    });
  });

  it("returns chat completions payloads from helper text output", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          mode: "text",
          outputText: "hello from helper",
          finishReason: "stop",
        }),
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer adapter-token",
      },
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
        {
          message: {
            role: "assistant",
            content: "hello from helper",
          },
        },
      ],
    });
  });

  it("returns responses payloads from helper tool calls", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          mode: "json_fallback",
          toolCall: {
            name: "read_file",
            argumentsJson: "{\"path\":\"src/helper/main.ts\"}",
          },
          finishReason: "stop",
        }),
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer adapter-token",
      },
      payload: {
        model: "deepseek-web-tools",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "read helper main" }],
          },
        ],
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "response",
      model: "deepseek-web-tools",
      output: [
        {
          type: "function_call",
          name: "read_file",
        },
      ],
    });
  });

  it("translates helper errors into stable public errors", async () => {
    const app = buildOpenAiAdapterApp({
      token: "adapter-token",
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: "NOT_BOUND",
          message: "Bind a deepseek-web tab before provider chat",
        }),
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer adapter-token",
      },
      payload: {
        model: "deepseek-web-chat",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "provider_not_bound",
        message: "Bind a deepseek-web tab before provider chat",
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/openai-adapter/app.test.ts`
Expected: FAIL because `buildOpenAiAdapterApp` and the routes do not exist

- [ ] **Step 3: Implement the adapter app and route handlers**

```ts
import Fastify from "fastify";
import { createHelperClient } from "./helper-client";
import { getPublicModel, listPublicModels } from "./models";
import {
  normalizeChatCompletionsRequest,
  normalizeResponsesRequest,
} from "./normalize";
import { AdapterError } from "./errors";
import { serializeChatCompletions } from "./serialize-chat";
import { serializeResponses } from "./serialize-responses";

export function buildOpenAiAdapterApp(input: {
  token: string;
  helperBaseUrl: string;
  helperToken: string;
  fetchImpl?: typeof fetch;
}) {
  const app = Fastify();
  const helperClient = createHelperClient({
    helperBaseUrl: input.helperBaseUrl,
    helperToken: input.helperToken,
    fetchImpl: input.fetchImpl,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${input.token}`) {
      return reply.code(401).send({
        error: {
          code: "unauthorized",
          message: "Unauthorized",
        },
      });
    }
  });

  app.get("/v1/models", async () => ({
    object: "list",
    data: listPublicModels().map((model) => ({
      id: model.id,
      object: "model",
      owned_by: "web-providers",
    })),
  }));

  app.post("/v1/chat/completions", async (request, reply) => {
    try {
      const body = request.body as any;
      const model = getPublicModel(body.model);
      if (!model) {
        throw new AdapterError(404, "model_not_found", `Unknown model: ${body.model}`);
      }

      const normalized = normalizeChatCompletionsRequest(body, model);
      const result = await helperClient.run(normalized);
      return serializeChatCompletions({
        id: `chatcmpl-${Date.now()}`,
        created: Math.floor(Date.now() / 1000),
        model: normalized.publicModel,
        result,
      });
    } catch (error) {
      if (error instanceof AdapterError) {
        return reply.code(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
          },
        });
      }
      throw error;
    }
  });

  app.post("/v1/responses", async (request, reply) => {
    try {
      const body = request.body as any;
      const model = getPublicModel(body.model);
      if (!model) {
        throw new AdapterError(404, "model_not_found", `Unknown model: ${body.model}`);
      }

      const normalized = normalizeResponsesRequest(body, model);
      const result = await helperClient.run(normalized);
      return serializeResponses({
        id: `resp-${Date.now()}`,
        created: Math.floor(Date.now() / 1000),
        model: normalized.publicModel,
        result,
      });
    } catch (error) {
      if (error instanceof AdapterError) {
        return reply.code(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
          },
        });
      }
      throw error;
    }
  });

  return app;
}
```

```ts
import { buildOpenAiAdapterApp } from "./app";

const token = process.env.OPENAI_ADAPTER_TOKEN;
const helperBaseUrl = process.env.HELPER_BASE_URL;
const helperToken = process.env.HELPER_TOKEN;

if (!token) {
  throw new Error("OPENAI_ADAPTER_TOKEN is required");
}

if (!helperBaseUrl) {
  throw new Error("HELPER_BASE_URL is required");
}

if (!helperToken) {
  throw new Error("HELPER_TOKEN is required");
}

const app = buildOpenAiAdapterApp({
  token,
  helperBaseUrl,
  helperToken,
});

await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 4319),
});
```

```json
{
  "scripts": {
    "dev:openai-adapter": "tsx src/openai-adapter/main.ts"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/openai-adapter/app.test.ts`
Expected: PASS with route and auth coverage green

- [ ] **Step 5: Run the adapter test suite**

Run: `npm test -- tests/openai-adapter/models.test.ts tests/openai-adapter/normalize.test.ts tests/openai-adapter/serialize-chat.test.ts tests/openai-adapter/serialize-responses.test.ts tests/openai-adapter/app.test.ts`
Expected: PASS with all adapter tests green

- [ ] **Step 6: Commit**

```bash
git add package.json src/openai-adapter/config.ts src/openai-adapter/app.ts src/openai-adapter/main.ts src/openai-adapter/routes/models.ts src/openai-adapter/routes/chat-completions.ts src/openai-adapter/routes/responses.ts tests/openai-adapter/app.test.ts
git commit -m "feat: add openai adapter service"
```

## Task 6: Verify the whole repo still passes its relevant checks

**Files:**
- Modify: none
- Test: `tests/openai-adapter/*.test.ts`
- Test: `tests/helper/app.test.ts`
- Test: `tests/helper/provider-chat.test.ts`

- [ ] **Step 1: Run adapter and helper regression tests**

Run: `npm test -- tests/openai-adapter/app.test.ts tests/openai-adapter/models.test.ts tests/openai-adapter/normalize.test.ts tests/openai-adapter/serialize-chat.test.ts tests/openai-adapter/serialize-responses.test.ts tests/helper/app.test.ts tests/helper/provider-chat.test.ts`
Expected: PASS with adapter coverage green and no helper regressions

- [ ] **Step 2: Run the full project test suite**

Run: `npm test`
Expected: PASS with Vitest exiting successfully

- [ ] **Step 3: Run the TypeScript build**

Run: `npm run build`
Expected: PASS with `tsc -p tsconfig.json` succeeding

- [ ] **Step 4: Commit final verification if code changed during fixes**

```bash
git add package.json src/openai-adapter tests/openai-adapter
git commit -m "test: verify openai adapter integration"
```

## Self-Review

Spec coverage check:

- standalone adapter service: covered in Task 5
- stable public model names: covered in Task 1
- shared normalization for chat and responses: covered in Task 2
- helper client boundary: covered in Task 4
- chat and responses serializers: covered in Task 3
- non-streaming-only behavior: covered in Task 2 and Task 5 tests
- error translation: covered in Task 4 and Task 5 tests
- auth separation and public entrypoint: covered in Task 5
- verification and regressions: covered in Task 6

Placeholder scan:

- no `TODO`, `TBD`, or deferred implementation markers remain
- every task includes exact files, commands, and code snippets

Type consistency check:

- `publicModel`, `provider`, `tools`, `toolChoice`, and `maxOutputTokens` are used consistently across tasks
- `buildOpenAiAdapterApp` is defined once and used consistently in tests and runtime entrypoint
