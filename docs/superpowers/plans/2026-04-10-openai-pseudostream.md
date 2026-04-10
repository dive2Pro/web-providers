# OpenAI Pseudo-Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add buffered pseudo-stream support to the OpenAI adapter so `stream: true` returns OpenAI-style SSE for both text and tool-call responses.

**Architecture:** Keep helper execution unchanged and non-streaming. Add adapter-side stream serializers for Chat Completions and Responses, then branch route behavior on `stream === true` to replay a completed helper result as SSE. Preserve current JSON behavior for non-streaming requests and keep pre-replay errors as normal JSON errors.

**Tech Stack:** TypeScript, Fastify, Vitest, Node streams/SSE response writing

---

## File Structure

### New files

- `src/openai-adapter/streaming/types.ts`: shared stream serializer input and chunk event helper types
- `src/openai-adapter/streaming/chat-completions.ts`: Chat Completions SSE serializer
- `src/openai-adapter/streaming/responses.ts`: Responses SSE serializer
- `tests/openai-adapter/streaming-chat.test.ts`: Chat Completions pseudo-stream tests
- `tests/openai-adapter/streaming-responses.test.ts`: Responses pseudo-stream tests

### Existing files to modify

- `src/openai-adapter/routes/chat-completions.ts`: branch between JSON and SSE responses
- `src/openai-adapter/routes/responses.ts`: branch between JSON and SSE responses
- `src/openai-adapter/app.ts`: keep route registration unchanged, but support streaming response behavior through route handlers
- `src/openai-adapter/errors.ts`: keep existing error mapping and ensure stream preflight errors stay in JSON form
- `tests/openai-adapter/app.test.ts`: integration tests for route-level streaming behavior

## Task 1: Add Chat Completions pseudo-stream serializer

**Files:**
- Create: `src/openai-adapter/streaming/types.ts`
- Create: `src/openai-adapter/streaming/chat-completions.ts`
- Test: `tests/openai-adapter/streaming-chat.test.ts`

- [ ] **Step 1: Write the failing Chat Completions stream tests**

```ts
import { describe, expect, it } from "vitest";
import { serializeChatCompletionsStream } from "../../src/openai-adapter/streaming/chat-completions";

describe("chat completions pseudo-stream serializer", () => {
  it("serializes text output into SSE chunks", () => {
    const chunks = serializeChatCompletionsStream({
      id: "chatcmpl-1",
      created: 1710000000,
      model: "qwen-web-chat",
      result: {
        mode: "text",
        outputText: "hello",
        finishReason: "stop",
      },
    });

    expect(chunks).toEqual([
      expect.stringContaining("\"object\":\"chat.completion.chunk\""),
      expect.stringContaining("\"role\":\"assistant\""),
      expect.stringContaining("\"content\":\"hello\""),
      expect.stringContaining("\"finish_reason\":\"stop\""),
      "data: [DONE]\n\n",
    ]);
  });

  it("serializes tool call output into tool-call SSE chunks", () => {
    const chunks = serializeChatCompletionsStream({
      id: "chatcmpl-2",
      created: 1710000000,
      model: "deepseek-web-tools",
      result: {
        mode: "json_fallback",
        toolCall: {
          name: "ping",
          argumentsJson: "{\"text\":\"hi\"}",
        },
        finishReason: "stop",
      },
    });

    expect(chunks).toEqual([
      expect.stringContaining("\"role\":\"assistant\""),
      expect.stringContaining("\"tool_calls\""),
      expect.stringContaining("\"name\":\"ping\""),
      expect.stringContaining("\\\"text\\\":\\\"hi\\\""),
      expect.stringContaining("\"finish_reason\":\"tool_calls\""),
      "data: [DONE]\n\n",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/openai-adapter/streaming-chat.test.ts`
Expected: FAIL with `Cannot find module '../../src/openai-adapter/streaming/chat-completions'`

- [ ] **Step 3: Implement the minimal Chat Completions stream serializer**

```ts
import type { ExecutionResult } from "../types";

export type StreamInput = {
  id: string;
  created: number;
  model: string;
  result: ExecutionResult;
};

function sse(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function serializeChatCompletionsStream(input: StreamInput) {
  const base = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
  };

  if (input.result.mode === "text") {
    return [
      sse({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }),
      sse({
        ...base,
        choices: [
          {
            index: 0,
            delta: { content: input.result.outputText },
            finish_reason: null,
          },
        ],
      }),
      sse({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
      "data: [DONE]\n\n",
    ];
  }

  return [
    sse({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    }),
    sse({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `${input.id}-tool-1`,
                type: "function",
                function: {
                  name: input.result.toolCall.name,
                  arguments: input.result.toolCall.argumentsJson,
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    sse({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }),
    "data: [DONE]\n\n",
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/openai-adapter/streaming-chat.test.ts`
Expected: PASS with 2 tests passed

