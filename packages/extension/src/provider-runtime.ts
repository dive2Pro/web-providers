import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type {
  ProviderChatRequest,
  ProviderChatResponse,
} from "@web-providers/shared";

interface ManagedHelper {
  baseUrl: string;
  token: string;
  stop(): Promise<void>;
}

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ThinkingContent = { type: "thinking"; thinking: string };
type ToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type UserMessage = {
  role: "user";
  content: string | Array<TextContent | ImageContent>;
  timestamp: number;
};

type AssistantMessage = {
  role: "assistant";
  content: Array<TextContent | ThinkingContent | ToolCallContent>;
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
};

type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<TextContent | ImageContent>;
  isError: boolean;
  timestamp: number;
};

type ToolDefinition = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
};

type ProtocolEnvelope =
  | {
      type: "message";
      content: string;
    }
  | {
      type: "tool_call";
      name: string;
      arguments: Record<string, unknown>;
    };

interface ProviderContext {
  systemPrompt?: string;
  messages: Array<UserMessage | AssistantMessage | ToolResultMessage>;
  tools?: ToolDefinition[];
}

interface ProviderModel {
  id: string;
  api: string;
  provider: string;
}

interface SimpleStreamOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      partial: AssistantMessage;
    }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
      partial: AssistantMessage;
    }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCallContent;
      partial: AssistantMessage;
    }
  | {
      type: "done";
      reason: "stop" | "length" | "toolUse";
      message: AssistantMessage;
    }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };

interface ProviderModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: ProviderModelConfig[];
  streamSimple?: (
    model: ProviderModel,
    context: ProviderContext,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
}

class EventStream<T, R = T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiting: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;
  private readonly finalResultPromise: Promise<R>;
  private resolveFinalResult!: (result: R) => void;

  constructor(
    private readonly isComplete: (event: T) => boolean,
    private readonly extractResult: (event: T) => R,
  ) {
    this.finalResultPromise = new Promise<R>((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: T) {
    if (this.done) {
      return;
    }

    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }

    this.queue.push(event);
  }

  end(result?: R) {
    this.done = true;

    if (result !== undefined) {
      this.resolveFinalResult(result);
    }

    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as T;
        continue;
      }

      if (this.done) {
        return;
      }

      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting.push(resolve);
      });

      if (result.done) {
        return;
      }

      yield result.value;
    }
  }

  result() {
    return this.finalResultPromise;
  }
}

class AssistantMessageEventStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") {
          return event.message;
        }

        if (event.type === "error") {
          return event.error;
        }

        throw new Error("Unexpected final stream event");
      },
    );
  }
}

interface PiExtensionApi {
  registerProvider(name: string, config: ProviderConfig): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}

export interface ExtensionDeps {
  spawnHelper(input: { token: string; port: number }): Promise<ManagedHelper>;
  helperClient: {
    post<T>(
      baseUrl: string,
      path: string,
      body: Record<string, unknown>,
      token: string,
      signal?: AbortSignal,
    ): Promise<T>;
  };
  randomToken(): string;
}

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const PROVIDER_BASE_URL = "http://127.0.0.1";
const FIXED_HELPER_PORT = Number(process.env.PI_DEEPSEEK_HELPER_PORT ?? 4318);
const DEBUG_PROVIDER_REQUESTS = process.env.PI_DEEPSEEK_DEBUG === "1";
const PROVIDER_DESCRIPTORS = [
  {
    provider: "deepseek-web",
    api: "deepseek-web-api",
    apiKey: "deepseek-web-local",
    modelId: "deepseek-web-chat",
    modelName: "DeepSeek Web Chat",
  },
  {
    provider: "qwen-web",
    api: "qwen-web-api",
    apiKey: "qwen-web-local",
    modelId: "qwen-web-chat",
    modelName: "Qwen Web Chat",
  },
] as const;
const RESPONSE_ENVELOPE_INSTRUCTION = [
  "Your entire assistant reply must be exactly one JSON object.",
  'For normal replies use: {"type":"message","content":"your response text"}',
  'For tool calls use: {"type":"tool_call","name":"tool_name","arguments":{"key":"value"}}',
  "Do not add any prose before or after it.",
  "Do not wrap it in markdown or code fences.",
].join(" ");

