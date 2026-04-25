import { describe, expect, it } from "vitest";
import {
  assertQwenUrl,
  INJECTED_QWEN_BRIDGE_SOURCE,
  QWEN_BRIDGE_VERSION,
  parseQwenCompletionSse,
} from "../src/providers/qwen/page-bridge";

describe("qwen adapter", () => {
  it("accepts chat.qwen.ai URLs", () => {
    expect(assertQwenUrl("https://chat.qwen.ai/")).toBe("https://chat.qwen.ai/");
  });

  it("rejects unsupported hosts", () => {
    expect(() => assertQwenUrl("https://example.com/")).toThrow(
      /Unsupported Qwen host/,
    );
  });

  it("parses the Qwen completion SSE body into thinking and answer text", () => {
    const parsed = parseQwenCompletionSse([
      'data: {"response.created":{"chat_id":"chat-1","response_id":"resp-1"}}',
      "",
      'data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"thinking_summary","extra":{"summary_title":{"content":["Responding with precision and clarity"]}},"status":"typing"}}],"response_id":"resp-1"}',
      "",
      'data: {"choices":[{"delta":{"role":"assistant","content":"probe-qwen","phase":"answer","status":"typing"}}],"response_id":"resp-1"}',
      "",
      'data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"answer","status":"finished"}}],"response_id":"resp-1"}',
    ].join("\n"));

    expect(parsed).toEqual({
      mode: "text",
      thinkingText: "Responding with precision and clarity",
      outputText: "probe-qwen",
    });
  });

  it("parses native tool calls from the Qwen completion SSE body", () => {
    const parsed = parseQwenCompletionSse([
      'data: {"response.created":{"chat_id":"chat-1","response_id":"resp-1"}}',
      "",
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"read","arguments":{"path":"src/app.ts"}}}]}}],"response_id":"resp-1"}',
      "",
      'data: {"choices":[{"delta":{"status":"finished"}}],"response_id":"resp-1"}',
    ].join("\n"));

    expect(parsed).toEqual({
      mode: "native_tool_call",
      toolCall: {
        name: "read",
        argumentsJson: "{\"path\":\"src/app.ts\"}",
      },
      outputText: "",
    });
  });

  it("parses answer content when delta.content is an array payload", () => {
    const parsed = parseQwenCompletionSse([
      'data: {"choices":[{"delta":{"role":"assistant","content":[{"text":"hey"},{"text":"22"}],"phase":"answer","status":"typing"}}],"response_id":"resp-1"}',
      "",
      'data: {"choices":[{"delta":{"status":"finished"}}],"response_id":"resp-1"}',
    ].join("\n"));

    expect(parsed).toEqual({
      mode: "text",
      outputText: "hey22",
    });
  });

  it("parses answer content from nested message payloads without an explicit phase", () => {
    const parsed = parseQwenCompletionSse([
      'data: {"choices":[{"delta":{"message":{"content":[{"text":"hello"},{"text":" world"}]},"status":"typing"}}],"response_id":"resp-1"}',
      "",
      'data: {"response.completed":{"response_id":"resp-1"}}',
    ].join("\n"));

    expect(parsed).toEqual({
      mode: "text",
      outputText: "hello world",
    });
  });

  it("version-stamps the injected Qwen bridge so a newer bridge can re-patch the page", () => {
    expect(QWEN_BRIDGE_VERSION).toBeGreaterThan(1);
    expect(INJECTED_QWEN_BRIDGE_SOURCE).toContain("window.__piQwenFetchPatchedVersion");
    expect(INJECTED_QWEN_BRIDGE_SOURCE).toContain("!== BRIDGE_VERSION");
    expect(INJECTED_QWEN_BRIDGE_SOURCE).toContain("version: BRIDGE_VERSION");
    expect(INJECTED_QWEN_BRIDGE_SOURCE).toContain("function parseQwenDeltaText");
    expect(INJECTED_QWEN_BRIDGE_SOURCE).toContain("function normalizeQwenToolCall");
  });
});
