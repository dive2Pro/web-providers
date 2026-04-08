# DeepSeek Tool-Calling Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the DeepSeek Web provider so it can detect native tool-calling payloads, fall back to strict JSON tool-call text when native payloads are absent, and emit real `pi` provider tool-call events instead of text-only responses.

**Architecture:** Extend the page bridge to capture raw `/api/v0/chat/completion` SSE payloads and classify each completed turn as `native_tool_call`, `json_fallback`, or `text`. Propagate that structured turn through the helper contract and route, then update the provider runtime to emit `toolcall_start` / `toolcall_delta` / `toolcall_end` events for tool-call turns and keep the existing text path for plain responses.

**Tech Stack:** TypeScript, Fastify helper routes, bb-browser page automation, `pi` custom provider `streamSimple(...)`, Vitest, DeepSeek Web SSE interception.

---

## File Map

- Modify: `src/helper/browser/deepseek-page-bridge.ts`
  Capture raw SSE records, classify native tool calls, classify JSON fallback, preserve text mode, and return structured bridge results.
- Modify: `src/helper/browser/bb-browser-client.ts`
  Consume structured bridge results and return structured turn data to helper routes.
- Modify: `src/helper/browser/types.ts`
  Add helper-side turn result types for `text`, `native_tool_call`, and `json_fallback`.
- Modify: `src/shared/contracts.ts`
  Replace text-only provider response contract with a discriminated structured response.
- Modify: `src/helper/routes/provider-chat.ts`
  Return structured provider responses and debug metadata instead of only `outputText`.
- Modify: `src/helper/types.ts`
  Extend debug record types so `/v1/debug/provider-last` can show turn mode and normalized tool-call metadata.
- Modify: `src/extension/provider-runtime.ts`
  Add `tools` to the local provider context type, add tool-call event variants, inject fallback instructions, validate structured helper responses, and emit `pi` tool-call stream events.
- Create: `tests/helper/deepseek-page-bridge.test.ts` additions
  Add raw-stream classification coverage for native, JSON fallback, and stale-text rejection.
- Modify: `tests/helper/bb-browser-client.test.ts`
  Cover structured bridge results reaching helper client.
- Modify: `tests/helper/provider-chat.test.ts`
  Cover structured helper route responses and debug output.
- Modify: `tests/extension/index.test.ts`
  Cover provider runtime handling of structured helper responses and tool-call event emission.

## Task 1: Define Shared Turn Types and Contracts

