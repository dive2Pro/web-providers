import { describe, expect, it } from "vitest";
import registerDeepSeekExtension from "../../.pi/extensions/deepseek-web/index";

type TextContent = { type: "text"; text: string };
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
  content: Array<TextContent | ToolCallContent>;
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

type Context = {
  systemPrompt?: string;
  messages: Array<UserMessage | AssistantMessage | ToolResultMessage>;
};

type StreamOptions = {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
};

type StreamEvent =
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

type AssistantMessageEventStreamLike = AsyncIterable<StreamEvent> & {
  result(): Promise<AssistantMessage>;
};

type ProviderModel = {
  id: string;
  api: string;
  provider: string;
};

type ProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: Array<{
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
  }>;
  streamSimple?: (
    model: ProviderModel,
    context: Context,
    options?: StreamOptions,
  ) => AssistantMessageEventStreamLike;
};

async function collectEventTypes(stream: AssistantMessageEventStreamLike) {
  const types: string[] = [];

  for await (const event of stream) {
    types.push(event.type);
  }

  return types;
}

describe("pi provider extension", () => {
  it("registers the deepseek-web provider and model", () => {
    const providers: Array<{ name: string; config: ProviderConfig }> = [];
    const events: string[] = [];

    registerDeepSeekExtension(
      {
        registerProvider(name, config) {
          providers.push({ name: String(name), config: config as ProviderConfig });
        },
        on(event, _handler) {
          events.push(String(event));
        },
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>() => ({ outputText: "ok", finishReason: "stop" } as T),
        },
        randomToken: () => "token-123",
        pickPort: async () => 4318,
      },
    );

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      name: "deepseek-web",
      config: {
        baseUrl: "http://127.0.0.1",
        apiKey: "deepseek-web-local",
        api: "deepseek-web-api",
        models: [
          {
            id: "deepseek-web-chat",
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
      },
    });
    expect(events).toEqual(["session_start", "session_shutdown"]);
  });

  it("starts the helper once, binds, and forwards provider chat as an assistant event stream", async () => {
    const calls: string[] = [];
    let config: ProviderConfig | undefined;

    registerDeepSeekExtension(
      {
        registerProvider(_name, providerConfig) {
          config = providerConfig as ProviderConfig;
        },
        on() {},
      },
      {
        spawnHelper: async ({ token, port }) => {
          calls.push(`spawn:${token}:${port}`);
          return {
            baseUrl: `http://127.0.0.1:${port}`,
            token,
            stop: async () => undefined,
          };
        },
        helperClient: {
          post: async <T>(
            baseUrl: string,
            path: string,
            body: Record<string, unknown>,
            token: string,
          ) => {
            calls.push(`post:${baseUrl}:${path}:${token}:${JSON.stringify(body)}`);

            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            return {
              outputText: "reply",
              finishReason: "stop",
              modelLabel: "DeepSeek Web",
            } as T;
          },
        },
        randomToken: () => "token-123",
        pickPort: async () => 4318,
      },
    );

    const stream = config?.streamSimple?.(
      {
        id: "deepseek-web-chat",
        api: "deepseek-web-api",
        provider: "deepseek-web",
      },
      {
        systemPrompt: "system prompt",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: new AbortController().signal,
        temperature: 0.3,
        maxTokens: 512,
      },
    );

    expect(stream).toBeDefined();

    const [result, eventTypes] = await Promise.all([
      stream?.result(),
      collectEventTypes(stream as AssistantMessageEventStreamLike),
    ]);

    expect(calls).toEqual([
      "spawn:token-123:4318",
      'post:http://127.0.0.1:4318:/v1/bind:token-123:{}',
      'post:http://127.0.0.1:4318:/v1/provider/chat:token-123:{"model":"deepseek-web-chat","messages":[{"role":"system","content":"system prompt"},{"role":"user","content":"hello"}],"temperature":0.3,"maxOutputTokens":512}',
    ]);
    expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(result).toMatchObject({
      role: "assistant",
      api: "deepseek-web-api",
      provider: "deepseek-web",
      model: "deepseek-web-chat",
      stopReason: "stop",
      content: [{ type: "text", text: "reply" }],
    });
  });

  it("stops the helper on session shutdown after startup", async () => {
    let config: ProviderConfig | undefined;
    let shutdownHandler: (() => Promise<void>) | undefined;
    const calls: string[] = [];

    registerDeepSeekExtension(
      {
        registerProvider(_name, providerConfig) {
          config = providerConfig as ProviderConfig;
        },
        on(event, handler) {
          if (event === "session_shutdown") {
            shutdownHandler = handler as () => Promise<void>;
          }
        },
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => {
            calls.push("stop");
          },
        }),
        helperClient: {
          post: async <T>() => ({ outputText: "ok", finishReason: "stop" } as T),
        },
        randomToken: () => "token-123",
        pickPort: async () => 4318,
      },
    );

    const stream = config?.streamSimple?.(
      {
        id: "deepseek-web-chat",
        api: "deepseek-web-api",
        provider: "deepseek-web",
      },
      {
        messages: [
          {
            role: "user",
            content: "hello",
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: new AbortController().signal,
      },
    );

    await stream?.result();
    await shutdownHandler?.();

    expect(calls).toEqual(["stop"]);
  });
});