function buildToolCatalogPrompt(tools: ToolDefinition[] | undefined) {
  if (!tools || tools.length === 0) {
    return "";
  }

  return [
    "When using JSON fallback tool calls, you must use one of these exact tool definitions.",
    "Use the exact tool name and argument keys from the schema.",
    ...tools.map((tool) =>
      [
        `Tool name: ${tool.name}`,
        tool.description ? `Description: ${tool.description}` : "",
        `Arguments JSON schema: ${JSON.stringify(getToolSchema(tool) ?? {})}`,
      ]
        .filter((part) => part.length > 0)
        .join("\n"),
    ),
  ].join("\n\n");
}

function getToolSchema(tool: ToolDefinition) {
  return tool.parameters ?? tool.inputSchema;
}

function logToolSchemaInspection(tools: ToolDefinition[] | undefined) {
  if (!DEBUG_PROVIDER_REQUESTS || !tools || tools.length === 0) {
    return;
  }

  logProviderDebug("tool schema inspection", {
    toolCount: tools.length,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? null,
      schemaSource:
        tool.parameters !== undefined
          ? "parameters"
          : tool.inputSchema !== undefined
            ? "inputSchema"
            : null,
      hasInputSchema: getToolSchema(tool) !== undefined,
      inputSchemaType:
        getToolSchema(tool) === undefined
          ? "undefined"
          : Array.isArray(getToolSchema(tool))
            ? "array"
            : typeof getToolSchema(tool),
      inputSchemaKeys:
        getToolSchema(tool) &&
        typeof getToolSchema(tool) === "object" &&
        !Array.isArray(getToolSchema(tool))
          ? Object.keys(getToolSchema(tool) as Record<string, unknown>)
          : [],
      inputSchemaPreview:
        getToolSchema(tool) === undefined
          ? null
          : JSON.stringify(getToolSchema(tool)),
    })),
  });
}

