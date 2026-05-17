import type { ProviderChatResponse } from "../shared/contracts";
import {
  JSON_PROTOCOL_PROMPT_PREFIXES,
  JSON_PROTOCOL_REPAIR_ACTION_RULE,
  JSON_PROTOCOL_REPAIR_HEADER,
  JSON_PROTOCOL_REPAIR_REQUIREMENT,
  RESPONSE_MESSAGE_EXAMPLE,
  RESPONSE_TOOL_CALLS_EXAMPLE,
  RESPONSE_TOOL_CALL_EXAMPLE,
} from "../shared/code-agent-prompt";

type ProtocolEnvelope =
  | {
      type: "message";
      content: string;
    }
  | {
      type: "tool_call";
      content?: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "tool_calls";
      content?: string;
      calls: Array<{
        name: string;
        arguments: Record<string, unknown>;
      }>;
    };

function parseStrictProtocolEnvelope(text: string): {
  envelope: ProtocolEnvelope | null;
  protocolLike: boolean;
  error: string | null;
} {
  function parseEnvelopeObject(candidate: Record<string, unknown>): ProtocolEnvelope | null {
    if (candidate.type === "message") {
      if (Object.keys(candidate).length !== 2 || typeof candidate.content !== "string") {
        return null;
      }

      return {
        type: "message",
        content: candidate.content,
      };
    }

    if (candidate.type === "tool_call") {
      if (
        ![3, 4].includes(Object.keys(candidate).length) ||
        typeof candidate.name !== "string" ||
        ("content" in candidate && typeof candidate.content !== "string") ||
        !candidate.arguments ||
        typeof candidate.arguments !== "object" ||
        Array.isArray(candidate.arguments)
      ) {
        return null;
      }

      return {
        type: "tool_call",
        name: candidate.name,
        ...(typeof candidate.content === "string"
          ? { content: candidate.content }
          : {}),
        arguments: candidate.arguments as Record<string, unknown>,
      };
    }

    if (candidate.type === "tool_calls") {
      if (
        ![2, 3].includes(Object.keys(candidate).length) ||
        ("content" in candidate && typeof candidate.content !== "string") ||
        !Array.isArray(candidate.calls) ||
        candidate.calls.length === 0
      ) {
        return null;
      }

      const calls = candidate.calls
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return null;
          }

          const call = entry as Record<string, unknown>;
          if (
            typeof call.name !== "string" ||
            !call.arguments ||
            typeof call.arguments !== "object" ||
            Array.isArray(call.arguments)
          ) {
            return null;
          }

          return {
            name: call.name,
            arguments: call.arguments as Record<string, unknown>,
          };
        })
        .filter(
          (
            entry,
          ): entry is { name: string; arguments: Record<string, unknown> } => entry !== null,
        );

      if (calls.length !== candidate.calls.length) {
        return null;
      }

      return {
        type: "tool_calls",
        ...(typeof candidate.content === "string"
          ? { content: candidate.content }
          : {}),
        calls,
      };
    }

    return null;
  }

  function extractEmbeddedObjects(source: string) {
    const objects: Array<{ json: string; startIndex: number }> = [];
    let depth = 0;
    let startIndex = -1;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        if (depth === 0) {
          startIndex = index;
        }
        depth += 1;
        continue;
      }

      if (char === "}") {
        if (depth === 0) {
          continue;
        }

        depth -= 1;
        if (depth === 0 && startIndex >= 0) {
          objects.push({
            json: source.slice(startIndex, index + 1),
            startIndex,
          });
          startIndex = -1;
        }
      }
    }

    return objects;
  }

  function selectEmbeddedEnvelope(source: string): {
    envelope: ProtocolEnvelope | null;
    error: string | null;
  } {
    const embedded = extractEmbeddedObjects(source)
      .map((entry) => {
        const prefix = source
          .slice(Math.max(0, entry.startIndex - 80), entry.startIndex)
          .toLowerCase();
        if (JSON_PROTOCOL_PROMPT_PREFIXES.some((marker) => prefix.includes(marker))) {
          return null;
        }

        try {
          const parsedEntry = JSON.parse(entry.json);
          if (!parsedEntry || typeof parsedEntry !== "object" || Array.isArray(parsedEntry)) {
            return null;
          }
          return parseEnvelopeObject(parsedEntry as Record<string, unknown>);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is ProtocolEnvelope => entry !== null);

    if (embedded.length > 1) {
      return {
        envelope: null,
        error: "Multiple protocol envelopes were found. Return exactly one JSON object.",
      };
    }

    return {
      envelope: embedded[0] ?? null,
      error: null,
    };
  }

  const trimmed = text.trim();
  const protocolLike =
    /"type"\s*:\s*"(message|tool_call|tool_calls)"/.test(text) || trimmed.startsWith("{");

  if (trimmed.length === 0) {
    return {
      envelope: null,
      protocolLike: false,
      error: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const embeddedResult = selectEmbeddedEnvelope(text);
    if (embeddedResult.error) {
      return {
        envelope: null,
        protocolLike: true,
        error: embeddedResult.error,
      };
    }

    if (embeddedResult.envelope) {
      return {
        envelope: embeddedResult.envelope,
        protocolLike: true,
        error: null,
      };
    }

    return {
      envelope: null,
      protocolLike,
      error: protocolLike ? "Return exactly one JSON object." : null,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      envelope: null,
      protocolLike,
      error: "Top-level reply must be a JSON object.",
    };
  }

  const candidate = parsed as Record<string, unknown>;
  const directEnvelope = parseEnvelopeObject(candidate);
  if (directEnvelope) {
    return {
      envelope: directEnvelope,
      protocolLike: true,
      error: null,
    };
  }

  const embeddedResult = selectEmbeddedEnvelope(text);
  if (embeddedResult.error) {
    return {
      envelope: null,
      protocolLike: true,
      error: embeddedResult.error,
    };
  }

  if (embeddedResult.envelope) {
    return {
      envelope: embeddedResult.envelope,
      protocolLike: true,
      error: null,
    };
  }

  if (candidate.type === "message") {
    return {
      envelope: null,
      protocolLike: true,
      error: 'Message replies must match {"type":"message","content":"..."} exactly.',
    };
  }

  if (candidate.type === "tool_call") {
    return {
      envelope: null,
      protocolLike: true,
      error:
        'Tool calls must match {"type":"tool_call","name":"tool_name","arguments":{...}} exactly, with optional "content":"...".',
    };
  }

  if (candidate.type === "tool_calls") {
    return {
      envelope: null,
      protocolLike: true,
      error:
        'Multi-tool replies must match {"type":"tool_calls","calls":[{"name":"tool_name","arguments":{...}}]} exactly, with optional "content":"...".',
    };
  }

  return {
    envelope: null,
    protocolLike,
    error: 'Reply "type" must be "message", "tool_call", or "tool_calls".',
  };
}

function parseValidatedToolCall(input: {
  name: string;
  argumentsJson: string;
}) {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new Error("toolCalls[].name must be a non-empty string");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.argumentsJson);
  } catch {
    throw new Error(`toolCalls[${name}].argumentsJson must be valid JSON`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`toolCalls[${name}].argumentsJson must encode a JSON object`);
  }

  return {
    name,
    arguments: parsed as Record<string, unknown>,
  };
}

