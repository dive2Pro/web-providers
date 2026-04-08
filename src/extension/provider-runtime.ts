import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { ProviderChatRequest } from "../shared/contracts";

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

interface ProviderContext {
  systemPrompt?: string;
  messages: Array<UserMessage | AssistantMessage | ToolResultMessage>;
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

function toProviderMessages(context: ProviderContext): ProviderChatRequest["messages"] {
  const messages: ProviderChatRequest["messages"] = [];

  if (context.systemPrompt) {
    pushProviderMessage(messages, "system", context.systemPrompt);
  }

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

          const response = await deps.helperClient.post<{
            outputText: string;
            finishReason: "stop" | "length" | "error";
            modelLabel?: string;
          }>(
            current.baseUrl,
            "/v1/provider/chat",
            (() => {
              const requestPayload = {
              model: model.id,
              messages: toProviderMessages(context),
              ...(typeof options?.temperature === "number"
                ? { temperature: options.temperature }
                : {}),
              ...(typeof options?.maxTokens === "number"
                ? { maxOutputTokens: options.maxTokens }
                : {}),
              };
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

          if (response.outputText.length > 0) {
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