function parseStrictProtocolEnvelope(text: string): {
  envelope: ProtocolEnvelope | null;
  protocolLike: boolean;
  error: string | null;
} {
  function parseEnvelopeObject(candidate: Record<string, unknown>): ProtocolEnvelope | null {
    if (candidate.type === "message") {
      if (
        Object.keys(candidate).length !== 2 ||
        typeof candidate.content !== "string"
      ) {
        return null;
      }

      return {
        type: "message",
        content: candidate.content,
      };
    }

    if (candidate.type === "tool_call") {
      if (
        Object.keys(candidate).length !== 3 ||
        typeof candidate.name !== "string" ||
        !candidate.arguments ||
        typeof candidate.arguments !== "object" ||
        Array.isArray(candidate.arguments)
      ) {
        return null;
      }

      return {
        type: "tool_call",
        name: candidate.name,
        arguments: candidate.arguments as Record<string, unknown>,
      };
    }

    return null;
  }

  function isPlaceholderEnvelope(envelope: ProtocolEnvelope) {
    if (
      envelope.type === "message" &&
      envelope.content.trim() === "your response text"
    ) {
      return true;
    }

    if (
      envelope.type === "tool_call" &&
      envelope.name.trim() === "tool_name"
    ) {
      return true;
    }

    return false;
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

  function findEmbeddedEnvelope(source: string) {
    return extractEmbeddedObjects(source)
      .map((entry) => {
        const prefix = source
          .slice(Math.max(0, entry.startIndex - 80), entry.startIndex)
          .toLowerCase();
        if (
          prefix.includes("for normal replies use:") ||
          prefix.includes("for tool calls use:")
        ) {
          return null;
        }

        try {
          const parsedEntry = JSON.parse(entry.json);
          if (!parsedEntry || typeof parsedEntry !== "object" || Array.isArray(parsedEntry)) {
            return null;
          }
          const parsedEnvelope = parseEnvelopeObject(parsedEntry as Record<string, unknown>);
          if (!parsedEnvelope || isPlaceholderEnvelope(parsedEnvelope)) {
            return null;
          }
          return parsedEnvelope;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is ProtocolEnvelope => entry !== null)
      .at(-1);
  }

  const trimmed = text.trim();
  const protocolLike =
    /"type"\s*:\s*"(message|tool_call)"/.test(text) || trimmed.startsWith("{");

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
    const embeddedEnvelope = findEmbeddedEnvelope(text);
    if (embeddedEnvelope) {
      return {
        envelope: embeddedEnvelope,
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

  const embeddedEnvelope = findEmbeddedEnvelope(text);
  if (embeddedEnvelope) {
    return {
      envelope: embeddedEnvelope,
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
        'Tool calls must match {"type":"tool_call","name":"tool_name","arguments":{...}} exactly.',
    };
  }

  return {
    envelope: null,
    protocolLike,
    error: 'Reply "type" must be either "message" or "tool_call".',
  };
}

function normalizeProtocolMessageText(response: Extract<ProviderChatResponse, { mode: "text" }>) {
  const parsed = parseStrictProtocolEnvelope(response.outputText);
  if (parsed.envelope?.type === "message") {
    return {
      ...response,
      outputText: parsed.envelope.content,
    };
  }

  return response;
}

function normalizeProtocolToolCallResponse(
  response: Extract<ProviderChatResponse, { mode: "text" }>,
): ProviderChatResponse {
  const parsed = parseStrictProtocolEnvelope(response.outputText);
  if (parsed.envelope?.type !== "tool_call") {
    return response;
  }

  return {
    mode: "json_fallback",
    toolCall: {
      name: parsed.envelope.name,
      argumentsJson: JSON.stringify(parsed.envelope.arguments),
    },
    finishReason: response.finishReason === "length" ? "stop" : response.finishReason,
    modelLabel: response.modelLabel,
    ...(typeof response.thinkingText === "string"
      ? { thinkingText: response.thinkingText }
      : {}),
    outputText: response.outputText,
  };
}

function validateValueAgainstSchema(
  value: unknown,
  schema: Record<string, unknown> | undefined,
  path: string,
): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }

  const errors: string[] = [];
  const type = typeof schema.type === "string" ? schema.type : null;
  const properties =
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : null;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) {
    errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
    return errors;
  }

  if ("const" in schema && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    return errors;
  }

  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      return errors;
    }

    const record = value as Record<string, unknown>;
    for (const key of required) {
      if (!(key in record)) {
        errors.push(`${path}.${key} is required`);
      }
    }

    if (properties) {
      for (const [key, child] of Object.entries(record)) {
        if (key in properties) {
          errors.push(...validateValueAgainstSchema(child, properties[key], `${path}.${key}`));
          continue;
        }

        if (schema.additionalProperties === false) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }

    return errors;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return errors;
    }

    const itemSchema =
      schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)
        ? (schema.items as Record<string, unknown>)
        : undefined;
    if (itemSchema) {
      for (const [index, item] of value.entries()) {
        errors.push(...validateValueAgainstSchema(item, itemSchema, `${path}[${index}]`));
      }
    }

    return errors;
  }

  if (type === "string" && typeof value !== "string") {
    errors.push(`${path} must be a string`);
  }

  if (type === "number" && typeof value !== "number") {
    errors.push(`${path} must be a number`);
  }

  if (type === "integer" && (!Number.isInteger(value) || typeof value !== "number")) {
    errors.push(`${path} must be an integer`);
  }

  if (type === "boolean" && typeof value !== "boolean") {
    errors.push(`${path} must be a boolean`);
  }

  return errors;
}

function validateToolCallAgainstTools(
  toolCall: {
    name: string;
    arguments: Record<string, unknown>;
  },
  tools: ToolDefinition[] | undefined,
): string[] {
  if (!tools || tools.length === 0) {
    return [];
  }

  const matchedTool = tools.find((tool) => tool.name === toolCall.name);
  if (!matchedTool) {
    return [`Tool "${toolCall.name}" is not in the allowed tool list.`];
  }

  return validateValueAgainstSchema(
  toolCall.arguments,
    getToolSchema(matchedTool),
    "arguments",
  );
}

