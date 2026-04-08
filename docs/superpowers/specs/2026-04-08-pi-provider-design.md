# DeepSeek Web as a `pi` Provider

Date: 2026-04-08

## Summary

Convert the current tool-style `pi` extension into a true `pi-mono` provider extension so `pi-code-agent` can use a logged-in DeepSeek webpage session as its main model backend.

The provider extension registers a provider named `deepseek-web` and exposes a model named `deepseek-web-chat`. Internally, it continues to rely on the local helper and `bb-browser` automation, but the `pi` runtime sees a normal provider rather than a callable tool.

This design intentionally keeps the first version narrow:

- Text-only conversations
- Single active request
- Single bound DeepSeek tab
- Same machine only
- Logged-in browser session required
- Non-streaming or pseudo-streaming first version

## Goals

- Make DeepSeek web available as a real `pi` provider, selectable as the main model backend.
- Allow `pi-code-agent` to route its normal conversation flow through DeepSeek web.
- Reuse the existing helper and browser bridge architecture rather than duplicating automation logic in the extension.
- Return stable provider errors when DeepSeek is unavailable or unbound.
- Keep the provider lifecycle compatible with `pi` extension discovery and reload behavior.

## Non-Goals

- Replacing DeepSeek web with an official API
- Browser login automation
- Multimodal or attachment support
- Token-accurate usage reporting
- Full tool-calling parity with native provider backends
- Multi-session or multi-tab concurrency
- Remote or multi-user access

## Recommended Approach

Recommended approach: a true `pi` provider extension backed by the existing helper.

### Components

1. `pi provider extension`
   - Registers `deepseek-web` via `pi.registerProvider(...)`
   - Exposes the model `deepseek-web-chat`
   - Owns helper startup, bind bootstrap, shutdown, and provider-to-helper translation

2. `provider runtime`
   - Internal extension code that maps `pi` provider callbacks to helper requests
   - Normalizes messages, errors, model metadata, and request cancellation behavior

3. `local helper`
   - Retains browser automation, DeepSeek tab binding, message submission, and reply extraction

4. `page bridge`
   - Retains DOM-level interaction with the DeepSeek webpage

## Why Provider Instead of Tool

The tool-based version is not sufficient for the target outcome:

- `pi-code-agent` cannot treat a tool as its main model backend
- the user wants DeepSeek web to act as the primary conversation provider
- `/model` or equivalent provider selection points at `deepseek-web-chat`
- the provider boundary is the correct place to convert `pi` conversation context into a DeepSeek web request

## Provider Registration

The extension registers:

- provider id: `deepseek-web`
- model id: `deepseek-web-chat`
- display name: `DeepSeek Web Chat`

The provider is local-only and does not require a remote API key. Browser login state remains the authority.

### Extension Entry

The only `pi`-visible entry point lives under:

- `.pi/extensions/deepseek-web/index.ts`

All implementation details live in non-discoverable source files to avoid duplicate provider or tool registration.

## Provider Runtime Responsibilities

The provider runtime owns:

- helper process startup on first use
- helper shutdown on `session_shutdown`
- mapping `pi` conversation context to helper request payloads
- converting helper replies into `pi` provider responses
- surfacing stable failures when DeepSeek is not available

The provider runtime does not:

- automate the browser directly
- parse the webpage DOM
- store browser login credentials

## Model Surface

First version model metadata is intentionally conservative:

- `id`: `deepseek-web-chat`
- `name`: `DeepSeek Web Chat`
- `contextWindow`: conservative placeholder such as `64000`
- `maxOutputTokens`: conservative placeholder such as `8000`

These are operational approximations for provider compatibility, not claims about exact DeepSeek web limits.

## Provider-to-Helper Protocol

The tool-style `POST /v1/chat` endpoint is not sufficient for provider mode because provider mode receives full conversation context rather than a single bare prompt.

Add a provider-oriented helper endpoint:

- `POST /v1/provider/chat`

### Request

