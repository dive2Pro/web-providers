# DeepSeek Web Bridge for `pi` Extension

Date: 2026-04-08

## Summary

Build a local-only bridge that lets `pi-agent-code` use an already logged-in DeepSeek web session through a `pi` extension. The extension exposes a small, stable chat capability. A local helper process owns browser automation through `bb-browser`, injects a page bridge into the DeepSeek tab, sends prompts, observes streamed replies, and exposes a local debug surface for inspection.

This design is intentionally narrow:

- Single user
- Same machine only
- Single active DeepSeek tab binding
- Text-only chat
- No login export
- No prompt orchestration in the extension

## Goals

- Reuse an already authenticated DeepSeek web session from the local browser.
- Expose a minimal chat interface to `pi-agent-code` via a `pi` extension.
- Preserve the existing system prompt behavior inside `pi-agent-code`.
- Provide a real-time debugging view for requests, events, and streamed output.
- Return stable, implementation-agnostic error codes to the extension.

## Non-Goals

- Multi-user or remote access
- Cookie, token, or localStorage export
- General-purpose browser automation
- Attachment upload, screenshots, or file handling
- Session listing, session switching, rename, delete, or export
- Rewriting or augmenting the prompt produced by `pi-agent-code`
- Long-term persistence or analytics over chat history

## Recommended Architecture

Recommended approach: `pi extension + local helper`

### Components

1. `pi extension`
   - Exposes a narrow tool surface to `pi-agent-code`.
   - Starts and supervises the local helper process.
   - Authenticates to the helper with a one-time local token.
   - Translates helper responses and errors into extension-friendly results.

2. `local helper`
   - Only local process allowed to communicate with `bb-browser`.
   - Owns page discovery, tab binding, script injection, request serialization, timeout handling, and debug state.
   - Exposes a loopback-only local API and local debug page.

3. `page bridge`
   - Injected into the DeepSeek page by the helper.
   - Detects page state, sends messages, observes streamed assistant output, and emits normalized events.

4. `session adapter`
   - Internal helper layer that maps local API requests to page bridge operations and browser state transitions.

### Data Flow

`pi-agent-code -> pi extension -> local helper -> bb-browser -> DeepSeek page bridge -> local helper -> pi extension -> pi-agent-code`

## Design Principles

- The extension is a transport and observability layer, not a prompt authoring layer.
- Browser session authority stays in the logged-in browser tab.
- External callers do not receive browser internals or DOM details.
- The first version favors recoverability and inspectability over breadth.
- Only one active request is allowed at a time.

## Local API

The helper exposes a loopback-only API. `127.0.0.1` is sufficient for the first version. Unix sockets can be considered later if needed.

### `POST /v1/chat`

Purpose:
- Send a text prompt through the currently bound DeepSeek tab and return the completed reply.

Request:
- `prompt: string`
- `conversation_id?: string`
- `timeout_ms?: number`

Response:
- `reply: string`
- `conversation_id: string`
- `model_label?: string`
- `raw_status: "completed" | "timeout" | "failed"`

Notes:
- `conversation_id` is a helper-generated logical ID, not the DeepSeek internal conversation identifier.
- The helper maps the logical conversation to the current bound tab and active webpage conversation.

### `GET /v1/health`

Purpose:
- Report whether the helper is live and whether a valid DeepSeek tab is currently bound.

Response includes:
- helper process status
- browser connectivity status
- bind state
- last bridge heartbeat
- degraded flag

### `POST /v1/bind`

Purpose:
- Bind the helper to an already opened DeepSeek tab.

Response includes:
- `tab_id`
- normalized URL
- login detection result
- bridge injection status
- initial page state summary

### `POST /v1/reset`

Purpose:
- Clear local helper runtime state without modifying the webpage conversation itself.

Effects:
- Clears active request context
- Removes stale observers
- Resets cached stream state
- Rebuilds page bridge state if the tab remains valid

## Debug API and Local Debug Page

Because the main requirement is operational visibility, the helper also exposes a local-only debug surface.

### `GET /v1/debug/last`

Returns the last normalized call record, including:
- request time
- request ID
- target tab
- prompt
- reply
- duration
- result code

### `GET /v1/debug/events`

Returns the recent event timeline, including:
- event time
- request ID
- event type
- lightweight event payload

### `GET /v1/debug/page-snapshot`

Returns a redacted page state summary, including:
- current URL
- login detection result
- bridge health
- page busy state
- input availability
- latest assistant text preview

### `GET /debug`

Serves a local-only debug page for human inspection.

The page shows:
- current bind status
- latest request and reply
- live event timeline
- live streamed text mirror
- latest failure summary

### Debug Content Policy

Default mode:
- show full prompt and full reply for local debugging

Optional mode:
- `redacted` view that shows summaries or excerpts only

Retention:
- keep only recent in-memory history, such as the last 50 requests and related events

## Security Model

The bridge is strictly local.

### Hard Requirements

- Listen only on `127.0.0.1`
- Require a one-time bearer token generated by the extension at helper startup
- Accept only requests from the local extension client
- Allow binding only to a DeepSeek domain allowlist
- Expose no API for arbitrary script execution
- Expose no API for cookie or token extraction
- Expose no API for arbitrary URL navigation

### Allowed Trust Boundaries

- `pi-agent-code` trusts the `pi` extension
- the `pi` extension trusts the local helper it launched
- the local helper trusts only the currently bound DeepSeek tab and its injected bridge

### Rejected Behaviors

- remote access
- generic browser remote control
- exporting browser session material
- concurrent writes into the same webpage input