function buildProtocolRepairPrompt(input: {
  rawOutput: string;
  issues: string[];
  tools: ToolDefinition[] | undefined;
}) {
  return [
    "The previous reply violated the required JSON response protocol.",
    "Return exactly one JSON object and nothing else.",
    'For normal replies use: {"type":"message","content":"your response text"}',
    'For tool calls use: {"type":"tool_call","name":"tool_name","arguments":{"key":"value"}}',
    "Problems to fix:",
    ...input.issues.map((issue) => `- ${issue}`),
    "Previous invalid reply:",
    input.rawOutput,
    ...(input.tools && input.tools.length > 0
      ? ["Allowed tool definitions:", buildToolCatalogPrompt(input.tools)]
      : []),
  ].join("\n");
}

function buildMinimalProtocolRepairPrompt(tools: ToolDefinition[] | undefined) {
  return [
    "Return exactly one JSON object and nothing else.",
    'For normal replies use: {"type":"message","content":"your response text"}',
    'For tool calls use: {"type":"tool_call","name":"tool_name","arguments":{"key":"value"}}',
    "Do not repeat these instructions.",
    "Do not explain your answer.",
    "Do not wrap the JSON in markdown.",
    ...(tools && tools.length > 0
      ? [
          `Allowed tool names: ${tools.map((tool) => tool.name).join(", ")}`,
        ]
      : []),
  ].join("\n");
}

function looksLikeProtocolRepairEcho(text: string) {
  return text.includes(
    "The previous reply violated the required JSON response protocol.",
  );
}

function recoverPlainTextFromProtocolFailure(text: string) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return "";
  }

  const prefixBoilerplatePatterns = [
    /^The previous reply violated the required JSON response protocol\.$/,
    /^Return exactly one JSON object and nothing else\.$/,
    /^For normal replies use: .*$/,
    /^For tool calls use: .*$/,
    /^\{"type":"message","content":"your response text"\}$/,
    /^\{"type":"tool_call","name":"tool_name","arguments":\{"key":"value"\}\}$/,
    /^Problems to fix:$/,
    /^- .*$/,
    /^Previous invalid reply:$/,
    /^Allowed tool definitions:$/,
    /^When using JSON fallback tool calls, you must use one of these exact tool definitions\.$/,
    /^Use the exact tool name and argument keys from the schema\.$/,
    /^Tool name: .*$/,
    /^Description: .*$/,
    /^Arguments JSON schema: .*$/,
    /^Do not repeat these instructions\.$/,
    /^Do not explain your answer\.$/,
    /^Do not wrap the JSON in markdown\.$/,
    /^Allowed tool names: .*$/,
  ];

  const lines = normalized.split("\n");
  let startIndex = 0;
  let consumedBoilerplate = false;
  while (startIndex < lines.length) {
    const line = lines[startIndex]?.trim() ?? "";
    if (line.length === 0) {
      if (consumedBoilerplate) {
        startIndex += 1;
        break;
      }
      startIndex += 1;
      continue;
    }

    if (prefixBoilerplatePatterns.some((pattern) => pattern.test(line))) {
      consumedBoilerplate = true;
      startIndex += 1;
      continue;
    }

    break;
  }

  const recovered = lines
    .slice(startIndex)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "{" && line !== "}")
    .join("\n")
    .trim();

  return recovered;
}

function shouldRepairProviderResponse(
  response: ProviderChatResponse,
  tools: ToolDefinition[] | undefined,
): {
  shouldRepair: boolean;
  issues: string[];
  rawOutput: string;
} {
  if (response.mode !== "text") {
    try {
      const toolCall = parseValidatedToolCall(response.toolCall);
      const issues = validateToolCallAgainstTools(toolCall, tools);
      return {
        shouldRepair: issues.length > 0,
        issues,
        rawOutput:
          response.outputText ??
          JSON.stringify({
            type: "tool_call",
            name: response.toolCall.name,
            arguments: toolCall.arguments,
          }),
      };
    } catch (error) {
      return {
        shouldRepair: true,
        issues: [
          error instanceof Error ? error.message : String(error),
        ],
        rawOutput: response.outputText ?? "",
      };
    }
  }

  const parsed = parseStrictProtocolEnvelope(response.outputText);
  return {
    shouldRepair: parsed.protocolLike && parsed.envelope === null,
    issues: parsed.error ? [parsed.error] : [],
    rawOutput: response.outputText,
  };
}

