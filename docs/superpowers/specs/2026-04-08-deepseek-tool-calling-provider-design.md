# DeepSeek Web Tool-Calling Provider Design

Date: 2026-04-08

## Summary

Extend the existing DeepSeek Web `pi` provider so it can return structured tool-calling output instead of only plain assistant text.

The provider should prefer native tool-calling data when the DeepSeek web chat stream exposes it. If the webpage does not expose native structured tool calls for a turn, the provider should automatically fall back to a strict JSON protocol embedded in assistant text and translate that into `pi` tool-calling events.

This design is additive to the existing provider work. It does not replace the helper or browser architecture. It upgrades the helper-provider contract and the provider runtime so `pi-code-agent` can treat DeepSeek Web as a practical tool-using backend.

## Relationship to Existing Design

This spec extends [2026-04-08-pi-provider-design.md](./2026-04-08-pi-provider-design.md).

That earlier design intentionally scoped out tool-calling passthrough. This document narrows in on the next step:

- preserve the current helper and provider boundaries
- add structured turn classification
- support native tool-calling first
- support JSON fallback second

If the two specs disagree on tool-calling behavior, this spec wins.

## Goals

- Let `deepseek-web-chat` emit structured tool-calling data that `pi` can execute.
- Prefer native DeepSeek Web tool-call payloads when the chat stream exposes them.
- Fall back automatically to a strict JSON tool-call protocol when native payloads are absent.
- Preserve plain text behavior for normal assistant replies.
- Keep browser automation and helper ownership unchanged.
- Make each provider turn auditable as `native`, `json_fallback`, or `text`.

## Non-Goals

- Inventing a custom planning agent separate from the provider
- Supporting partial or fuzzy JSON parsing
- Executing arbitrary text that merely resembles tool-calling syntax
- Multimodal tool calls in the first version
- Parallel multi-call orchestration beyond what `pi` already supports
- Guaranteeing that DeepSeek Web itself truly supports native tools in all conversations

## Constraints

- The DeepSeek Web backend is only observable through webpage automation and captured network traffic.
- We do not control the server-side schema for `https://chat.deepseek.com/api/v0/chat/completion`.
- The current helper response format only returns `outputText`, so structured responses need a contract upgrade.
- The provider runtime currently only emits text events, so tool-call event mapping needs to be added there.

## Recommended Approach

Recommended approach: classify each assistant turn in the helper, then map the classification into `pi` provider events.

### Turn Modes

Each completed DeepSeek turn must end in exactly one mode:

- `native_tool_call`
- `json_fallback`
- `text`
- `error`

This classification happens in the helper after the full browser-observed turn is available.

## Architecture

### 1. Page Bridge

File:

- `src/helper/browser/deepseek-page-bridge.ts`

Responsibilities:

- keep capturing the `/api/v0/chat/completion` stream
- retain the raw SSE blocks for the current turn, not just the assembled text
- expose enough structured state for the helper to distinguish:
  - native structured tool-call payloads
  - plain text assistant output
  - timeout or page errors

The bridge should not understand `pi` semantics. Its job is evidence capture and turn reconstruction.

### 2. Helper Browser Client

File:

- `src/helper/browser/bb-browser-client.ts`

Responsibilities:

- request a prompt from the page bridge
- receive a structured turn result rather than just a reply string
- preserve compatibility with page-state fallback behavior
- translate browser-side failures into existing helper errors

### 3. Helper Route Contract

Files:

- `src/shared/contracts.ts`
- `src/helper/routes/provider-chat.ts`

Responsibilities:

- upgrade `/v1/provider/chat` so the response can carry structured assistant output
- keep request shape compatible with the current provider runtime
- return explicit turn mode metadata

### 4. Provider Runtime

File:

- `src/extension/provider-runtime.ts`

Responsibilities:

- map helper response modes into `pi` stream events
- emit native tool-call events when helper returns native calls
- emit the same tool-call events when helper returns validated JSON fallback calls
- continue emitting text events for ordinary assistant text

## Native Tool-Call Detection

### Evidence Collection

The page bridge must preserve the raw decoded SSE records for each `/api/v0/chat/completion` request.

For each record, retain enough data to inspect:

- event type
- parsed JSON payload
- order of arrival

This is necessary because the current bridge collapses the stream into text too early, which would discard any structured call metadata if it exists.

### Detection Rule

Classify a turn as `native_tool_call` only if a captured payload contains explicit structured call data that is separate from assistant prose.

Examples of acceptable evidence:

- a dedicated tool-call object or array
- a fragment type that clearly denotes tool invocation
- a response patch with explicit function/tool name and arguments fields

Non-evidence:

- text that merely looks like JSON
- markdown code fences
- natural language such as "I will call read_file now"

### Unknown Native Schema

The first implementation must be schema-tolerant but evidence-driven:

- inspect for likely structured fields
- preserve raw payloads in debug logs
- only promote to `native_tool_call` when the shape is unambiguous

If the shape is ambiguous, fall through to JSON fallback detection.

