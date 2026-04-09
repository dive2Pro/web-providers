# Qwen Multi-Provider Web Bridge Design

## Goal

Extend the current DeepSeek-only web bridge into a multi-provider architecture that can expose both `deepseek-web` and `qwen-web` as selectable extension providers while keeping a single local helper process.

## Scope

This design covers:

- exposing `deepseek-web` and `qwen-web` as separate providers in the extension
- keeping one helper process and one local port
- making helper routes and state provider-aware
- extracting provider-specific browser automation into adapters
- adding a first Qwen adapter for `https://chat.qwen.ai/`

This design does not cover:

- concurrent multi-request execution inside the helper
- multiple helper processes, one per provider
- a forced unified model abstraction beyond what provider registration already needs
- full native tool-calling parity for Qwen in the first implementation

## Why This Change

The current codebase is structurally DeepSeek-specific:

- provider registration is hard-coded to `deepseek-web`
- helper contracts assume a single provider/model identity
- helper binding state assumes one global bound session
- the browser bridge lives in DeepSeek-specific code paths

That structure worked for the first provider, but it becomes the wrong boundary once provider switching is a product requirement. Adding Qwen by copying DeepSeek would produce short-term speed at the cost of long-term maintenance duplication. A provider-adapter architecture keeps the helper shared while isolating site-specific automation and parsing.

## Recommended Approach

Use one helper process with explicit provider-aware contracts and state, and register one extension provider per website.

The resulting system will have these properties:

- the extension exposes `deepseek-web` and `qwen-web` separately
- each provider has its own model ids and metadata
- helper requests explicitly identify the provider they target
- helper state stores bindings per provider instead of globally
- provider-specific browser logic is implemented behind a common adapter interface
- the existing DeepSeek flow remains intact but moves behind the adapter abstraction

This gives clear operational boundaries without introducing multi-process complexity.

## Architecture Overview

The implementation will move from a DeepSeek-specific pipeline to a three-layer structure:

1. Extension provider registry
2. Shared provider/helper contract
3. Helper provider adapter layer

### Extension Provider Registry

The extension runtime becomes a provider registrar instead of a single-provider implementation. It will register:

- `deepseek-web`
- `qwen-web`

Each provider remains independently selectable from the extension UI. Each provider defines its own metadata such as:

- provider id
- API id label
- model ids
- display name
- reasoning/input flags if needed

The runtime flow for helper startup, helper authentication, stream handling, protocol repair, and provider response mapping stays shared.

### Shared Provider/Helper Contract

The helper contract becomes explicitly provider-aware. Requests that currently depend on DeepSeek-only assumptions will include a provider field, so the helper never has to infer which website a request belongs to.

The contract remains provider-oriented instead of page-oriented. The extension still sends normalized provider messages, and the helper still returns normalized provider turns.

### Helper Provider Adapter Layer

The helper gains a registry of provider adapters. An adapter owns the provider-specific parts of the automation lifecycle:

- supported URL validation
- page binding semantics
- new chat/session reset behavior
- prompt submission behavior
- page event collection and parsing
- completion turn classification

The helper core continues to own:

- HTTP routes
- auth and loopback boundary
- active request serialization
- shared error normalization
- debug recording
- browser client orchestration

## Provider Model

The extension will expose separate providers rather than one merged provider with multiple models.

### Exposed Providers

- `deepseek-web`
- `qwen-web`

### Initial Models

- `deepseek-web-chat`
- `qwen-web-chat`

This boundary is intentional. DeepSeek and Qwen differ at the browser automation, binding, page protocol, and capability levels. Treating them as separate providers makes selection, debugging, and future capability divergence much easier to reason about.

## Helper State Design

The helper state must move from one global bound provider session to provider-scoped binding slots.

### Current Limitation

Today, helper state effectively assumes one bound session and one provider initialization fingerprint lifecycle.

### New State Shape

Conceptually, helper state should track:

- `boundSessionsByProvider[providerId]`
- `lastProviderRequestByProvider[providerId]`
- one shared `activeRequest`

Each bound provider session should include:

- `provider`
- `tabId`
- `url`
- `conversationId`
- `providerInitialized`
- `providerInitFingerprint`
- provider-specific metadata if needed later

### Active Request Policy

The helper should continue to allow only one active request globally.

Reasoning:

- this matches the current request lifecycle and error model
- it keeps this change focused on multi-provider routing rather than concurrency
- it reduces the number of moving pieces while the architecture boundary is being changed

A future concurrency upgrade can be considered later, but it should not be coupled to the Qwen/provider-switching work.

## Route and Contract Changes

Routes stay stable where possible, but request payloads become provider-aware.

### `POST /v1/bind`

The bind request should explicitly include the target provider.

Expected behavior:

- resolve the adapter by provider id
- validate the current page URL against that adapter
- bind the discovered tab/session into that provider slot only

Binding one provider must not overwrite another provider's binding state.

