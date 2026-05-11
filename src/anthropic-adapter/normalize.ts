import type { PublicModel } from "../openai-adapter/models";
import { invalidRequestError } from "./errors";
import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  NormalizedToolChoice,
} from "./types";

type AnthropicContentBlock =
  | {
      type: "text";
      text?: string;
    }
  | {
      type: "tool_use";
      id?: string;
      name?: string;
      input?: unknown;
    }
  | {
      type: "tool_result";
      tool_use_id?: string;
      content?: string | Array<{ type?: string; text?: string }>;
      is_error?: boolean;
    }
  | {
      type: "image" | "document";
      source?: unknown;
    };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

type AnthropicTool = {
  name?: string;
  description?: string;
  input_schema?: unknown;
};

type AnthropicToolChoice =
  | { type?: "auto" | "any" | "tool" | "none"; name?: string }
  | undefined;

type AnthropicSystem =
  | string
  | Array<{
      type?: string;
      text?: string;
    }>;

function stringifyUnknown(input: unknown) {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function textFromToolResultContent(
  content: string | Array<{ type?: string; text?: string }> | undefined,
) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function normalizeContentBlocks(blocks: AnthropicContentBlock[]) {
  return blocks
    .map((block) => {
      if (block.type === "text") {
        return block.text ?? "";
      }

      if (block.type === "tool_use") {
        const name = block.name ?? "unknown_tool";
        const id = block.id ?? "tool_use";
        return [
          `[assistant tool_use ${name} id=${id}]`,
          stringifyUnknown(block.input ?? {}),
        ].join("\n");
      }

      if (block.type === "tool_result") {
        const status = block.is_error ? "error" : "ok";
        return [
          `[user tool_result id=${block.tool_use_id ?? "tool_use"} status=${status}]`,
          textFromToolResultContent(block.content),
        ]
          .filter((part) => part.length > 0)
          .join("\n");
      }

      return `[unsupported ${block.type} block omitted]`;
    })
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function normalizeMessageContent(content: AnthropicMessage["content"]) {
  if (typeof content === "string") {
    return content;
  }

  return normalizeContentBlocks(content);
}

function normalizeMessages(messages: AnthropicMessage[] = []) {
  return messages.map<NormalizedMessage>((message) => ({
    role: message.role,
    content: normalizeMessageContent(message.content),
  }));
}

function normalizeSystem(system: AnthropicSystem | undefined) {
  if (typeof system === "string") {
    return system;
  }

  if (!Array.isArray(system)) {
    return "";
  }

  return system
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function normalizeTools(tools: AnthropicTool[] = []): NormalizedTool[] {
  return tools
    .filter((tool) => typeof tool.name === "string" && tool.name.length > 0)
    .map((tool) => ({
      name: tool.name as string,
      description: tool.description,
      parametersJson: JSON.stringify(tool.input_schema ?? {}),
    }));
}

function normalizeToolChoice(toolChoice: AnthropicToolChoice): NormalizedToolChoice {
  const nextType = toolChoice?.type ?? "auto";

  if (nextType === "none") {
    return "none";
  }

  if (nextType === "tool") {
    if (typeof toolChoice?.name !== "string" || toolChoice.name.length === 0) {
      throw invalidRequestError("tool_choice.name is required when tool_choice.type is \"tool\"");
    }

    return {
      type: "function",
      name: toolChoice.name,
    };
  }

  return "auto";
}

export function normalizeMessagesRequest(
  body: {
    model?: string;
    system?: AnthropicSystem;
    messages?: AnthropicMessage[];
    tools?: AnthropicTool[];
    tool_choice?: AnthropicToolChoice;
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
  },
  model: PublicModel,
): NormalizedRequest {
  const normalizedMessages = normalizeMessages(body.messages);
  const systemPrompt = normalizeSystem(body.system);

  return {
    publicModel: model.id,
    provider: model.provider,
    responseFormat: "anthropic_messages",
    messages: [
      ...(systemPrompt.length > 0
        ? [{ role: "system" as const, content: systemPrompt }]
        : []),
      ...normalizedMessages,
    ],
    tools: normalizeTools(body.tools),
    toolChoice: normalizeToolChoice(body.tool_choice),
    ...(typeof body.temperature === "number"
      ? { temperature: body.temperature }
      : {}),
    ...(typeof body.max_tokens === "number"
      ? { maxOutputTokens: body.max_tokens }
      : {}),
  };
}

export function estimateInputTokens(body: {
  system?: AnthropicSystem;
  messages?: Array<{
    role: "user" | "assistant";
    content?: string | Array<{ type?: string; text?: string }>;
  }>;
  tools?: AnthropicTool[];
}) {
  const textParts = [
    normalizeSystem(body.system),
    ...normalizeMessages(
      (body.messages ?? []).map((message) => ({
        role: message.role,
        content:
          typeof message.content === "string"
            ? message.content
            : (message.content ?? [])
                .filter((block) => block.type === "text")
                .map((block) => ({
                  type: "text" as const,
                  text: block.text,
                })),
      })),
    ).map((message) => message.content),
    ...normalizeTools(body.tools).map(
      (tool) => `${tool.name}\n${tool.description ?? ""}\n${tool.parametersJson}`,
    ),
  ].filter((part) => part.length > 0);

  const totalChars = textParts.join("\n").length;
  return Math.max(1, Math.ceil(totalChars / 4));
}