## Page Bridge Responsibilities

The page bridge is event-driven and long-lived while the DeepSeek tab remains valid.

### Capabilities

1. `page_state`
   - detect input field
   - detect send button or stop button
   - detect whether the assistant is currently generating
   - detect the latest assistant message node

2. `send`
   - write prompt text into the input field
   - trigger the send action in a way consistent with the page
   - emit send lifecycle events

3. `observe`
   - attach `MutationObserver` instances to the active assistant reply region
   - stream deltas to the helper
   - detect completion, abort, or desync

4. `snapshot`
   - return a redacted, normalized page state summary

### Bridge Event Types

- `bridge_ready`
- `page_state_changed`
- `message_send_started`
- `message_sent`
- `assistant_stream_started`
- `assistant_stream_delta`
- `assistant_stream_completed`
- `assistant_stream_aborted`
- `selector_miss`
- `page_desync`

The helper forwards these as normalized events instead of leaking raw DOM semantics.

## Request Lifecycle

1. Extension launches helper and stores the local bearer token.
2. Helper binds to a currently opened, logged-in DeepSeek tab.
3. Extension sends `POST /v1/chat`.
4. Helper verifies that no other request is active.
5. Helper ensures bridge health and valid page state.
6. Bridge writes the prompt and triggers send.
7. Bridge emits `assistant_stream_started` and zero or more `assistant_stream_delta` events.
8. Helper accumulates streamed text in the active request context.
9. When the bridge emits completion, helper returns the final normalized reply.
10. Debug endpoints and the local debug page can inspect the same active request in real time.

## Active Request Context

The helper maintains one in-memory active request object:

- `request_id`
- `started_at`
- `tab_id`
- `conversation_id`
- `prompt`
- `accumulated_reply`
- `last_event_at`
- `status`
- `final_error_code?`

This object powers both the blocking chat response path and the live debug views.

## Error Model

The extension receives stable error codes rather than DOM-specific failures.

### Error Codes

- `NOT_BOUND`
  - no valid DeepSeek tab is currently bound

- `PAGE_UNAVAILABLE`
  - tab closed, navigated away, logged out, or no longer matches expected page structure

- `MODEL_BUSY`
  - webpage is already generating and cannot accept a new prompt

- `TIMEOUT`
  - prompt was sent but no completed reply was observed before timeout

- `AUTOMATION_DESYNC`
  - helper and page bridge disagree about actionable state and recovery is required

### Translation Rule

Low-level failures such as selector misses or stale nodes are translated into the stable error model above before leaving the helper.

## Recovery Strategy

Recovery is tiered.

### Soft Recovery

Used when:
- bridge still appears alive
- page state is briefly inconsistent
- stream start is missing but the tab is still present

Actions:
- re-sample page state
- rebuild observers
- re-check input and busy state

### Session Recovery

Used when:
- the tab is still on DeepSeek
- a rerender invalidated node references
- the bridge needs reinjection or local runtime reset

Actions:
- clear active request state
- reset observers and cached stream buffers
- reinject or reinitialize the bridge

### Hard Rebind

Used when:
- tab closed
- URL changed away from DeepSeek
- login no longer valid
- repeated recovery attempts fail

Actions:
- move helper into `NOT_BOUND` or `PAGE_UNAVAILABLE`
- require `POST /v1/bind`

### Recovery Rules

- do not allow concurrent active requests
- if send succeeds but neither stream start nor busy state appears in time, return `AUTOMATION_DESYNC`
- if streaming stalls with no deltas and no completion signal, return `TIMEOUT`
- after repeated failures, stop retrying automatically and require rebind

## Watchdog

The helper runs a lightweight watchdog to detect silent page drift.

Probe targets:
- current tab URL
- login indicator
- input field availability
- bridge heartbeat
- page busy state

If the watchdog detects drift, the helper marks itself `degraded` and surfaces that status through `/v1/health` and `/debug`.

## First-Version Scope

### Included

- local helper process started by the extension
- single DeepSeek tab bind
- text-only prompt send and reply receive
- one-request-at-a-time execution
- real-time event stream and streamed text inspection
- local debug APIs and debug page
- normalized error model

### Excluded

- attachments
- screenshots
- image or multimodal input
- session enumeration and switching
- title generation
- prompt rewriting
- long-term transcript storage
- remote or shared deployment

## Testing Strategy

### Unit Tests

Cover:
- helper request state machine
- request serialization
- error code translation
- event retention buffer
- debug endpoint normalization

### Integration Tests

Use a mock page bridge to simulate:
- normal streamed completion
- timeout
- desync
- aborted generation
- page unavailable

Verify:
- extension-helper protocol behavior
- event propagation
- active request bookkeeping

### Manual End-to-End Tests

Required because the highest risk is real webpage drift.

Scenarios:
- bind to logged-in DeepSeek tab
- send prompt and receive final reply
- watch live streamed output on `/debug`
- reset and send again
- refresh page and recover
- close tab and confirm stable failure
- induce timeout and confirm recovery path

## Success Criteria

- A logged-in DeepSeek page can be bound successfully.
- `pi-agent-code` can submit a text prompt through the extension and receive a final reply.
- The local debug page shows real-time events and streamed text.
- Common failures return stable error codes and are recoverable without restarting the whole system in normal cases.

## Open Implementation Decisions

These are implementation choices, not design blockers:

- exact helper runtime language
- exact transport between extension and helper if future migration from HTTP to Unix socket is desired
- exact DeepSeek selector strategy and fallback heuristics
- exact UI shape of the local debug page

None of these change the architectural boundaries or scope above.
