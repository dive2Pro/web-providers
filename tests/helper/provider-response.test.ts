import { describe, expect, it } from "vitest";
import {
  getProviderResponseRepairDecision,
  normalizeProviderResponse,
} from "../../src/helper/provider-response";

describe("provider response normalization", () => {
  it("normalizes a tool_call envelope with content into tool output plus text", () => {
    const normalized = normalizeProviderResponse({
      mode: "text",
      outputText: JSON.stringify({
        type: "tool_call",
        content: "I will inspect the stylesheet first.",
        name: "read_file",
        arguments: { path: "src/styles.css" },
      }),
      finishReason: "stop",
      modelLabel: "DeepSeek Web",
    });

    expect(normalized).toEqual({
      mode: "json_fallback",
      toolCalls: [
        {
          name: "read_file",
          argumentsJson: "{\"path\":\"src/styles.css\"}",
        },
      ],
      outputText: "I will inspect the stylesheet first.",
      finishReason: "stop",
      modelLabel: "DeepSeek Web",
    });
  });

  it("accepts a mixed tool_calls envelope without requesting repair", () => {
    const response = {
      mode: "text" as const,
      outputText: JSON.stringify({
        type: "tool_calls",
        content: "I will gather the key style files first.",
        calls: [
          {
            name: "read_file",
            arguments: { path: "src/app.css" },
          },
          {
            name: "read_file",
            arguments: { path: "src/theme.css" },
          },
        ],
      }),
      finishReason: "stop" as const,
      modelLabel: "DeepSeek Web",
    };

    const decision = getProviderResponseRepairDecision(response);

    expect(decision.shouldRepair).toBe(false);
    expect(decision.issues).toEqual([]);
    expect(decision.rawOutput).toBe(response.outputText);
    expect(decision.response).toEqual({
      mode: "json_fallback",
      toolCalls: [
        {
          name: "read_file",
          argumentsJson: "{\"path\":\"src/app.css\"}",
        },
        {
          name: "read_file",
          argumentsJson: "{\"path\":\"src/theme.css\"}",
        },
      ],
      outputText: "I will gather the key style files first.",
      finishReason: "stop",
      modelLabel: "DeepSeek Web",
    });
  });
});
