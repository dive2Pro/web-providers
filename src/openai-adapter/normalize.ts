import type { PublicModel } from "./models";
import { unsupportedFeatureError } from "./errors";
import { shouldDropToolForProvider } from "../shared/tool-filter";
import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  NormalizedToolChoice,
} from "./types";

type ChatCompletionsMessage = {
  role: NormalizedMessage["role"];
  content: string;
};

type ChatCompletionsTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
    input_schema?: unknown;
  };
};

type ResponsesInputMessage = {
  role: NormalizedMessage["role"];
  content?:
    | string
    | Array<{
        type: string;
        text?: string;
      }>;
};

type ResponsesTool = {
  type?: "function";
  name: string;
  description?: string;
  parameters?: unknown;
  input_schema?: unknown;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
    input_schema?: unknown;
  };
};

type NamedToolChoice = {
  type: "function";
  function?: {
    name?: string;
  };
  name?: string;
};

export type NormalizeMode = "json" | "buffered_streaming";

type NormalizeOptions = {
  mode?: NormalizeMode;
};

function normalizeChatToolChoice(input: unknown): NormalizedToolChoice {
  if (input === undefined) {
    return "none";
  }

  if (input === "auto" || input === "none") {
    return input;
  }

  if (typeof input === "object" && input !== null) {
    const named = input as NamedToolChoice;
    const functionName = named.function?.name ?? named.name;
    if (typeof functionName === "string" && functionName.length > 0) {
      return {
        type: "function",
        name: functionName,
      };
    }
  }

  return "none";
}

function normalizeMessages(messages: ChatCompletionsMessage[] = []) {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === "string" ? message.content : "",
  }));
}

function normalizeChatTools(tools: ChatCompletionsTool[] = []): NormalizedTool[] {
  const resolveSchema = (input: { parameters?: unknown; input_schema?: unknown }) =>
    input.parameters ?? input.input_schema ?? {};

  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parametersJson: JSON.stringify(resolveSchema(tool.function)),
  }));
}

function textFromResponseInput(content: ResponsesInputMessage["content"] = []) {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((item) => item.type === "input_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function normalizeResponsesInput(
  input: string | ResponsesInputMessage[] | undefined,
): NormalizedMessage[] {
  if (typeof input === "string") {
    return [
      {
        role: "user",
        content: input,
      },
    ];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  return input.map((message) => ({
    role: message.role,
    content: textFromResponseInput(message.content),
  }));
}

function normalizeResponsesTools(tools: ResponsesTool[] = []): NormalizedTool[] {
  const resolveSchema = (input: {
    parameters?: unknown;
    input_schema?: unknown;
  }) => input.parameters ?? input.input_schema ?? {};

  return tools.map((tool) => ({
    name: tool.name ?? tool.function?.name ?? "",
    description: tool.description ?? tool.function?.description,
    parametersJson: JSON.stringify(
      resolveSchema({
        parameters: tool.parameters ?? tool.function?.parameters,
        input_schema: tool.input_schema ?? tool.function?.input_schema,
      }),
    ),
  }));
}

function normalizeResponsesToolChoice(input: unknown): NormalizedToolChoice {
  if (input === undefined) {
    return "none";
  }

  if (input === "auto" || input === "none") {
    return input;
  }

  if (typeof input === "object" && input !== null) {
    const named = input as NamedToolChoice;
    const functionName = named.name ?? named.function?.name;
    if (typeof functionName === "string" && functionName.length > 0) {
      return {
        type: "function",
        name: functionName,
      };
    }
  }

  return "none";
}

function filterToolsForModel(model: PublicModel, tools: NormalizedTool[]) {
  return tools.filter((tool) => !shouldDropToolForProvider(model.provider, tool.name));
}

function normalizeToolChoiceForAvailableTools(
  toolChoice: NormalizedToolChoice,
  tools: NormalizedTool[],
): NormalizedToolChoice {
  if (toolChoice === "none") {
    return "none";
  }

  if (tools.length === 0) {
    return "none";
  }

  if (toolChoice === "required" || toolChoice === "auto") {
    return toolChoice;
  }

  return tools.some((tool) => tool.name === toolChoice.name) ? toolChoice : "auto";
}

function assertToolSupport(input: {
  model: PublicModel;
  tools: NormalizedTool[];
  toolChoice: NormalizedToolChoice;
}) {
  if (input.model.supportsTools) {
    return;
  }

  if (
    input.tools.length === 0 &&
    (input.toolChoice === "none" || input.toolChoice === "auto")
  ) {
    return;
  }

  throw unsupportedFeatureError(`${input.model.id} does not support tools`);
}

function assertStreamingSupport(stream: unknown, mode: NormalizeMode) {
  if (stream === true && mode !== "buffered_streaming") {
    throw new Error("Streaming is not supported");
  }
}

export function normalizeChatCompletionsRequest(
  body: {
    model?: string;
    stream?: boolean;
    messages?: ChatCompletionsMessage[];
    tools?: ChatCompletionsTool[];
    tool_choice?: unknown;
    temperature?: number;
    max_tokens?: number;
  },
  model: PublicModel,
  options: NormalizeOptions = {},
): NormalizedRequest {
  const mode = options.mode ?? "json";
  assertStreamingSupport(body.stream, mode);
  const normalizedTools = filterToolsForModel(model, normalizeChatTools(body.tools));
  const normalizedToolChoice = normalizeToolChoiceForAvailableTools(
    normalizeChatToolChoice(body.tool_choice),
    normalizedTools,
  );
  assertToolSupport({
    model,
    tools: normalizedTools,
    toolChoice: normalizedToolChoice,
  });

  return {
    publicModel: model.id,
    provider: model.provider,
    responseFormat: "chat_completions",
    messages: normalizeMessages(body.messages),
    tools: normalizedTools,
    toolChoice: normalizedToolChoice,
    ...(typeof body.temperature === "number"
      ? { temperature: body.temperature }
      : {}),
    ...(typeof body.max_tokens === "number"
      ? { maxOutputTokens: body.max_tokens }
      : {}),
  };
}

export function normalizeResponsesRequest(
  body: {
    model?: string;
    stream?: boolean;
    input?: string | ResponsesInputMessage[];
    tools?: ResponsesTool[];
    tool_choice?: unknown;
    temperature?: number;
    max_output_tokens?: number;
  },
  model: PublicModel,
  options: NormalizeOptions = {},
): NormalizedRequest {
  const mode = options.mode ?? "json";
  assertStreamingSupport(body.stream, mode);
  const normalizedTools = filterToolsForModel(model, normalizeResponsesTools(body.tools));
  const normalizedToolChoice = normalizeToolChoiceForAvailableTools(
    normalizeResponsesToolChoice(body.tool_choice),
    normalizedTools,
  );
  assertToolSupport({
    model,
    tools: normalizedTools,
    toolChoice: normalizedToolChoice,
  });

  return {
    publicModel: model.id,
    provider: model.provider,
    responseFormat: "responses",
    messages: normalizeResponsesInput(body.input),
    tools: normalizedTools,
    toolChoice: normalizedToolChoice,
    ...(typeof body.temperature === "number"
      ? { temperature: body.temperature }
      : {}),
    ...(typeof body.max_output_tokens === "number"
      ? { maxOutputTokens: body.max_output_tokens }
      : {}),
  };
}
