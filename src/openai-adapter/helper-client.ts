import type { ProviderChatRequest, ProviderChatResponse } from "../shared/contracts";
import {
  buildSessionTitleResponse,
  isSessionTitleRequest,
} from "../shared/session-title";
import {
  CODE_AGENT_SYSTEM_PROMPT,
} from "../shared/code-agent-prompt";
import { mapHelperError } from "./errors";
import type { NormalizedRequest } from "./types";

type FetchImpl = typeof fetch;

function buildToolCatalogPrompt(tools: NormalizedRequest["tools"]) {
  if (tools.length === 0) {
    return "";
  }

  return [
    "当你通过 JSON 回退协议调用工具时，只能使用下面这些精确定义。",
    "必须严格使用 schema 中给出的工具名与参数键，参数值必须满足对应的 JSON schema。",
    ...tools.map((tool) =>
      [
        `工具名：${tool.name}`,
        tool.description ? `描述：${tool.description}` : "",
        `参数 JSON Schema：${tool.parametersJson}`,
      ]
        .filter((part) => part.length > 0)
        .join("\n"),
    ),
  ].join("\n\n");
}

function buildToolChoicePrompt(toolChoice: NormalizedRequest["toolChoice"]) {
  if (toolChoice === "none") {
    return "本轮禁止调用任何工具。你必须返回 message 类型的 JSON 对象。";
  }

  if (toolChoice === "required") {
    return "本轮必须至少调用一个工具。你必须返回 tool_call 或 tool_calls 类型的 JSON 对象。";
  }

  if (toolChoice === "auto") {
    return "只有在使用工具是正确完成任务的必要条件时，才调用工具。";
  }

  return `本轮必须调用名为“${toolChoice.name}”的工具，并返回 tool_call 类型的 JSON 对象。`;
}

function buildSessionInit(request: NormalizedRequest) {
  const systemPrompts = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);

  const parts = [
    CODE_AGENT_SYSTEM_PROMPT,
    buildToolCatalogPrompt(request.tools),
    buildToolChoicePrompt(request.toolChoice),
    ...systemPrompts,
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