### `POST /v1/provider/chat`

`ProviderChatRequest` should be generalized from a fixed DeepSeek model contract to a provider-aware contract.

Recommended request shape:

- `provider: "deepseek-web" | "qwen-web"`
- `model: string`
- normalized provider messages
- optional session init fingerprint/prompt
- optional generation controls

Route behavior:

- resolve the adapter by `provider`
- fetch the bound session for that provider
- compute provider-specific fresh-session logic from that provider's stored fingerprint
- route automation through that provider's adapter
- return the existing normalized `ProviderChatResponse`

### `POST /v1/reset`

Reset should accept a provider and only clear that provider's state.

Expected behavior:

- clearing `deepseek-web` does not clear `qwen-web`
- if a global reset is ever needed, that should be a separate explicit operation

Provider-scoped reset avoids ambiguous behavior in a multi-provider helper.

### `GET /v1/debug/provider-last`

Debug access should become provider-aware.

Recommended behavior:

- allow querying the most recent request for a specific provider
- or return a provider-keyed summary if no provider filter is given

At minimum, every debug record must contain the provider id.

## Shared Contract Changes

The contract layer should remain stable in shape where possible, but provider identity must become first-class.

### `ProviderChatRequest`

Current DeepSeek-specific assumptions should be removed.

The request should include:

- `provider`
- `model`
- `messages`
- `sessionInit`
- `temperature`
- `maxOutputTokens`
- `abortKey`

The important change is that `model` is no longer a single literal type and that provider identity is explicit.

### Bind and Reset Contracts

Any request type that currently relies on implicit provider identity should gain a `provider` field.

### `ProviderChatResponse`

The response shape should remain compatible with the current extension flow:

- text mode
- thinking text when available
- structured tool-call mode when available
- finish reason
- optional `modelLabel`

This keeps the refactor focused on request routing and provider adapters rather than changing stream semantics.

## Extension Runtime Design

The extension runtime should be refactored from a single `registerDeepSeekExtension` style implementation into a shared runtime that registers provider descriptors.

### Runtime Responsibilities That Stay Shared

- helper startup and shutdown
- helper authentication token generation
- helper bind calls
- provider chat request construction
- session init prompt construction
- protocol repair logic
- stream event emission
- normalized tool-call emission

### Runtime Responsibilities That Become Descriptor-Driven

- provider id
- API id
- API key label
- model ids and names
- display labels used in registration

This preserves one runtime implementation while allowing multiple provider registrations.

## Provider Adapter Interface

Introduce a helper-side adapter interface with explicit responsibilities.

Each adapter should define behavior equivalent to:

- `providerId`
- `assertSupportedUrl(rawUrl)`
- `startNewChat(tabId)`
- `sendChatPrompt({ tabId, prompt, timeoutMs, freshSession })`
- provider-specific turn classification support if not already embedded in `sendChatPrompt`

The adapter boundary should be narrow. It should own site-specific behavior, not helper route orchestration or generic error shaping.

## DeepSeek Adapter Migration

The current DeepSeek page bridge and URL validation logic should be moved under a DeepSeek adapter without intentionally changing behavior.

Expected migration outcome:

- existing DeepSeek tests continue to pass after path and contract adjustments
- DeepSeek remains the reference implementation of the adapter interface
- DeepSeek-specific host allowlist and turn classification move out of shared helper files

This migration is important because it proves the adapter interface against known working behavior before Qwen is layered in.

## Qwen Adapter Design

The first Qwen adapter targets `https://chat.qwen.ai/`.

### Qwen Adapter Responsibilities

- validate `chat.qwen.ai` URLs
- bind a Qwen chat tab into the `qwen-web` provider slot
- start a new Qwen chat when required
- submit prompts to the Qwen page
- collect and normalize the completed turn
- extract text output
- extract thinking output if Qwen visibly exposes it in a reliable way
- detect structured tool output only if the page protocol clearly supports it

### First-Version Capability Expectation

The first implementation should be allowed to ship with:

- reliable text output
- optional thinking extraction if feasible
- no hard requirement for native tool-calling support

If Qwen lacks stable native tool-calling signals, the shared JSON fallback path can still be used later, but the initial architecture should not block delivery on full parity.

## Error Handling

The shared helper error model remains:

- `NOT_BOUND`
- `PAGE_UNAVAILABLE`
- `MODEL_BUSY`
- `TIMEOUT`
- `AUTOMATION_DESYNC`

### New Requirement

Errors and debug records must carry provider context.

At minimum, debug records should include:

- `provider`
- target URL
- tab id
- request prompt
- adapter stage when relevant, such as:
  - `bind`
  - `start_new_chat`
  - `send_prompt`
  - `parse_turn`

This is necessary to separate Qwen breakage from DeepSeek breakage once both are live.

## Testing Strategy

The refactor is large enough that testing has to protect both the new architecture and DeepSeek behavior.

### 1. Shared Contract and Helper State Tests