## JSON Fallback Protocol

Fallback only runs when native tool-calling evidence is absent.

### Required Output Shape

The assistant text must be exactly one JSON object with this shape:

```json
{
  "type": "tool_call",
  "name": "tool_name",
  "arguments": {
    "key": "value"
  }
}
```

First version scope:

- exactly one tool call per assistant turn
- no prose before or after the JSON object
- `arguments` must be a JSON object

If the assistant text is not valid against this contract, the turn is `text`, not `json_fallback`.

### Why Strict

Loose parsing would create false tool executions and make the provider unsafe. The fallback must be narrow enough that failure degrades to text rather than accidental tool invocation.

## Helper Contract Changes

### Request

The existing request shape can stay:

- `model`
- `messages`
- `temperature?`
- `maxOutputTokens?`
- `abortKey?`

### Response

Replace the text-only `ProviderChatResponse` with a structured response that can represent text or tool-calling.

Recommended shape:

```ts
type ProviderChatResponse =
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

Notes:

- `argumentsJson` should remain a string at the contract boundary so parsing and validation can happen in one place in the provider runtime.
- `outputText` remains optional for tool-call modes because some native payloads may also include assistant text, but first version should ignore mixed-mode turns unless the schema is unambiguous.

## Provider Runtime Mapping

### Text Mode

Current behavior remains:

- emit `text_start`
- emit `text_delta`
- emit `text_end`
- emit `done`

### Tool-Call Modes

When helper returns `native_tool_call` or `json_fallback`:

- create an assistant output turn that contains a tool-use content part
- emit the corresponding provider stream events for tool start / tool payload / completion
- let `pi` execute the tool and feed the tool result back into the next turn as it already does

The provider runtime should not care whether the helper classified the turn as native or fallback after validation succeeds. The emitted `pi` tool event shape should be identical.

## Validation Rules

Validation must happen before the provider runtime emits any tool-call event.

Rules:

- tool name must be a non-empty string
- arguments JSON must parse successfully
- parsed arguments must be an object
- mixed invalid payloads degrade to plain text or error, not tool execution

If native structured payload is detected but cannot be normalized safely, return `error` rather than silently guessing.

## Prompting for JSON Fallback

The JSON fallback path requires targeted provider-side prompting.

In the first version, the provider runtime should always append a narrow fallback instruction to the request context for turns where tool use is allowed, because the system cannot know in advance whether the webpage will expose native tool-call payloads for that specific turn.

The instruction should say, in effect:

- if you need to call a tool and native tool calling is unavailable, output exactly one JSON object matching the required schema
- otherwise respond normally in plain text

Response handling still prefers native payload detection over JSON parsing. The prompt addition only creates a usable backup path when native payloads are absent.

This prompt addition must be scoped so it does not interfere with normal plain-text turns.

## Debugging and Observability

Extend `/v1/debug/provider-last` to include:

- selected turn mode
- normalized tool-call metadata when present
- raw native payload excerpt or summary when native detection succeeded
- whether JSON fallback parsing was attempted

This is necessary because tool-calling bugs will otherwise be impossible to diagnose from plain text logs.

## Testing Strategy

### Unit Tests

Add tests for:

- native payload detection from captured stream records
- JSON fallback detection for exact valid JSON object
- rejection of prose-wrapped JSON
- rejection of malformed JSON
- rejection of array or scalar `arguments`
- provider runtime mapping of structured helper responses into tool-call events
- fallback to plain text when neither native nor JSON tool-calling applies

### Integration Tests

Add tests for:

- `/v1/provider/chat` returning `mode: "text"`
- `/v1/provider/chat` returning `mode: "json_fallback"`
- provider runtime consuming structured response and producing tool-use events

### Manual Verification

Manual verification sequence:

1. bind a logged-in DeepSeek tab
2. trigger a request that should produce a tool call
3. inspect `/v1/debug/provider-last`
4. confirm whether native payloads were observed
5. if not, confirm JSON fallback emitted valid structured tool-call output
6. confirm `pi` executes the tool and the next turn includes the tool result

## Risks

- DeepSeek Web may never expose native tool-calling payloads in the webpage stream
- native payload shape may exist but vary by model, mode, or account feature
- JSON fallback may compete with natural-language answers if prompting is too weak
- provider runtime event mapping may need adjustment once the exact `pi` tool event contract is exercised

## Rollout Plan

### Phase 1

- capture and classify raw DeepSeek stream payloads
- add structured helper response contract
- keep runtime text-only until classification is verified

### Phase 2

- enable JSON fallback parsing
- emit tool-call events from provider runtime

### Phase 3

- enable native tool-call passthrough once real native payload evidence is confirmed
- keep fallback as automatic backup

## Recommendation

Implement the helper contract and JSON fallback path first, but do not skip native evidence capture.

This balances practicality with correctness:

- the system becomes useful even if DeepSeek Web does not expose native calls
- native passthrough can be enabled immediately when evidence appears
- the provider runtime stays stable because both paths normalize into one structured tool-call representation