- `model: "deepseek-web-chat"`
- `messages: Array<{ role: "system" | "user" | "assistant", content: string }>`
- `temperature?: number`
- `maxOutputTokens?: number`
- `abortKey?: string`

### Response

- `outputText: string`
- `finishReason: "stop" | "length" | "error"`
- `modelLabel?: string`

First version may omit precise token usage.

## Message Mapping

DeepSeek web does not expose a stable provider-native message API, so the provider runtime must convert structured conversation context into a single normalized prompt payload for the helper.

### First-Version Mapping Strategy

Combine the provider messages into one prompt with fixed sections:

```text
[System Instructions]
...

[Conversation History]
User: ...
Assistant: ...
User: ...

[Current User Request]
...
```

Rules:

- merge all `system` messages into the `System Instructions` block
- include all prior `user` and `assistant` messages in the `Conversation History` block
- place the most recent `user` message in `Current User Request`
- ignore non-text parts in the first version

This is a compatibility strategy, not an ideal semantic mapping. It exists to make provider mode operational with the DeepSeek webpage.

## Streaming Strategy

Recommended first version: pseudo-streaming provider.

### First Version

- provider callback waits for helper completion
- once helper returns the full text, provider emits it as a single completion
- no incremental browser deltas are required

### Future Upgrade

- page bridge emits deltas
- helper exposes a streaming protocol
- provider maps those deltas to `pi` streaming events

## Error Model

The provider translates helper failures into stable provider-level failures.

### Relevant Errors

- `NOT_BOUND`
  - no usable DeepSeek tab is currently available

- `PAGE_UNAVAILABLE`
  - the tab is gone, not logged in, or no longer matches the supported page

- `MODEL_BUSY`
  - the helper or webpage is already serving another request

- `TIMEOUT`
  - DeepSeek web did not finish in time

- `AUTOMATION_DESYNC`
  - browser automation lost sync with the page and cannot safely continue

### Provider Behavior

- surface concise user-facing error messages
- preserve technical detail in internal logs only
- do not expose DOM-level error specifics to the provider boundary

## Lifecycle

The provider runtime follows `pi` session lifecycle:

- on first provider call, lazily start helper
- before a request, ensure helper is healthy and DeepSeek tab can be bound
- on `session_shutdown`, stop helper and clear in-memory provider state

Reload behavior must not register duplicate providers. Only the `.pi/extensions/...` entry is discoverable.

## First-Version Scope

### Included

- one provider: `deepseek-web`
- one model: `deepseek-web-chat`
- helper startup from the provider extension
- helper bind before request execution
- text-only context mapping
- single active request
- full-response completion path

### Excluded

- real incremental streaming
- tool-calling passthrough
- image or file inputs
- exact token accounting
- multiple concurrent chats
- login flows
- remote helper hosting

## Testing Strategy

### Unit Tests

Cover:

- provider registration
- helper lazy startup
- single provider call flow
- provider shutdown cleanup
- helper error translation

### Integration Tests

Cover:

- provider runtime calling `POST /v1/provider/chat`
- provider runtime binding helper before chat
- provider runtime returning model output as provider content

### Manual End-to-End

Required scenarios:

- start `pi` in the project root
- reload extensions
- select `deepseek-web-chat`
- verify the provider answers through DeepSeek web
- verify missing DeepSeek tab returns a stable failure

## Success Criteria

- `pi` discovers the extension from `.pi/extensions/deepseek-web/index.ts`
- `pi` exposes provider `deepseek-web` with model `deepseek-web-chat`
- `pi-code-agent` can use DeepSeek web as the main conversation backend
- provider errors are stable when DeepSeek web is unavailable

## Open Implementation Decisions

These do not block the architecture:

- exact `pi.registerProvider(...)` callback signature details
- exact `pi-ai` response shape required by provider handlers
- exact model metadata values for context window and output tokens
- whether the first version emits a single completion event or a minimal one-chunk pseudo-stream

None of these change the core boundary: this feature is a provider extension backed by the existing helper.
