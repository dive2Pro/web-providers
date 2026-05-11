import type { ProviderChatRequest, ProviderChatResponse } from "../shared/contracts";
import {
  buildSessionTitleResponse,
  isSessionTitleRequest,
} from "../shared/session-title";
import { mapHelperError } from "./errors";
import type { NormalizedRequest } from "./types";

type FetchImpl = typeof fetch;

const RESPONSE_ENVELOPE_INSTRUCTION = [
  "Your entire assistant reply must be exactly one JSON object.",
  "Return exactly one final action object per reply: either a message or a tool_call, never both.",
  "If you need multiple tool calls, return only the first tool_call and wait for the next turn.",
  'For normal replies use: {"type":"message","content":"your response text"}',
  'For tool calls use: {"type":"tool_call","name":"tool_name","arguments":{"key":"value"}}',
  "Do not add any prose before or after it.",
  "Do not wrap it in markdown or code fences.",
].join(" ");

function buildToolCatalogPrompt(tools: NormalizedRequest["tools"]) {
  if (tools.length === 0) {
    return "";
  }

  return [
    "When using JSON fallback tool calls, you must use one of these exact tool definitions.",
    "Use the exact tool name and argument keys from the schema.",
    ...tools.map((tool) =>
      [
        `Tool name: ${tool.name}`,
        tool.description ? `Description: ${tool.description}` : "",
        `Arguments JSON schema: ${tool.parametersJson}`,
      ]
        .filter((part) => part.length > 0)
        .join("\n"),
    ),
  ].join("\n\n");
}

function buildToolChoicePrompt(toolChoice: NormalizedRequest["toolChoice"]) {
  if (toolChoice === "none") {
    return "Do not call any tool. Return a normal reply JSON object.";
  }

  if (toolChoice === "auto") {
    return "Call a tool only when it is necessary to answer correctly.";
  }

  return `You must call the tool named "${toolChoice.name}" and return a tool_call JSON object.`;
}

function buildSessionInit(request: NormalizedRequest) {
  const systemPrompts = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);

  const hasTooling = request.tools.length > 0;
  const parts = [
    ...systemPrompts,
    ...(hasTooling ? [RESPONSE_ENVELOPE_INSTRUCTION] : []),
    ...(hasTooling ? [buildToolCatalogPrompt(request.tools)] : []),
    ...(hasTooling ? [buildToolChoicePrompt(request.toolChoice)] : []),
  ]
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return undefined;
  }

  return {
    prompt: parts.join("\n\n"),
  };
}

export function toProviderChatRequest(
  request: NormalizedRequest,
): ProviderChatRequest {
  const sessionInit = buildSessionInit(request);
  return {
    provider: request.provider,
    model: request.publicModel,
    messages: request.messages,
    ...(sessionInit ? { sessionInit } : {}),
    ...(typeof request.temperature === "number"
      ? { temperature: request.temperature }
      : {}),
    ...(typeof request.maxOutputTokens === "number"
      ? { maxOutputTokens: request.maxOutputTokens }
      : {}),
  };
}

export function createHelperClient(input: {
  helperBaseUrl: string;
  helperToken?: string;
  fetchImpl?: FetchImpl;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async run(
      request: NormalizedRequest,
      options?: { sessionId?: string; signal?: AbortSignal },
    ): Promise<ProviderChatResponse> {
      if (isSessionTitleRequest(request.messages)) {
        return buildSessionTitleResponse(request.messages);
      }

      const helperRequest = toProviderChatRequest(request);

      const response = await fetchImpl(
        `${input.helperBaseUrl}/v1/provider/chat`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(input.helperToken
              ? { authorization: `Bearer ${input.helperToken}` }
              : {}),
            ...(options?.sessionId
              ? { "x-web-providers-session-id": options.sessionId }
              : {}),
          },
          ...(options?.signal ? { signal: options.signal } : {}),
          body: JSON.stringify(helperRequest),
        },
      );

      const payload = (await response.json()) as
        | ProviderChatResponse
        | { error?: string; message?: string };

      if (!response.ok) {
        throw mapHelperError(payload as { error?: string; message?: string });
      }

      return payload as ProviderChatResponse;
    },
  };
}