**Files:**
- Modify: `src/helper/browser/types.ts`
- Modify: `src/shared/contracts.ts`
- Test: `tests/helper/provider-chat.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Add assertions to `tests/helper/provider-chat.test.ts` that expect `/v1/provider/chat` to return discriminated structured responses instead of only `outputText`.

```ts
expect(providerResponse.json()).toEqual({
  mode: "json_fallback",
  toolCall: {
    name: "read",
    argumentsJson: "{\"path\":\"src/index.ts\"}",
  },
  finishReason: "stop",
  modelLabel: "DeepSeek Web",
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/helper/provider-chat.test.ts`
Expected: FAIL because `ProviderChatResponse` and route output still use `outputText`-only shape.

- [ ] **Step 3: Add shared helper/browser turn types**

Update `src/helper/browser/types.ts` with a discriminated helper-side result shape:

```ts
export type ProviderToolCallTurn = {
  mode: "native_tool_call" | "json_fallback";
  toolCall: {
    name: string;
    argumentsJson: string;
  };
  outputText?: string;
  modelLabel?: string;
};

export type ProviderTextTurn = {
  mode: "text";
  outputText: string;
  modelLabel?: string;
};

export type ProviderTurnResult = ProviderTextTurn | ProviderToolCallTurn;
```

- [ ] **Step 4: Update the shared HTTP contract**

Replace the text-only response type in `src/shared/contracts.ts` with:

```ts
export type ProviderChatResponse =
  | {
      mode: "text";
      outputText: string;
      finishReason: "stop" | "length" | "error";
      modelLabel?: string;
    }
  | {
      mode: "native_tool_call" | "json_fallback";
      toolCall: {
        name: string;
        argumentsJson: string;
      };
      finishReason: "stop" | "error";
      modelLabel?: string;
      outputText?: string;
    };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/helper/provider-chat.test.ts`
Expected: PASS for contract-shape assertions, or move on if route logic still fails later tasks.

- [ ] **Step 6: Commit**

```bash
git add src/helper/browser/types.ts src/shared/contracts.ts tests/helper/provider-chat.test.ts
git commit -m "feat: add structured provider turn contracts"
```

## Task 2: Capture Raw SSE Records and Classify Turn Mode in the Page Bridge

**Files:**
- Modify: `src/helper/browser/deepseek-page-bridge.ts`
- Test: `tests/helper/deepseek-page-bridge.test.ts`

- [ ] **Step 1: Write the failing bridge tests**

Add tests that exercise three cases:

```ts
it("classifies native tool-call payloads from captured SSE records", async () => {
  expect(result).toEqual({
    ok: true,
    turn: {
      mode: "native_tool_call",
      toolCall: { name: "read", argumentsJson: "{\"path\":\"src/app.ts\"}" },
    },
  });
});

it("classifies strict JSON fallback text when native payloads are absent", async () => {
  expect(result).toEqual({
    ok: true,
    turn: {
      mode: "json_fallback",
      toolCall: { name: "read", argumentsJson: "{\"path\":\"src/app.ts\"}" },
      outputText: "{\"type\":\"tool_call\",\"name\":\"read\",\"arguments\":{\"path\":\"src/app.ts\"}}",
    },
  });
});

it("keeps prose-wrapped JSON as plain text", async () => {
  expect(result).toEqual({
    ok: true,
    turn: {
      mode: "text",
      outputText: "I will call a tool now\\n{\"type\":\"tool_call\"}",
    },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/helper/deepseek-page-bridge.test.ts`
Expected: FAIL because the bridge only returns plain `reply` text today.

- [ ] **Step 3: Add raw stream record retention**

Extend bridge state in `src/helper/browser/deepseek-page-bridge.ts` to retain normalized SSE records:

```ts
function createCompletionState() {
  return {
    observed: false,
    startedAt: 0,
    lastEventAt: 0,
    requestMessageId: null,
    responseMessageId: null,
    modelType: null,
    status: "idle",
    reply: "",
    rawEvents: [],
    closed: false,
  };
}
```

Push records during payload handling:

```ts
completionState.rawEvents.push({
  eventType,
  parsed,
  at: Date.now(),
});
```

- [ ] **Step 4: Add turn classification helpers**

Add pure helpers in the bridge for:

```ts
function detectNativeToolCall(rawEvents) {
  return null as null | { name: string; argumentsJson: string };
}

function detectJsonFallback(text) {
  return null as null | { name: string; argumentsJson: string };
}

function classifyCompletedTurn() {
  const nativeToolCall = detectNativeToolCall(completionState.rawEvents);
  if (nativeToolCall) {
    return { mode: "native_tool_call", toolCall: nativeToolCall, outputText: completionState.reply.trim() || undefined };
  }

  const jsonFallback = detectJsonFallback(completionState.reply.trim());
  if (jsonFallback) {
    return { mode: "json_fallback", toolCall: jsonFallback, outputText: completionState.reply.trim() };
  }

  return { mode: "text", outputText: completionState.reply.trim() };
}
```

- [ ] **Step 5: Return structured bridge result from `waitForReply()`**

Change the bridge return shape from `{ ok: true, reply }` to:

```ts
return {
  ok: true,
  turn: classifyCompletedTurn(),
};
```

Preserve the current error shape for `TIMEOUT` and `PAGE_UNAVAILABLE`.

- [ ] **Step 6: Bump bridge version**

Increment:

```ts
const VERSION = 9;
```

This forces the browser page to load the new classification logic.

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- tests/helper/deepseek-page-bridge.test.ts`
Expected: PASS with native detection, JSON fallback detection, and stale-text rejection covered.

- [ ] **Step 8: Commit**

```bash
git add src/helper/browser/deepseek-page-bridge.ts tests/helper/deepseek-page-bridge.test.ts
git commit -m "feat: classify deepseek turns in page bridge"
```

## Task 3: Propagate Structured Bridge Results Through the Helper Client

**Files:**
- Modify: `src/helper/browser/bb-browser-client.ts`
- Modify: `tests/helper/bb-browser-client.test.ts`

- [ ] **Step 1: Write the failing helper-client tests**

Add tests to `tests/helper/bb-browser-client.test.ts` for structured bridge results:

```ts
await expect(
  client.sendChatPrompt({ tabId: "tab-1", prompt: "hello", timeoutMs: 3000 }),
).resolves.toEqual({
  mode: "native_tool_call",
  toolCall: { name: "read", argumentsJson: "{\"path\":\"src/app.ts\"}" },
  modelLabel: "DeepSeek Web",
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/helper/bb-browser-client.test.ts`
Expected: FAIL because the helper client currently expects `reply: string`.

- [ ] **Step 3: Update bridge result parsing**

In `src/helper/browser/bb-browser-client.ts`, update the typed bridge result handling:

```ts
if (bridgeResult.ok && bridgeResult.turn) {
  return {
    ...bridgeResult.turn,
    modelLabel: "DeepSeek Web",
  };
}
```

Keep `TIMEOUT`, `PAGE_UNAVAILABLE`, and `AUTOMATION_DESYNC` handling unchanged.

- [ ] **Step 4: Restrict the old DOM polling fallback to text-only mode**

If bridge structured result is unavailable and client falls back to polling, continue returning only:

```ts
return {
  mode: "text",
  outputText: latestReply || nextReply,
  modelLabel: "DeepSeek Web",
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/helper/bb-browser-client.test.ts`
Expected: PASS with structured bridge and legacy text fallback both covered.

- [ ] **Step 6: Commit**

```bash
git add src/helper/browser/bb-browser-client.ts tests/helper/bb-browser-client.test.ts
git commit -m "feat: propagate structured bridge turns through helper client"
```

## Task 4: Return Structured Provider Responses and Debug Metadata

**Files:**
- Modify: `src/helper/routes/provider-chat.ts`
- Modify: `src/helper/types.ts`
- Modify: `tests/helper/provider-chat.test.ts`

- [ ] **Step 1: Write the failing route and debug tests**

Add assertions for:

```ts
expect(debugRecord.response).toEqual({
  mode: "native_tool_call",
  toolCall: {
    name: "read",
    argumentsJson: "{\"path\":\"src/app.ts\"}",
  },
  finishReason: "stop",
  modelLabel: "DeepSeek Web",
});
```

and:

```ts
expect(debugRecord.turnMode).toBe("json_fallback");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/helper/provider-chat.test.ts`
Expected: FAIL because helper debug metadata does not yet record turn mode or tool-call info.

- [ ] **Step 3: Extend debug record types**

In `src/helper/types.ts`, add fields:

```ts
turnMode: "text" | "native_tool_call" | "json_fallback" | "error";
toolCall?: {
  name: string;
  argumentsJson: string;
};
nativePayloadSummary?: string | null;
jsonFallbackAttempted?: boolean;
```

- [ ] **Step 4: Return structured route responses**

Update `src/helper/routes/provider-chat.ts` so the successful response is:

```ts
const response: ProviderChatResponse =
  result.mode === "text"
    ? {
        mode: "text",
        outputText: result.outputText,
        finishReason: "stop",
        modelLabel: result.modelLabel,
      }
    : {
        mode: result.mode,
        toolCall: result.toolCall,
        finishReason: "stop",
        modelLabel: result.modelLabel,
        ...(result.outputText ? { outputText: result.outputText } : {}),
      };
```

- [ ] **Step 5: Record structured debug metadata**

Save mode and tool-call info into `ctx.state.setLastProviderRequest(...)`:

```ts
ctx.state.setLastProviderRequest({
  ...baseDebugRecord,
  turnMode: response.mode,
  ...(response.mode !== "text" ? { toolCall: response.toolCall } : {}),
  completedAt: new Date().toISOString(),
  status: "completed",
  response,
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- tests/helper/provider-chat.test.ts`
Expected: PASS with structured route output and debug metadata assertions.

- [ ] **Step 7: Commit**

```bash
git add src/helper/routes/provider-chat.ts src/helper/types.ts tests/helper/provider-chat.test.ts
git commit -m "feat: return structured provider chat responses"
```

## Task 5: Inject JSON Fallback Instruction and Validate Tool Calls in the Provider Runtime

**Files:**
- Modify: `src/extension/provider-runtime.ts`
- Modify: `tests/extension/index.test.ts`

- [ ] **Step 1: Write the failing provider-runtime tests**

Add tests that cover:

```ts
expect(postBody.messages.at(-1)?.content).toContain("output exactly one JSON object");
```

and:

```ts
expect(streamedEvents).toContainEqual({
  type: "toolcall_end",
  contentIndex: 0,
  toolCall: {
    type: "toolCall",
    id: "deepseek-web-0",
    name: "read",
    arguments: { path: "src/app.ts" },
  },
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/extension/index.test.ts`
Expected: FAIL because provider runtime still assumes text-only helper output.

- [ ] **Step 3: Add fallback instruction injection**

In `src/extension/provider-runtime.ts`, first extend the local provider types so the runtime can see tools and emit tool-call events:

```ts
type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

interface ProviderContext {
  systemPrompt?: string;
  messages: Array<UserMessage | AssistantMessage | ToolResultMessage>;
  tools?: ToolDefinition[];
}

type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };
```

Then append a narrow instruction when tools are available:

```ts
const TOOL_FALLBACK_INSTRUCTION = [
  "If you need to call a tool and native tool-calling is unavailable,",
  "output exactly one JSON object with shape:",
  '{"type":"tool_call","name":"tool_name","arguments":{"key":"value"}}',
  "Do not wrap it in markdown or prose.",
].join(" ");
```

Inject it into provider messages:

```ts
if ((context.tools?.length || 0) > 0) {
  pushProviderMessage(messages, "system", TOOL_FALLBACK_INSTRUCTION);
}
```

- [ ] **Step 4: Add tool-call validation helper**

Add a validator:

```ts
function parseValidatedToolCall(input: { name: string; argumentsJson: string }) {
  const parsed = JSON.parse(input.argumentsJson);
  if (!input.name.trim() || !parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Invalid DeepSeek tool call payload");
  }
  return { name: input.name, arguments: parsed as Record<string, unknown> };
}
```

- [ ] **Step 5: Emit provider tool-call events**

When helper response mode is `native_tool_call` or `json_fallback`, emit:

```ts
output.content.push({
  type: "toolCall",
  id: "deepseek-web-0",
  name: validated.name,
  arguments: {},
});
const contentIndex = output.content.length - 1;
stream.push({ type: "toolcall_start", contentIndex, partial: output });

const block = output.content[contentIndex];
if (block?.type === "toolCall") {
  block.arguments = validated.arguments;
}

stream.push({
  type: "toolcall_delta",
  contentIndex,
  delta: response.toolCall.argumentsJson,
  partial: output,
});
stream.push({
  type: "toolcall_end",
  contentIndex,
  toolCall: {
    type: "toolCall",
    id: "deepseek-web-0",
    name: validated.name,
    arguments: validated.arguments,
  },
  partial: output,
});
```

Then finish with:

```ts
output.stopReason = "toolUse";
stream.push({ type: "done", reason: "toolUse", message: output });
```

- [ ] **Step 6: Preserve text mode behavior**

Keep the current text path unchanged for:

```ts
if (response.mode === "text") {
  // existing text_start/text_delta/text_end logic
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- tests/extension/index.test.ts`
Expected: PASS with fallback prompt injection and structured tool-call event assertions.

- [ ] **Step 8: Commit**

```bash
git add src/extension/provider-runtime.ts tests/extension/index.test.ts
git commit -m "feat: emit pi tool-call events for deepseek provider"
```

## Task 6: Add Native Detection and JSON Fallback Integration Coverage End-to-End

**Files:**
- Modify: `tests/helper/deepseek-page-bridge.test.ts`
- Modify: `tests/helper/bb-browser-client.test.ts`
- Modify: `tests/helper/provider-chat.test.ts`
- Modify: `tests/extension/index.test.ts`

- [ ] **Step 1: Add end-to-end failing tests for both modes**

Add explicit test names:

```ts
it("prefers native tool calls over JSON fallback when both are present", async () => {})
it("degrades invalid fallback JSON to plain text", async () => {})
it("surfaces helper validation errors for malformed native tool payloads", async () => {})
```

- [ ] **Step 2: Run the focused suite to verify failures**

Run:

```bash
npm test -- \
  tests/helper/deepseek-page-bridge.test.ts \
  tests/helper/bb-browser-client.test.ts \
  tests/helper/provider-chat.test.ts \
  tests/extension/index.test.ts
```

Expected: FAIL until all preference and validation paths are wired together.

- [ ] **Step 3: Implement the minimal missing glue**

Adjust only the logic still missing after earlier tasks, keeping the preference order:

```ts
// preference order
native_tool_call > json_fallback > text
```

and the invalid-data behavior:

```ts
// invalid native payload => error
// invalid fallback JSON => text
```

- [ ] **Step 4: Run the focused suite to verify it passes**

Run:

```bash
npm test -- \
  tests/helper/deepseek-page-bridge.test.ts \
  tests/helper/bb-browser-client.test.ts \
  tests/helper/provider-chat.test.ts \
  tests/extension/index.test.ts
```

Expected: PASS with all mode-preference and degradation rules covered.

- [ ] **Step 5: Commit**

```bash
git add \
  tests/helper/deepseek-page-bridge.test.ts \
  tests/helper/bb-browser-client.test.ts \
  tests/helper/provider-chat.test.ts \
  tests/extension/index.test.ts
git commit -m "test: cover native and fallback tool-calling flows"
```

## Task 7: Full Verification and Manual Native-Payload Probe

**Files:**
- Modify: `src/helper/browser/deepseek-page-bridge.ts` if manual findings require narrow schema updates
- Modify: `src/helper/types.ts` if debug summaries need refinement

- [ ] **Step 1: Run the full automated suite**

Run:

```bash
npm test -- \
  tests/helper/deepseek-page-bridge.test.ts \
  tests/helper/bb-browser-client.test.ts \
  tests/helper/provider-chat.test.ts \
  tests/helper/chat.test.ts \
  tests/helper/bind-reset.test.ts \
  tests/extension/index.test.ts
```

Expected: PASS, 0 failures.

- [ ] **Step 2: Start a manual helper**

Run:

```bash
PORT=53660 HELPER_TOKEN=manual-tool-provider npm run dev:helper
```

Expected: helper stays running and serves requests on `http://127.0.0.1:53660`.

- [ ] **Step 3: Bind the DeepSeek tab**

Run:

```bash
curl -sS -X POST \
  -H 'Authorization: Bearer manual-tool-provider' \
  http://127.0.0.1:53660/v1/bind
```

Expected: JSON with `tabId`, `url`, and `bridgeInjected: true`.

- [ ] **Step 4: Trigger a tool-eligible turn**

Run:

```bash
curl -sS -X POST \
  -H 'Authorization: Bearer manual-tool-provider' \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:53660/v1/provider/chat \
  -d '{"model":"deepseek-web-chat","messages":[{"role":"user","content":"If you need a tool, call read on src/helper/browser/deepseek-page-bridge.ts."}]}'
```

Expected: one of:

- `mode: "native_tool_call"`
- `mode: "json_fallback"`
- `mode: "text"`

but never stale previous-turn text.

- [ ] **Step 5: Inspect debug record**

Run:

```bash
curl -sS \
  -H 'Authorization: Bearer manual-tool-provider' \
  http://127.0.0.1:53660/v1/debug/provider-last
```

Expected:

- `turnMode` present
- `toolCall` present for native/fallback turns
- raw native payload summary present when native detection succeeds

- [ ] **Step 6: Apply only narrow schema refinements if manual native payload differs**

If native payload fields differ from the implementation assumption, update only detection/normalization helpers and re-run the focused tests plus this manual check.

```ts
// keep changes isolated to native detection helpers
```

- [ ] **Step 7: Final commit**

```bash
git add src/helper/browser/deepseek-page-bridge.ts src/helper/types.ts
git commit -m "chore: finalize deepseek tool-calling provider verification"
```

## Spec Coverage Check

- Native payload evidence capture: Task 2
- JSON fallback detection and strict schema: Tasks 2 and 5
- Structured helper contract: Tasks 1 and 4
- Provider runtime event mapping: Task 5
- Debugging and observability: Task 4
- Manual native probe and fallback verification: Task 7

No spec gaps remain.