- [ ] **Step 5: Commit**

```bash
git add tests/openai-adapter/streaming-chat.test.ts src/openai-adapter/streaming/types.ts src/openai-adapter/streaming/chat-completions.ts
git commit -m "feat: add chat completions pseudo stream serializer"
```

## Task 2: Add Responses pseudo-stream serializer

**Files:**
- Create: `src/openai-adapter/streaming/responses.ts`
- Test: `tests/openai-adapter/streaming-responses.test.ts`

- [ ] **Step 1: Write the failing Responses stream tests**

```ts
import { describe, expect, it } from "vitest";
import { serializeResponsesStream } from "../../src/openai-adapter/streaming/responses";

describe("responses pseudo-stream serializer", () => {
  it("serializes text output into response events", () => {
    const chunks = serializeResponsesStream({
      id: "resp-1",
      created: 1710000000,
      model: "qwen-web-chat",
      result: {
        mode: "text",
        outputText: "hello",
        finishReason: "stop",
      },
    });

    expect(chunks).toEqual([
      expect.stringContaining("\"type\":\"response.created\""),
      expect.stringContaining("\"type\":\"response.output_text.delta\""),
      expect.stringContaining("\"delta\":\"hello\""),
      expect.stringContaining("\"type\":\"response.completed\""),
    ]);
  });

  it("serializes tool call output into function-call events", () => {
    const chunks = serializeResponsesStream({
      id: "resp-2",
      created: 1710000000,
      model: "deepseek-web-tools",
      result: {
        mode: "native_tool_call",
        toolCall: {
          name: "ping",
          argumentsJson: "{\"text\":\"hi\"}",
        },
        finishReason: "stop",
      },
    });

    expect(chunks).toEqual([
      expect.stringContaining("\"type\":\"response.created\""),
      expect.stringContaining("\"type\":\"response.function_call_arguments.delta\""),
      expect.stringContaining("\"name\":\"ping\""),
      expect.stringContaining("\\\"text\\\":\\\"hi\\\""),
      expect.stringContaining("\"type\":\"response.completed\""),
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/openai-adapter/streaming-responses.test.ts`
Expected: FAIL with `Cannot find module '../../src/openai-adapter/streaming/responses'`

- [ ] **Step 3: Implement the minimal Responses stream serializer**

```ts
import type { StreamInput } from "./types";

function sse(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function serializeResponsesStream(input: StreamInput) {
  const created = sse({
    type: "response.created",
    response: {
      id: input.id,
      object: "response",
      created_at: input.created,
      model: input.model,
    },
  });

  if (input.result.mode === "text") {
    return [
      created,
      sse({
        type: "response.output_text.delta",
        delta: input.result.outputText,
      }),
      sse({
        type: "response.completed",
        response: {
          id: input.id,
          object: "response",
        },
      }),
    ];
  }

  return [
    created,
    sse({
      type: "response.function_call_arguments.delta",
      item_id: `${input.id}-tool-1`,
      name: input.result.toolCall.name,
      delta: input.result.toolCall.argumentsJson,
    }),
    sse({
      type: "response.completed",
      response: {
        id: input.id,
        object: "response",
      },
    }),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/openai-adapter/streaming-responses.test.ts`
Expected: PASS with 2 tests passed

- [ ] **Step 5: Commit**

```bash
git add tests/openai-adapter/streaming-responses.test.ts src/openai-adapter/streaming/responses.ts
git commit -m "feat: add responses pseudo stream serializer"
```

## Task 3: Wire Chat Completions route to stream mode

**Files:**
- Modify: `src/openai-adapter/routes/chat-completions.ts`
- Test: `tests/openai-adapter/app.test.ts`

- [ ] **Step 1: Add failing route tests for Chat Completions streaming**