function parseValidatedToolCalls(
  toolCalls: Array<{
    name: string;
    argumentsJson: string;
  }>,
) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new Error("toolCalls must be a non-empty array");
  }

  return toolCalls.map((toolCall) => parseValidatedToolCall(toolCall));
}

export function normalizeProviderResponse(
  response: ProviderChatResponse,
): ProviderChatResponse {
  if (response.mode !== "text") {
    return response;
  }

  const parsed = parseStrictProtocolEnvelope(response.outputText);
  if (parsed.envelope?.type === "message") {
    return {
      ...response,
      outputText: parsed.envelope.content,
    };
  }

  if (
    parsed.envelope?.type !== "tool_call" &&
    parsed.envelope?.type !== "tool_calls"
  ) {
    return response;
  }

  return {
    mode: "json_fallback",
    toolCalls:
      parsed.envelope.type === "tool_call"
        ? [
            {
              name: parsed.envelope.name,
              argumentsJson: JSON.stringify(parsed.envelope.arguments),
            },
          ]
        : parsed.envelope.calls.map((toolCall) => ({
            name: toolCall.name,
            argumentsJson: JSON.stringify(toolCall.arguments),
          })),
    finishReason: response.finishReason === "error" ? "error" : "stop",
    modelLabel: response.modelLabel,
    ...(typeof response.thinkingText === "string"
      ? { thinkingText: response.thinkingText }
      : {}),
    ...(typeof parsed.envelope.content === "string"
      ? { outputText: parsed.envelope.content }
      : {}),
  };
}