Add or update tests to verify:

- provider-aware request contracts
- provider-scoped binding state
- provider-scoped reset behavior
- one provider binding does not overwrite another
- debug state is tagged by provider

### 2. Extension Runtime Tests

Add or update tests to verify:

- both `deepseek-web` and `qwen-web` providers are registered
- selecting each provider sends the correct `provider` id in helper requests
- the helper is started once and reused across providers
- provider/model metadata remains distinct per registration

### 3. DeepSeek Regression Tests

Update existing DeepSeek tests to operate through the adapterized structure and verify:

- no behavior regression in text turns
- no behavior regression in thinking separation
- no behavior regression in tool-call repair/emission

### 4. Qwen Adapter Tests

Add Qwen-focused tests for:

- host allowlist validation
- provider-specific binding
- basic prompt submission path
- text turn extraction
- optional thinking extraction if implemented

These tests should not require full tool-call parity in the first version.

### 5. Route-Level Integration Tests

Add route coverage for multi-provider behavior, including:

- bind DeepSeek, then bind Qwen, both persist independently
- chat via DeepSeek only uses DeepSeek bound state
- chat via Qwen only uses Qwen bound state
- resetting one provider does not clear the other

## File-Level Design

The refactor should converge toward this layout:

- `src/extension/provider-runtime.ts`
  - shared multi-provider extension registration/runtime
- `src/shared/contracts.ts`
  - provider-aware helper contracts
- `src/helper/state.ts`
  - provider-keyed binding/debug state
- `src/helper/types.ts`
  - provider-aware helper types
- `src/helper/routes/bind.ts`
  - provider-aware binding route
- `src/helper/routes/provider-chat.ts`
  - provider-aware chat dispatch route
- `src/helper/routes/reset.ts`
  - provider-aware reset route
- `src/helper/routes/debug-provider-last.ts`
  - provider-aware debug route
- `src/helper/providers/types.ts`
  - adapter interface/types
- `src/helper/providers/registry.ts`
  - provider id to adapter map
- `src/helper/providers/deepseek/adapter.ts`
  - DeepSeek adapter
- `src/helper/providers/deepseek/page-bridge.ts`
  - DeepSeek page bridge moved under provider folder
- `src/helper/providers/qwen/adapter.ts`
  - Qwen adapter
- `src/helper/providers/qwen/page-bridge.ts`
  - Qwen page bridge

This structure keeps provider-specific logic local while preserving a single helper core.

## Data Flow

A normal request should flow like this:

1. The extension user selects `deepseek-web` or `qwen-web`.
2. The corresponding provider registration in the extension builds a provider chat request containing `provider` and `model`.
3. The helper receives the request and resolves the adapter by provider id.
4. The helper loads the provider-specific bound session.
5. If session initialization changed, the helper uses that provider's fresh-session logic.
6. The adapter performs site-specific browser automation.
7. The helper translates the adapter result into the existing normalized provider response.
8. The extension emits the same stream event protocol it already uses.

This preserves the top-level provider semantics while isolating website-specific logic at the bottom.

## Migration Sequence

Implementation should happen in this order:

1. generalize contracts and helper state for provider-aware routing
2. refactor the extension runtime to register multiple provider descriptors
3. migrate DeepSeek-specific helper logic into a DeepSeek adapter without changing behavior
4. make routes dispatch through the provider registry
5. add the Qwen adapter with a minimal reliable text path
6. expand tests for multi-provider routing and provider isolation

This order reduces risk because DeepSeek remains the control case throughout the refactor.

## Risks and Mitigations

### Risk: Route refactor breaks existing DeepSeek behavior

Mitigation:

- migrate DeepSeek into the adapter abstraction first
- preserve existing normalized response shapes
- keep regression tests green before adding Qwen

### Risk: Qwen page structure differs too much from DeepSeek

Mitigation:

- keep the adapter interface narrow and site-specific
- only require first-version Qwen text support
- defer native tool-call parity until there is a stable page signal

### Risk: Multi-provider helper state becomes ambiguous

Mitigation:

- require provider on bind/chat/reset requests
- key state and debug records by provider
- avoid implicit fallback behavior

### Risk: Scope growth into concurrency redesign

Mitigation:

- keep global single active request semantics unchanged
- treat concurrency as a separate future project

## Success Criteria

This design is successful when all of the following are true:

- the extension shows `deepseek-web` and `qwen-web` as separate selectable providers
- one helper process serves both providers
- helper state and routes are explicitly provider-aware
- DeepSeek behavior remains intact after adapterization
- Qwen can be bound and used for at least text responses through the same provider pipeline
- switching providers does not overwrite or corrupt the other provider's binding state

## Out of Scope Follow-Ups

These are natural future tasks but are intentionally excluded from this design:

- provider-level parallel request execution
- multi-helper process isolation
- capability negotiation across providers
- full Qwen native tool-calling parity
- richer provider-specific diagnostics UI in the extension