```ts
it("returns SSE for streaming chat completions text responses", async () => {
  const app = buildOpenAiAdapterApp({
    token: "adapter-token",
    helperBaseUrl: "http://127.0.0.1:4318",
    helperToken: "helper-token",
    fetchImpl: vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "text",
        outputText: "hello stream",
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
      model: "qwen-web-chat",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("text/event-stream");
  expect(response.body).toContain("\"chat.completion.chunk\"");
  expect(response.body).toContain("\"content\":\"hello stream\"");
  expect(response.body).toContain("data: [DONE]");
});

it("returns SSE for streaming chat completions tool calls", async () => {
  const app = buildOpenAiAdapterApp({
    token: "adapter-token",
    helperBaseUrl: "http://127.0.0.1:4318",
    helperToken: "helper-token",
    fetchImpl: vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "json_fallback",
        toolCall: {
          name: "ping",
          argumentsJson: "{\"text\":\"hi\"}",
        },
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
      model: "deepseek-web-tools",
      stream: true,
      messages: [{ role: "user", content: "call ping" }],
      tools: [
        {
          type: "function",
          function: {
            name: "ping",
            description: "Echo input",
            parameters: { type: "object", properties: { text: { type: "string" } } },
          },
        },
      ],
    },
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("text/event-stream");
  expect(response.body).toContain("\"tool_calls\"");
  expect(response.body).toContain("\"name\":\"ping\"");
  expect(response.body).toContain("data: [DONE]");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/openai-adapter/app.test.ts`
Expected: FAIL because the route still returns JSON or `400 unsupported_feature`

- [ ] **Step 3: Implement streaming branch in Chat Completions route**

