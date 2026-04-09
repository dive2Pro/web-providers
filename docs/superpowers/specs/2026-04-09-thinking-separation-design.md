# DeepSeek Thinking Separation Design

## Goal

When DeepSeek web runs with thinking enabled, capture thinking content separately from the final assistant answer so downstream consumers can render them independently.

## Current Problem

The bridge currently accumulates only one text buffer and returns it as `outputText`. In thinking mode, DeepSeek emits multiple fragment types over SSE, including `THINK` and `RESPONSE`. Because the bridge does not track fragment type, thinking content can be merged into the final answer or dropped.

## Design

### Bridge

`src/helper/browser/deepseek-page-bridge.ts` will track two buffers while parsing SSE:

- `thinking` for fragments with `type: "THINK"`
- `reply` for fragments with `type: "RESPONSE"`

It will also track the current fragment type so `response/fragments/-1/content` continuation patches append to the correct buffer.

### Helper Contract

`mode: "text"` responses will add an optional `thinkingText` field. Tool-call responses may also carry optional `thinkingText` so reasoning is preserved even when the assistant ends in tool use.

### Extension Runtime

`src/extension/provider-runtime.ts` will map `thinkingText` to assistant content entries of shape `{ type: "thinking", thinking: string }`. Final answer text continues to map to `{ type: "text", text: string }`.

This preserves existing text and tool-call behavior while allowing the UI to distinguish thinking from the real answer.

## Compatibility

- No-thinking sessions remain unchanged.
- Existing final answer parsing still uses `outputText`.
- Tool-call parsing continues to use the existing strict protocol and fallback repair logic.

## Testing

- Bridge tests cover `THINK` plus `RESPONSE` SSE reconstruction.
- Helper route tests cover `thinkingText` passthrough.
- Extension tests cover assistant output containing both `thinking` and `text`.