function previewProviderOutput(text: string | undefined, maxLength = 240) {
  if (typeof text !== "string") {
    return null;
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

function logProviderResponseStage(input: {
  stage: string;
  response: ProviderChatResponse;
  tools: ToolDefinition[] | undefined;
}) {
  if (!DEBUG_PROVIDER_REQUESTS) {
    return;
  }

  const parsed =
    input.response.mode === "text"
      ? parseStrictProtocolEnvelope(input.response.outputText)
      : null;
  const repairDecision = shouldRepairProviderResponse(input.response, input.tools);

  logProviderDebug("provider protocol stage", {
    stage: input.stage,
    mode: input.response.mode,
    finishReason: input.response.finishReason,
    parsedEnvelopeType: parsed?.envelope?.type ?? null,
    protocolLike: parsed?.protocolLike ?? null,
    parseError: parsed?.error ?? null,
    shouldRepair: repairDecision.shouldRepair,
    repairIssues: repairDecision.issues,
    outputPreview: previewProviderOutput(
      "outputText" in input.response ? input.response.outputText : undefined,
    ),
    toolCallName:
      input.response.mode !== "text" ? input.response.toolCall.name : null,
  });
}

function createEmptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createAssistantOutput(model: ProviderModel): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function cloneAssistantOutput(output: AssistantMessage): AssistantMessage {
  return {
    ...output,
    content: output.content.map((part) => {
      if (part.type === "text") {
        return { ...part };
      }

      if (part.type === "thinking") {
        return { ...part };
      }

      return {
        ...part,
        arguments: { ...part.arguments },
      };
    }),
    usage: {
      ...output.usage,
      cost: { ...output.usage.cost },
    },
  };
}

function flattenUserContent(content: UserMessage["content"]) {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) =>
      part.type === "text" ? part.text : `[Image input omitted: ${part.mimeType}]`,
    )
    .join("\n")
    .trim();
}

function flattenAssistantContent(content: AssistantMessage["content"]) {
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      if (part.type === "thinking") {
        return "";
      }

      const toolCallPart = part as ToolCallContent;
      return `[Tool call ${toolCallPart.name} ${JSON.stringify(toolCallPart.arguments)}]`;
    })
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
}

function flattenToolResultContent(content: ToolResultMessage["content"]) {
  return content
    .map((part) =>
      part.type === "text" ? part.text : `[Tool image omitted: ${part.mimeType}]`,
    )
    .join("\n")
    .trim();
}

function pushProviderMessage(
  messages: ProviderChatRequest["messages"],
  role: ProviderChatRequest["messages"][number]["role"],
  content: string,
) {
  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return;
  }

  messages.push({ role, content: trimmed });
}

function buildSessionInitPrompt(context: ProviderContext) {
  const parts: string[] = [];

  logToolSchemaInspection(context.tools);

  if (context.systemPrompt?.trim()) {
    parts.push(context.systemPrompt.trim());
  }

  parts.push(RESPONSE_ENVELOPE_INSTRUCTION);

  if ((context.tools?.length ?? 0) > 0) {
    parts.push(buildToolCatalogPrompt(context.tools));
  }

  const prompt = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");

  if (prompt.length === 0) {
    return undefined;
  }

  const firstTimestamp = [...context.messages]
    .map((message) => message.timestamp)
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => left - right)[0];
  const fingerprint =
    typeof firstTimestamp === "number"
      ? `conv-${firstTimestamp}`
      : `conv-${createHash("sha256").update(prompt).digest("hex")}`;
  const sessionKey =
    typeof firstTimestamp === "number"
      ? `session-${firstTimestamp}`
      : `session-${createHash("sha256").update(prompt).digest("hex")}`;

  const sessionInit = {
    prompt,
    fingerprint,
    sessionKey,
  };

  logProviderDebug("session init computed", {
    fingerprint: sessionInit.fingerprint,
    sessionKey: sessionInit.sessionKey,
    firstTimestamp: typeof firstTimestamp === "number" ? firstTimestamp : null,
    messageCount: context.messages.length,
    messageTimestamps: context.messages.map((message) => message.timestamp),
    hasSystemPrompt: Boolean(context.systemPrompt?.trim()),
    toolCount: context.tools?.length ?? 0,
  });

  return sessionInit;
}