```ts
import { serializeChatCompletionsStream } from "../streaming/chat-completions";

if (body.stream === true) {
  const normalized = normalizeChatCompletionsRequest(body, model);
  const result = await helperClient.run(normalized);
  const chunks = serializeChatCompletionsStream({
    id: `chatcmpl-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: normalized.publicModel,
    result,
  });

  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.hijack();
  for (const chunk of chunks) {
    reply.raw.write(chunk);
  }
  reply.raw.end();
  return reply;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/openai-adapter/app.test.ts`
Expected: PASS with Chat Completions streaming tests green

- [ ] **Step 5: Commit**

```bash
git add tests/openai-adapter/app.test.ts src/openai-adapter/routes/chat-completions.ts
git commit -m "feat: add chat completions pseudo stream route"
```

## Task 4: Wire Responses route to stream mode

**Files:**
- Modify: `src/openai-adapter/routes/responses.ts`
- Test: `tests/openai-adapter/app.test.ts`

- [ ] **Step 1: Add failing route tests for Responses streaming**

```ts
it("returns SSE for streaming responses text output", async () => {
  const app = buildOpenAiAdapterApp({
    token: "adapter-token",
    helperBaseUrl: "http://127.0.0.1:4318",
    helperToken: "helper-token",
    fetchImpl: vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "text",
        outputText: "response stream",
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
      model: "qwen-web-chat",
      stream: true,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    },
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("text/event-stream");
  expect(response.body).toContain("\"type\":\"response.created\"");
  expect(response.body).toContain("\"delta\":\"response stream\"");
  expect(response.body).toContain("\"type\":\"response.completed\"");
});

it("returns SSE for streaming responses tool calls", async () => {
  const app = buildOpenAiAdapterApp({
    token: "adapter-token",
    helperBaseUrl: "http://127.0.0.1:4318",
    helperToken: "helper-token",
    fetchImpl: vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "native_tool_call",
        toolCall: {
          name: "ping",
          argumentsJson: "{\"text\":\"hi\"}",
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
      stream: true,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "call ping" }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "ping",
          description: "Echo input",
          parameters: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    },
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("text/event-stream");
  expect(response.body).toContain("\"type\":\"response.function_call_arguments.delta\"");
  expect(response.body).toContain("\"name\":\"ping\"");
  expect(response.body).toContain("\"type\":\"response.completed\"");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/openai-adapter/app.test.ts`
Expected: FAIL because `/v1/responses` still returns JSON or `400 unsupported_feature`

- [ ] **Step 3: Implement streaming branch in Responses route**

```ts
import { serializeResponsesStream } from "../streaming/responses";

if (body.stream === true) {
  const normalized = normalizeResponsesRequest(body, model);
  const result = await helperClient.run(normalized);
  const chunks = serializeResponsesStream({
    id: `resp-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: normalized.publicModel,
    result,
  });

  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.hijack();
  for (const chunk of chunks) {
    reply.raw.write(chunk);
  }
  reply.raw.end();
  return reply;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/openai-adapter/app.test.ts`
Expected: PASS with Responses streaming tests green

- [ ] **Step 5: Commit**

```bash
git add tests/openai-adapter/app.test.ts src/openai-adapter/routes/responses.ts
git commit -m "feat: add responses pseudo stream route"
```

## Task 5: Verify error handling and non-streaming regressions

**Files:**
- Modify: `tests/openai-adapter/app.test.ts`
- Modify: `src/openai-adapter/errors.ts` only if required

- [ ] **Step 1: Add route-level regression tests for pre-replay helper errors**

```ts
it("keeps helper failures as JSON errors before streaming begins", async () => {
  const app = buildOpenAiAdapterApp({
    token: "adapter-token",
    helperBaseUrl: "http://127.0.0.1:4318",
    helperToken: "helper-token",
    fetchImpl: vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: "MODEL_BUSY",
        message: "Another request is already in progress",
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
      model: "qwen-web-chat",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  expect(response.statusCode).toBe(429);
  expect(response.headers["content-type"]).toContain("application/json");
  expect(response.json()).toEqual({
    error: {
      code: "model_busy",
      message: "Another request is already in progress",
    },
  });
});
```

- [ ] **Step 2: Run test to verify it fails if error handling regressed**

Run: `npm test -- tests/openai-adapter/app.test.ts`
Expected: FAIL only if route starts streaming too early or error translation changed unexpectedly

- [ ] **Step 3: Adjust route logic only if needed**

```ts
// Keep helper execution before any reply.hijack() call.
// Only set SSE headers and write chunks after helperClient.run() resolves successfully.
```

- [ ] **Step 4: Run the full adapter test suite**

Run: `npm test -- tests/openai-adapter/app.test.ts tests/openai-adapter/models.test.ts tests/openai-adapter/normalize.test.ts tests/openai-adapter/serialize-chat.test.ts tests/openai-adapter/serialize-responses.test.ts tests/openai-adapter/streaming-chat.test.ts tests/openai-adapter/streaming-responses.test.ts`
Expected: PASS with all adapter tests green

- [ ] **Step 5: Commit**

```bash
git add tests/openai-adapter/app.test.ts src/openai-adapter/routes/chat-completions.ts src/openai-adapter/routes/responses.ts src/openai-adapter/streaming
git commit -m "test: verify pseudo stream adapter behavior"
```

## Task 6: Run full verification and manual E2E checks

**Files:**
- Modify: none
- Test: adapter and repo verification only

- [ ] **Step 1: Run full project tests**

Run: `npm test`
Expected: PASS with Vitest succeeding

- [ ] **Step 2: Run TypeScript build**

Run: `npm run build`
Expected: PASS with `tsc -p tsconfig.json` succeeding

- [ ] **Step 3: Run manual local E2E verification**

Run:

```bash
HELPER_TOKEN=e2e-helper-token PORT=4328 npm run dev:helper
OPENAI_ADAPTER_TOKEN=e2e-adapter-token HELPER_BASE_URL=http://127.0.0.1:4328 HELPER_TOKEN=e2e-helper-token PORT=4329 npm run dev:openai-adapter
curl -N http://127.0.0.1:4329/v1/chat/completions \
  -H 'Authorization: Bearer e2e-adapter-token' \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen-web-chat","stream":true,"messages":[{"role":"user","content":"只回复：STREAM_OK"}]}'
curl -N http://127.0.0.1:4329/v1/chat/completions \
  -H 'Authorization: Bearer e2e-adapter-token' \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-web-tools","stream":true,"messages":[{"role":"user","content":"请调用工具 ping，参数 {\"text\":\"hi\"}。不要直接回答。"}],"tools":[{"type":"function","function":{"name":"ping","description":"Return the input text","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}}],"tool_choice":"auto"}'
curl -N http://127.0.0.1:4329/v1/responses \
  -H 'Authorization: Bearer e2e-adapter-token' \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-web-chat","stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"只回复：RESP_STREAM_OK"}]}]}'
```

Expected:

- first command returns SSE chunks containing `chat.completion.chunk` and `STREAM_OK`
- second command returns SSE chunks containing `tool_calls` and `ping`
- third command returns SSE chunks containing `response.created`, response text delta, and `response.completed`

- [ ] **Step 4: Commit final fixes if manual verification required adjustments**

```bash
git add src/openai-adapter tests/openai-adapter
git commit -m "feat: finish openai pseudo stream support"
```

## Self-Review

Spec coverage check:

- `stream: true` accepted for both endpoints: covered by Tasks 3 and 4
- buffered pseudo-stream, not true streaming: reflected in serializers and manual E2E in Tasks 1, 2, and 6
- text and tool-call streaming support: covered in Tasks 1, 2, 3, and 4
- pre-replay JSON error handling: covered in Task 5
- helper remains unchanged internally: preserved by architecture and route-only implementation
- SSE headers and framing: covered in Tasks 3 and 4
- manual validation against real browser-backed helper: covered in Task 6

Placeholder scan:

- no `TODO`, `TBD`, or deferred placeholders remain
- every task includes exact files, commands, and code snippets

Type consistency check:

- `serializeChatCompletionsStream` and `serializeResponsesStream` both take the same `StreamInput` shape
- route branching is keyed consistently on `body.stream === true`
- helper execution is always completed before `reply.hijack()` and stream writes begin