export function getProviderResponseRepairDecision(
  response: ProviderChatResponse,
): {
  response: ProviderChatResponse;
  shouldRepair: boolean;
  issues: string[];
  rawOutput: string;
} {
  const originalParsed =
    response.mode === "text"
      ? parseStrictProtocolEnvelope(response.outputText)
      : null;
  const normalized = normalizeProviderResponse(response);

  if (normalized.mode !== "text") {
    try {
      const toolCalls = parseValidatedToolCalls(normalized.toolCalls);
      return {
        response: normalized,
        shouldRepair: false,
        issues: [],
        rawOutput:
          response.mode === "text"
            ? response.outputText ?? ""
            : JSON.stringify(
                toolCalls.length === 1
                  ? {
                      type: "tool_call",
                      ...(typeof normalized.outputText === "string"
                        ? { content: normalized.outputText }
                        : {}),
                      name: toolCalls[0]?.name,
                      arguments: toolCalls[0]?.arguments,
                    }
                  : {
                      type: "tool_calls",
                      ...(typeof normalized.outputText === "string"
                        ? { content: normalized.outputText }
                        : {}),
                      calls: toolCalls.map((toolCall) => ({
                        name: toolCall.name,
                        arguments: toolCall.arguments,
                      })),
                    },
              ),
      };
    } catch (error) {
      return {
        response: normalized,
        shouldRepair: true,
        issues: [error instanceof Error ? error.message : String(error)],
        rawOutput: normalized.outputText ?? "",
      };
    }
  }

  if (originalParsed?.envelope?.type === "message") {
    return {
      response: normalized,
      shouldRepair: false,
      issues: [],
      rawOutput: response.outputText ?? "",
    };
  }

  const outputText = response.outputText ?? "";
  const parsed = originalParsed ?? parseStrictProtocolEnvelope(outputText);
  return {
    response: normalized,
    shouldRepair: parsed.envelope === null,
    issues: parsed.error ? [parsed.error] : ["Return exactly one JSON object."],
    rawOutput: outputText,
  };
}

export function buildProviderResponseRepairPrompt(input: {
  issues: string[];
  rawOutput: string;
  attempt: number;
}) {
  return [
    JSON_PROTOCOL_REPAIR_HEADER,
    JSON_PROTOCOL_REPAIR_REQUIREMENT,
    JSON_PROTOCOL_REPAIR_ACTION_RULE,
    `普通回复使用：${RESPONSE_MESSAGE_EXAMPLE}`,
    `工具调用使用：${RESPONSE_TOOL_CALL_EXAMPLE}`,
    `多工具并行调用使用：${RESPONSE_TOOL_CALLS_EXAMPLE}`,
    "继续遵守本轮对话前文已经提供的系统提示与工具定义。",
    `修复轮次：${input.attempt}。`,
    "需要修复的问题：",
    ...input.issues.map((issue) => `- ${issue}`),
    "上一条无效回复：",
    input.rawOutput.trim().length > 0 ? input.rawOutput : "(空回复)",
  ].join("\n");
}