function toProviderMessages(context: ProviderContext): ProviderChatRequest["messages"] {
  const messages: ProviderChatRequest["messages"] = [];

  for (const message of context.messages) {
    if (message.role === "user") {
      pushProviderMessage(messages, "user", flattenUserContent(message.content));
      continue;
    }

    if (message.role === "assistant") {
      pushProviderMessage(messages, "assistant", flattenAssistantContent(message.content));
      continue;
    }

    const toolResult = flattenToolResultContent(message.content);
    pushProviderMessage(
      messages,
      "user",
      [
        `[Tool Result: ${message.toolName}]`,
        `Call ID: ${message.toolCallId}`,
        message.isError ? "Status: error" : "Status: success",
        toolResult,
      ]
        .filter((part) => part.length > 0)
        .join("\n"),
    );
  }

  return messages;
}

function parseValidatedToolCall(input: {
  name: string;
  argumentsJson: string;
}) {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new Error("Invalid DeepSeek tool call payload");
  }

  const parsed = JSON.parse(input.argumentsJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid DeepSeek tool call payload");
  }

  return {
    name,
    arguments: parsed as Record<string, unknown>,
  };
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function logProviderDebug(message: string, payload: Record<string, unknown>) {
  if (!DEBUG_PROVIDER_REQUESTS) {
    return;
  }

  console.error(
    `[deepseek-web] ${message} ${JSON.stringify(
      {
        at: new Date().toISOString(),
        ...payload,
      },
      null,
      2,
    )}`,
  );
}

async function postJson<T>(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  token: string,
  signal?: AbortSignal,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    throw new Error(JSON.stringify(parsed));
  }

  return parsed as T;
}

async function waitForHelperReady(baseUrl: string, token: string) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Helper did not become ready in time");
}

async function spawnDefaultHelper(input: {
  token: string;
  port: number;
}): Promise<ManagedHelper> {
  const child = spawn("npm", ["run", "dev:helper"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HELPER_TOKEN: input.token,
      PORT: String(input.port),
    },
    stdio: "pipe",
    shell: process.platform === "win32",
  });

  const baseUrl = `http://127.0.0.1:${input.port}`;

  await Promise.race([
    waitForHelperReady(baseUrl, input.token),
    once(child, "exit").then(([code]) => {
      throw new Error(`Helper exited early with code ${String(code)}`);
    }),
  ]);

  return {
    baseUrl,
    token: input.token,
    async stop() {
      if (child.exitCode !== null) {
        return;
      }

      child.kill("SIGTERM");

      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);

      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    },
  };
}

function defaultDeps(): ExtensionDeps {
  return {
    spawnHelper: spawnDefaultHelper,
    helperClient: {
      post: postJson,
    },
    randomToken: () => randomUUID(),
  };
}

