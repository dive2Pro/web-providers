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
  role?: string;
  content?: string | AnthropicContentBlock[];
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

      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function normalizeMessageContent(content: AnthropicMessage["content"]) {
  if (typeof content === "string") {
    return content;
  }

  return Array.isArray(content) ? normalizeContentBlocks(content) : "";
}

function normalizeMessages(messages: AnthropicMessage[] = []) {
  return messages.map<NormalizedMessage>((message) => ({
    role: message.role as "user" | "assistant",
    content: normalizeMessageContent(message.content ?? ""),
  }));
}

function normalizeSystem(system: AnthropicSystem | undefined) {
  if (typeof system === "string") {
    return system.trim();
  }

  if (!Array.isArray(system)) {
    return "";
  }

  return system
    .map((block, index) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        throw invalidRequestError(`system[${index}] must be an object`);
      }

      if (block.type !== "text") {
        throw invalidRequestError(`system[${index}].type must be "text"`);
      }

      if (typeof block.text !== "string") {
        throw invalidRequestError(`system[${index}].text must be a string`);
      }

      return block.text.trim();
    })
    .filter((block) => block.length > 0)
    .join("\n");
}

function normalizeTools(tools: AnthropicTool[] = []): NormalizedTool[] {
  return tools.map((tool, index) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      throw invalidRequestError(`tools[${index}] must be an object`);
    }

    if (typeof tool.name !== "string" || tool.name.trim().length === 0) {
      throw invalidRequestError(`tools[${index}].name must be a non-empty string`);
    }

    if (
      tool.input_schema === undefined ||
      !tool.input_schema ||
      typeof tool.input_schema !== "object" ||
      Array.isArray(tool.input_schema)
    ) {
      throw invalidRequestError(`tools[${index}].input_schema must be a JSON object`);
    }

    return {
      name: tool.name.trim(),
      description: tool.description,
      parametersJson: JSON.stringify(tool.input_schema),
    };
  });
}

function normalizeToolChoice(toolChoice: AnthropicToolChoice): NormalizedToolChoice {
  const nextType = toolChoice?.type ?? "auto";

  if (
    nextType !== "auto" &&
    nextType !== "any" &&
    nextType !== "tool" &&
    nextType !== "none"
  ) {
    throw invalidRequestError(
      'tool_choice.type must be one of "auto", "any", "tool", or "none"',
    );
  }

  if (nextType === "none") {
    return "none";
  }

  if (nextType === "any") {
    return "required";
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

function normalizeToolResultTextArray(
  content: Array<{ type?: string; text?: string }>,
  path: string,
) {
  return content.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw invalidRequestError(`${path}[${index}] must be an object`);
    }

    if (item.type !== "text") {
      throw invalidRequestError(`${path}[${index}].type must be "text"`);
    }

    if (typeof item.text !== "string") {
      throw invalidRequestError(`${path}[${index}].text must be a string`);
    }

    return {
      type: "text" as const,
      text: item.text,
    };
  });
}

function validateContentBlocks(
  blocks: AnthropicContentBlock[],
  message: AnthropicMessage,
  messageIndex: number,
  previousMessage: AnthropicMessage | undefined,
) {
  let seenNonToolResult = false;
  const previousToolUseIds = new Set<string>();

  if (
    previousMessage?.role === "assistant" &&
    Array.isArray(previousMessage.content)
  ) {
    for (const block of previousMessage.content) {
      if (
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        block.id.trim().length > 0
      ) {
        previousToolUseIds.add(block.id.trim());
      }
    }
  }

  for (const [blockIndex, block] of blocks.entries()) {
    const path = `messages[${messageIndex}].content[${blockIndex}]`;
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw invalidRequestError(`${path} must be an object`);
    }

    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw invalidRequestError(`${path}.text must be a string`);
      }
      seenNonToolResult = true;
      continue;
    }

    if (block.type === "tool_use") {
      if (message.role !== "assistant") {
        throw invalidRequestError(`${path}.type "tool_use" is only allowed in assistant messages`);
      }

      if (typeof block.id !== "string" || block.id.trim().length === 0) {
        throw invalidRequestError(`${path}.id must be a non-empty string`);
      }

      if (typeof block.name !== "string" || block.name.trim().length === 0) {
        throw invalidRequestError(`${path}.name must be a non-empty string`);
      }

      if (
        !block.input ||
        typeof block.input !== "object" ||
        Array.isArray(block.input)
      ) {
        throw invalidRequestError(`${path}.input must be a JSON object`);
      }

      seenNonToolResult = true;
      continue;
    }

    if (block.type === "tool_result") {
      if (message.role !== "user") {
        throw invalidRequestError(`${path}.type "tool_result" is only allowed in user messages`);
      }

      if (seenNonToolResult) {
        throw invalidRequestError(
          `messages[${messageIndex}].content tool_result blocks must come before all other content blocks`,
        );
      }

      if (previousToolUseIds.size === 0) {
        throw invalidRequestError(
          `messages[${messageIndex}] tool_result blocks must immediately follow an assistant tool_use message`,
        );
      }

      if (
        typeof block.tool_use_id !== "string" ||
        block.tool_use_id.trim().length === 0
      ) {
        throw invalidRequestError(`${path}.tool_use_id must be a non-empty string`);
      }

      if (!previousToolUseIds.has(block.tool_use_id.trim())) {
        throw invalidRequestError(
          `${path}.tool_use_id must reference a tool_use block in messages[${messageIndex - 1}]`,
        );
      }

      if (
        block.content !== undefined &&
        typeof block.content !== "string" &&
        !Array.isArray(block.content)
      ) {
        throw invalidRequestError(`${path}.content must be a string or an array of text blocks`);
      }

      if (Array.isArray(block.content)) {
        normalizeToolResultTextArray(block.content, `${path}.content`);
      }

      if (
        block.is_error !== undefined &&
        typeof block.is_error !== "boolean"
      ) {
        throw invalidRequestError(`${path}.is_error must be a boolean`);
      }

      continue;
    }

    if (block.type === "image" || block.type === "document") {
      throw invalidRequestError(`${path}.type "${block.type}" is not supported by this adapter`);
    }

    throw invalidRequestError(
      `${path}.type must be one of "text", "tool_use", or "tool_result"`,
    );
  }
}

function validateMessages(messages: AnthropicMessage[] = []) {
  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw invalidRequestError(`messages[${index}] must be an object`);
    }

    if (message.role !== "user" && message.role !== "assistant") {
      throw invalidRequestError(`messages[${index}].role must be "user" or "assistant"`);
    }

    if (typeof message.content === "string") {
      continue;
    }

    if (!Array.isArray(message.content)) {
      throw invalidRequestError(
        `messages[${index}].content must be a string or an array of content blocks`,
      );
    }

    validateContentBlocks(message.content, message, index, messages[index - 1]);
  }
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
  validateMessages(body.messages);
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
