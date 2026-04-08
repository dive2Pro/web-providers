import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { ProviderChatRequest, ProviderChatResponse } from "../shared/contracts";

interface ManagedHelper {
  baseUrl: string;
  token: string;
  stop(): Promise<void>;
}

type TextContent = { type: "text"; text: string };
type ThinkingContent = { type: "thinking"; thinking: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
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
  pickPort(): Promise<number>;
}

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const PROVIDER_NAME = "deepseek-web";
const PROVIDER_API = "deepseek-web-api";
const PROVIDER_API_KEY = "deepseek-web-local";
const PROVIDER_BASE_URL = "http://127.0.0.1";
const MODEL_ID = "deepseek-web-chat";
const DEBUG_PROVIDER_REQUESTS = process.env.PI_DEEPSEEK_DEBUG === "1";
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
        `Arguments JSON schema: ${JSON.stringify(tool.inputSchema ?? {})}`,
      ]
        .filter((part) => part.length > 0)
        .join("\n"),
    ),
  ].join("\n\n");
}

function parseStrictProtocolEnvelope(text: string): {
  envelope: ProtocolEnvelope | null;
  protocolLike: boolean;
  error: string | null;
} {
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
  if (candidate.type === "message") {
    if (
      Object.keys(candidate).length !== 2 ||
      typeof candidate.content !== "string"
    ) {
      return {
        envelope: null,
        protocolLike: true,
        error: 'Message replies must match {"type":"message","content":"..."} exactly.',
      };
    }

    return {
      envelope: {
        type: "message",
        content: candidate.content,
      },
      protocolLike: true,
      error: null,
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
      return {
        envelope: null,
        protocolLike: true,
        error:
          'Tool calls must match {"type":"tool_call","name":"tool_name","arguments":{...}} exactly.',
      };
    }

    return {
      envelope: {
        type: "tool_call",
        name: candidate.name,
        arguments: candidate.arguments as Record<string, unknown>,
      },
      protocolLike: true,
      error: null,
    };
  }

  return {
    envelope: null,
    protocolLike,
    error: 'Reply "type" must be either "message" or "tool_call".',
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
    matchedTool.inputSchema,
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

      return `[Tool call ${part.name} ${JSON.stringify(part.arguments)}]`;
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

  return {
    prompt,
    fingerprint: createHash("sha256").update(prompt).digest("hex"),
  };
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

async function pickAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate helper port")));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
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
    pickPort: pickAvailablePort,
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
        const port = await deps.pickPort();
        const started = await deps.spawnHelper({ token, port });
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

  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: PROVIDER_BASE_URL,
    apiKey: PROVIDER_API_KEY,
    api: PROVIDER_API,
    models: [
      {
        id: MODEL_ID,
        name: "DeepSeek Web Chat",
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
            {},
            current.token,
            options?.signal,
          );

          const sessionInit = buildSessionInitPrompt(context);
          const sendProviderTurn = async (
            messages: ProviderChatRequest["messages"],
          ) => {
            const requestPayload = {
              model: model.id,
              messages,
              ...(sessionInit ? { sessionInit } : {}),
              ...(typeof options?.temperature === "number"
                ? { temperature: options.temperature }
                : {}),
              ...(typeof options?.maxTokens === "number"
                ? { maxOutputTokens: options.maxTokens }
                : {}),
            };

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

          let response = await sendProviderTurn(toProviderMessages(context));
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

            const postRepairDecision = shouldRepairProviderResponse(response, context.tools);
            if (postRepairDecision.shouldRepair) {
              throw new Error(
                `Protocol repair failed: ${postRepairDecision.issues.join(" ")}`,
              );
            }
          }

          if (response.mode === "text" && response.outputText.length > 0) {
            output.content.push({ type: "text", text: "" });
            const contentIndex = output.content.length - 1;
            stream.push({ type: "text_start", contentIndex, partial: output });

            const textPart = output.content[contentIndex];
            if (textPart?.type === "text") {
              textPart.text += response.outputText;
            }

            stream.push({
              type: "text_delta",
              contentIndex,
              delta: response.outputText,
              partial: output,
            });
            stream.push({
              type: "text_end",
              contentIndex,
              content: response.outputText,
              partial: output,
            });
          }

          if (response.mode !== "text") {
            const validatedToolCall = parseValidatedToolCall(response.toolCall);
            const toolCallId = `deepseek-web-${output.content.length}`;

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