export default function registerDeepSeekExtension(
  pi: PiExtensionApi,
  deps: ExtensionDeps = defaultDeps(),
) {
  let helperPromise: Promise<ManagedHelper> | null = null;
  let helper: ManagedHelper | null = null;

  async function ensureHelper() {
    if (helper) {
      return helper;
    }

    if (!helperPromise) {
      helperPromise = (async () => {
        const token = deps.randomToken();
        const started = await deps.spawnHelper({ token, port: FIXED_HELPER_PORT });
        helper = started;
        return started;
      })().catch((error) => {
        helperPromise = null;
        throw error;
      });
    }

    return helperPromise;
  }

  async function stopHelper() {
    const current = helper ?? (helperPromise ? await helperPromise : null);

    helper = null;
    helperPromise = null;

    if (current) {
      await current.stop();
    }
  }

  pi.on("session_start", async () => undefined);
  pi.on("session_shutdown", async () => {
    await stopHelper();
  });

  for (const descriptor of PROVIDER_DESCRIPTORS) {
    pi.registerProvider(descriptor.provider, {
      baseUrl: PROVIDER_BASE_URL,
      apiKey: descriptor.apiKey,
      api: descriptor.api,
      models: [
        {
          id: descriptor.modelId,
          name: descriptor.modelName,
          reasoning: false,
          input: ["text"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: 64_000,
          maxTokens: 8_000,
        },
      ],
      streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();

      void (async () => {
        const output = createAssistantOutput(model);
        stream.push({ type: "start", partial: output });

        try {
          const current = await ensureHelper();

          await deps.helperClient.post(
            current.baseUrl,
            "/v1/bind",
            {
              provider: model.provider,
            },
            current.token,
            options?.signal,
          );

          const sessionInit = buildSessionInitPrompt(context);
          const emitText = (text: string) => {
            if (text.length === 0) {
              return;
            }

            output.content.push({ type: "text", text: "" });
            const contentIndex = output.content.length - 1;
            stream.push({ type: "text_start", contentIndex, partial: output });

            const textPart = output.content[contentIndex];
            if (textPart?.type === "text") {
              textPart.text += text;
            }

            stream.push({
              type: "text_delta",
              contentIndex,
              delta: text,
              partial: output,
            });
            stream.push({
              type: "text_end",
              contentIndex,
              content: text,
              partial: output,
            });
          };

          const emitThinking = (thinking: string) => {
            if (thinking.length === 0) {
              return;
            }

            output.content.push({ type: "thinking", thinking: "" });
            const contentIndex = output.content.length - 1;
            stream.push({
              type: "thinking_start",
              contentIndex,
              partial: cloneAssistantOutput(output),
            });

            const thinkingPart = output.content[contentIndex];
            if (thinkingPart?.type === "thinking") {
              thinkingPart.thinking += thinking;
            }

            stream.push({
              type: "thinking_delta",
              contentIndex,
              delta: thinking,
              partial: cloneAssistantOutput(output),
            });
            stream.push({
              type: "thinking_end",
              contentIndex,
              content: thinking,
              partial: cloneAssistantOutput(output),
            });

            if (thinkingPart?.type === "thinking") {
              thinkingPart.thinking = "";
            }
          };

          const emitToolCall = (response: Extract<ProviderChatResponse, { mode: "native_tool_call" | "json_fallback" }>) => {
            const validatedToolCall = parseValidatedToolCall(response.toolCall);
            const toolCallId = `${model.provider}-${output.content.length}`;

            output.content.push({
              type: "toolCall",
              id: toolCallId,
              name: validatedToolCall.name,
              arguments: {},
            });
            const contentIndex = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex, partial: output });

            const toolCallBlock = output.content[contentIndex];
            if (toolCallBlock?.type === "toolCall") {
              toolCallBlock.arguments = validatedToolCall.arguments;
            }

            stream.push({
              type: "toolcall_delta",
              contentIndex,
              delta: response.toolCall.argumentsJson,
              partial: output,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex,
              toolCall: {
                type: "toolCall",
                id: toolCallId,
                name: validatedToolCall.name,
                arguments: validatedToolCall.arguments,
              },
              partial: output,
            });
          };

          const buildRequestPayload = (messages: ProviderChatRequest["messages"]) => ({
            provider: model.provider,
            model: model.id,
            messages,
            ...(sessionInit ? { sessionInit } : {}),
            ...(typeof options?.temperature === "number"
              ? { temperature: options.temperature }
              : {}),
            ...(typeof options?.maxTokens === "number"
              ? { maxOutputTokens: options.maxTokens }
              : {}),
          });

          const sendProviderTurn = async (messages: ProviderChatRequest["messages"]) => {
            const requestPayload = buildRequestPayload(messages);

            const response = await deps.helperClient.post<ProviderChatResponse>(
              current.baseUrl,
              "/v1/provider/chat",
              (() => {
                logProviderDebug("provider chat request", {
                  helperBaseUrl: current.baseUrl,
                  model: model.id,
                  request: requestPayload,
                });
                return requestPayload;
              })(),
              current.token,
              options?.signal,
            );
            logProviderDebug("provider chat response", {
              helperBaseUrl: current.baseUrl,
              model: model.id,
              response,
            });
            return response;
          };

          let response: ProviderChatResponse;
          response = await sendProviderTurn(toProviderMessages(context));
          logProviderResponseStage({
            stage: "initial_response",
            response,
            tools: context.tools,
          });

          const repairDecision = shouldRepairProviderResponse(response, context.tools);
          if (repairDecision.shouldRepair) {
            response = await sendProviderTurn([
              {
                role: "user",
                content: buildProtocolRepairPrompt({
                  rawOutput: repairDecision.rawOutput,
                  issues: repairDecision.issues,
                  tools: context.tools,
                }),
              },
            ]);
            logProviderResponseStage({
              stage: "repair_response",
              response,
              tools: context.tools,
            });

            const postRepairDecision = shouldRepairProviderResponse(response, context.tools);
            if (postRepairDecision.shouldRepair) {
              if (
                response.mode === "text" &&
                looksLikeProtocolRepairEcho(response.outputText)
              ) {
                const recoveredText = recoverPlainTextFromProtocolFailure(response.outputText);
                if (recoveredText.length > 0) {
                  response = {
                    ...response,
                    outputText: recoveredText,
                  };
                } else {
                response = await sendProviderTurn([
                  {
                    role: "user",
                    content: buildMinimalProtocolRepairPrompt(context.tools),
                  },
                ]);
                logProviderResponseStage({
                  stage: "minimal_repair_response",
                  response,
                  tools: context.tools,
                });

                const finalRepairDecision = shouldRepairProviderResponse(
                  response,
                  context.tools,
                );
                if (finalRepairDecision.shouldRepair) {
                  const recoveredText = recoverPlainTextFromProtocolFailure(
                    response.mode === "text" ? response.outputText : "",
                  );
                  if (response.mode === "text" && recoveredText.length > 0) {
                    response = {
                      ...response,
                      outputText: recoveredText,
                    };
                  } else {
                    throw new Error(
                      `Protocol repair failed: ${finalRepairDecision.issues.join(" ")}`,
                    );
                  }
                }
                }
              } else {
                const recoveredText = recoverPlainTextFromProtocolFailure(
                  response.mode === "text" ? response.outputText : "",
                );
                if (response.mode === "text" && recoveredText.length > 0) {
                  response = {
                    ...response,
                    outputText: recoveredText,
                  };
                } else {
                  throw new Error(
                    `Protocol repair failed: ${postRepairDecision.issues.join(" ")}`,
                  );
                }
              }
            }
          }

          if (response.mode === "text") {
            response = normalizeProtocolToolCallResponse(response);
          }

          if (response.mode === "text") {
            response = normalizeProtocolMessageText(response);
          }

          logProviderResponseStage({
            stage: "normalized_response",
            response,
            tools: context.tools,
          });

          if (typeof response.thinkingText === "string" && response.thinkingText.trim().length > 0) {
            emitThinking(response.thinkingText.trim());
          }

          if (response.mode === "text" && response.outputText.length > 0) {
            emitText(response.outputText);
          }

          if (response.mode !== "text") {
            emitToolCall(response);

            if (response.finishReason === "error") {
              output.stopReason = "error";
              output.errorMessage =
                response.outputText || "DeepSeek web provider returned an error";
              stream.push({ type: "error", reason: "error", error: output });
              stream.end();
              return;
            }

            output.stopReason = "toolUse";
            stream.push({
              type: "done",
              reason: "toolUse",
              message: output,
            });
            stream.end();
            return;
          }

          if (response.finishReason === "error") {
            output.stopReason = "error";
            output.errorMessage = response.outputText || "DeepSeek web provider returned an error";
            stream.push({ type: "error", reason: "error", error: output });
            stream.end();
            return;
          }

          output.stopReason = response.finishReason;
          stream.push({
            type: "done",
            reason: response.finishReason,
            message: output,
          });
          stream.end();
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = toErrorMessage(error);
          logProviderDebug("provider chat error", {
            model: model.id,
            error: output.errorMessage,
            aborted: options?.signal?.aborted === true,
          });
          stream.push({
            type: "error",
            reason: output.stopReason === "aborted" ? "aborted" : "error",
            error: output,
          });
          stream.end();
        }
      })();

      return stream;
      },
    });
  }
}
