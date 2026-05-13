# OpenAI-Compatible Adapter Design

## Summary

Build a separate `openai-adapter` service in front of the existing helper service so external clients can call this project using OpenAI-style HTTP APIs instead of the current helper-specific protocol. The adapter should support both `/v1/chat/completions` and `/v1/responses`, while keeping the existing helper service focused on browser automation and provider execution.

The first version should support:

- non-streaming requests only
- text chat
- tool calling
- stable virtual model names that hide the underlying web provider

The first version should explicitly exclude:

- streaming responses
- multimodal inputs
- audio
- precise token accounting
- advanced routing such as fallback, retries across providers, or load balancing

## Goals

- Let common OpenAI-compatible SDKs and agent frameworks talk to this project without knowing about Pi Code Agent or the helper-specific API.
- Keep protocol compatibility concerns out of the helper service.
- Preserve the current provider abstraction where the helper executes against browser-bound web sessions.
- Hide implementation-specific provider names behind stable public model IDs.

## Non-Goals

- Full wire-level parity with OpenAI behavior in every edge case
- Streaming in the first version
- Exact usage or token accounting
- Full Responses API surface beyond what is needed for text and tool calling
- Solving current helper limitations around concurrency, history reconstruction, or multimodal input

## Current Context

The current helper already exposes a provider-oriented route through [`src/helper/routes/provider-chat.ts`](/Users/yc/ai/web-providers/src/helper/routes/provider-chat.ts), and the shared request and response types already model provider-neutral concepts such as:

- `messages`
- `model`
- `temperature`
- `maxOutputTokens`
- tool-call-like structured outputs

This means the missing piece is not a new execution engine. The missing piece is a compatibility layer that converts OpenAI-style HTTP requests into the helper's existing provider execution contract and converts the helper response back into OpenAI-style payloads.

## Proposed Architecture

Introduce a new standalone service named `openai-adapter`.

### Responsibilities of `openai-adapter`

- expose OpenAI-compatible endpoints
- authenticate external clients
- map public virtual model names to internal provider configuration
- normalize incoming Chat Completions and Responses requests into one internal execution shape
- translate helper responses into OpenAI-compatible response bodies
- translate helper errors into a stable OpenAI-style error format

### Responsibilities of the existing helper

- hold browser-bound session state
- bind tabs to providers
- execute prompts against browser automation
- produce normalized execution results for text or tool calls
- expose internal helper routes for the adapter to consume

### Data Flow

1. A client sends an OpenAI-compatible request to `openai-adapter`.
2. The adapter authenticates the request and resolves the requested public model.
3. The adapter converts the external request into a normalized internal request.
4. The adapter maps that normalized request into the helper's `/v1/provider/chat` contract.
5. The helper executes the request against the bound web provider session.
6. The adapter serializes the helper result into the requested OpenAI-compatible response format.

This separation keeps protocol compatibility outside the helper and lets the helper remain focused on browser automation.

## Public API Surface

The first version should expose:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

### `GET /v1/models`

Returns the public model catalog. The catalog is composed of stable virtual model names, not raw helper provider IDs.

Initial examples:

- `deepseek-web-chat`
- `deepseek-web-tools`
- `qwen-web-chat`
- `qwen-web-tools`

The model list should be driven by adapter configuration rather than hardcoded directly in route handlers.

### `POST /v1/chat/completions`

Supported in V1:

- `model`
- `messages`
- `tools`
- `tool_choice`
- `temperature`
- `max_tokens` or equivalent adapter-mapped output limit field
- `stream: false`

Explicit V1 behavior:

- `stream: true` is rejected as unsupported
- text outputs are returned in standard chat completion message form
- tool-call outputs are returned using `message.tool_calls`

### `POST /v1/responses`

Supported in V1:

- model selection
- text input messages
- tool definitions
- tool invocation results from the model
- non-streaming only

The Responses route should reuse the same internal normalized execution pipeline as Chat Completions. The two routes should differ primarily in request parsing and response serialization, not in execution behavior.

## Public Model Strategy

The adapter should expose only stable virtual model IDs. Clients should not send raw helper provider IDs such as `deepseek-web` or `qwen-web`.

Each public model should resolve to configuration with at least:

- `provider`
- `supportsTools`
- `defaultTimeoutMs`
- `allowThinkingText`
- `sessionMode` or equivalent session initialization policy

Example conceptual mapping:

- `deepseek-web-chat` -> `provider: deepseek-web`, `supportsTools: false`
- `deepseek-web-tools` -> `provider: deepseek-web`, `supportsTools: true`
- `qwen-web-chat` -> `provider: qwen-web`, `supportsTools: false`
- `qwen-web-tools` -> `provider: qwen-web`, `supportsTools: true`

This lets the project change internal provider details later without breaking external client configuration.

## Request Normalization

Both public request formats should be translated into one adapter-internal normalized request shape before calling the helper.

Suggested normalized fields:

- `publicModel`
- `provider`
- `messages`
- `tools`
- `toolChoice`
- `temperature`
- `maxOutputTokens`
- `responseFormat`

Where:

- `publicModel` is the stable external model name
- `provider` is the resolved helper provider ID
- `messages` is the ordered conversation content
- `tools` is the normalized tool schema list
- `toolChoice` is the normalized tool selection mode
- `responseFormat` indicates whether the caller expects Chat Completions or Responses serialization

This keeps business logic shared between both routes and avoids maintaining two nearly duplicated execution paths.

## Mapping to Helper Contract

The adapter should map the normalized request into the helper's existing provider request contract defined in [`src/shared/contracts.ts`](/Users/yc/ai/web-providers/src/shared/contracts.ts).

Important mapping rules:

- The public model name resolves to helper `provider`.
- Ordered input messages are preserved, but the adapter may need a documented message compaction strategy to fit the helper's current prompt-oriented execution model.
- Tool definitions are converted into the helper-compatible representation and, if needed, accompanied by prompt instructions that force the browser model to return a structured tool call.
- `tool_choice` should support at least:
  - `auto`
  - `none`
  - named-function selection
- Chat Completions and Responses should both land on the same helper call path.

## Message Semantics

The helper route currently behaves more like a prompt execution layer than a full conversation protocol engine. Because of that, the adapter must define a deterministic way to translate multi-message OpenAI-style input into the helper input format.

V1 rule:

- preserve the original ordered message list
- generate one normalized internal message sequence
- convert that sequence into the helper request in a deterministic, documented manner

The adapter should document that compatibility is semantic, not perfect protocol parity. The goal is that common SDKs and agent frameworks work, not that every OpenAI edge case behaves identically.

## Tool Calling Semantics

Tool calling is required in V1.

The adapter should support:

- receiving OpenAI-style `tools`
- receiving `tool_choice`
- turning helper tool-call results into OpenAI-compatible tool-call payloads

Expected execution behavior:

- if the helper returns plain text, serialize a text result
- if the helper returns a structured tool call, serialize it as:
  - `choices[0].message.tool_calls` for Chat Completions
  - output items representing tool call intent for Responses

`finish_reason` should support at least:

- `stop`
- `length`
- `tool_calls`

The adapter should not claim support for richer tool semantics than the helper can actually preserve.

## Response Serialization

### Chat Completions

For text output:

- return a standard completion object with:
  - `id`
  - `object`
  - `created`
  - `model`
  - `choices`

For tool-call output:

- return `choices[0].message.tool_calls`
- set `finish_reason` to `tool_calls`

### Responses

For text output:

- return a response object whose output can be reconstructed by OpenAI-style Responses clients

For tool-call output:

- return output items representing the requested tool call

The adapter should implement two serializers over one common execution result object rather than two separate response-building code paths.

## Usage Accounting

The first version should not fake precise token accounting.

Acceptable V1 options:

- omit detailed usage where allowed
- return clearly approximate or zeroed usage fields

Whatever choice is taken, it must be consistent and documented. The adapter should not imply precision it does not have.

## Error Handling

The adapter should expose one consistent error envelope for all public endpoints.

Helper errors should be mapped approximately as follows:

- `NOT_BOUND` -> `409` or `400`
- `MODEL_BUSY` -> `429` or `409`
- `TIMEOUT` -> `504` or `408`
- `AUTOMATION_DESYNC` -> `502` or `503`
- `PAGE_UNAVAILABLE` -> `502` or `503`

The response body should preserve the meaningful internal failure message so debugging stays practical.

V1 requirement:

- every adapter-generated error must use the same shape
- route handlers must not leak raw helper error payloads inconsistently

## Authentication

The adapter should authenticate external requests separately from the helper's internal token scheme.

Recommended V1 approach:

- the adapter accepts a bearer token from external clients
- the adapter uses its own configured helper token when calling the helper service

This keeps the helper private and lets the adapter become the single public entry point.

## Testing Strategy

The design should include tests for:

- public model resolution
- request normalization from both endpoint formats
- helper request mapping
- text response serialization
- tool-call response serialization
- unsupported streaming behavior
- error translation
- unauthenticated requests

Tests should focus on adapter behavior and stub helper responses rather than relying on live browser automation.

## Risks

- OpenAI-compatible clients vary in how strictly they validate response fields.
- The helper's current prompt-centric behavior may not preserve all multi-message semantics exactly.
- Tool calling depends on stable structured output from web providers, which may be more fragile than native API tool calling.
- Lack of streaming means some clients will not work until they are configured for non-streaming mode.

## Implementation Direction

The implementation should favor a small adapter with these internal modules:

- model registry
- request normalizer
- helper client
- chat completions serializer
- responses serializer
- error translator

That keeps protocol concerns isolated and makes later additions such as streaming, usage estimation, or routing policy incremental rather than entangled with browser automation code.

## Acceptance Criteria

The design is successful when:

- a client can call the adapter using `/v1/chat/completions` with a virtual model name and receive a valid non-streaming text response
- a client can call the adapter using `/v1/chat/completions` with tools and receive a valid tool-call response
- a client can call the adapter using `/v1/responses` and receive equivalent behavior through the same internal execution path
- the adapter never exposes raw helper provider IDs as public model names
- helper protocol details remain internal to the adapter-helper boundary
