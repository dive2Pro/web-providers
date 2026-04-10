import { describe, expect, it } from "vitest";
import registerDeepSeekExtension from "../../.pi/extensions/deepseek-web/index";

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

type Context = {
  systemPrompt?: string;
  messages: Array<UserMessage | AssistantMessage | ToolResultMessage>;
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
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
  it("registers deepseek-web and qwen-web from one runtime", () => {
    const providers: Array<{ name: string; config: ProviderConfig }> = [];

    registerDeepSeekExtension(
      {
        registerProvider(name, config) {
          providers.push({ name: String(name), config: config as ProviderConfig });
        },
        on() {},
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>() =>
            ({ mode: "text", outputText: "ok", finishReason: "stop" } as T),
        },
        randomToken: () => "token-123",
      },
    );

    expect(providers.map((entry) => entry.name)).toEqual([
      "deepseek-web",
      "qwen-web",
    ]);
  });

  it("sends provider-aware helper requests for qwen-web", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    let qwenConfig: ProviderConfig | undefined;

    registerDeepSeekExtension(
      {
        registerProvider(name, config) {
          if (name === "qwen-web") {
            qwenConfig = config as ProviderConfig;
          }
        },
        on() {},
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>(
            _baseUrl: string,
            path: string,
            body: Record<string, unknown>,
          ) => {
            calls.push({ path, body });
            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            return {
              mode: "text",
              outputText: "qwen reply",
              finishReason: "stop",
            } as T;
          },
        },
        randomToken: () => "token-123",
      },
    );

    const stream = qwenConfig?.streamSimple?.(
      {
        id: "qwen-web-chat",
        api: "qwen-web-api",
        provider: "qwen-web",
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
    );

    await stream?.result();

    const bindCall = calls.find((call) => call.path === "/v1/bind");
    const chatCall = calls.find((call) => call.path === "/v1/provider/chat");
    expect(bindCall?.body).toEqual({ provider: "qwen-web" });
    expect(chatCall?.body).toMatchObject({
      provider: "qwen-web",
      model: "qwen-web-chat",
    });
  });

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
          post: async <T>() =>
            ({ mode: "text", outputText: "ok", finishReason: "stop" } as T),
        },
        randomToken: () => "token-123",
      },
    );

    expect(providers).toHaveLength(2);
    const deepseekProvider = providers.find((provider) => provider.name === "deepseek-web");
    expect(deepseekProvider).toBeDefined();
    expect(deepseekProvider).toMatchObject({
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
              mode: "text",
              outputText: "reply",
              finishReason: "stop",
              modelLabel: "DeepSeek Web",
            } as T;
          },
        },
        randomToken: () => "token-123",
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

    expect(calls[0]).toBe("spawn:token-123:4318");
    expect(calls[1]).toBe(
      'post:http://127.0.0.1:4318:/v1/bind:token-123:{"provider":"deepseek-web"}',
    );
    expect(calls[2]).toContain('post:http://127.0.0.1:4318:/v1/provider/chat:token-123:');
    expect(calls[2]).toContain('"model":"deepseek-web-chat"');
    expect(calls[2]).toContain('"messages":[{"role":"user","content":"hello"}]');
    expect(calls[2]).toContain('"temperature":0.3');
    expect(calls[2]).toContain('"maxOutputTokens":512');
    expect(calls[2]).toContain('\\"type\\":\\"message\\"');
    expect(calls[2]).toContain('system prompt');
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

  it("emits thinking and final text as separate text blocks", async () => {
    let config: ProviderConfig | undefined;

    registerDeepSeekExtension(
      {
        registerProvider(_name, providerConfig) {
          config = providerConfig as ProviderConfig;
        },
        on() {},
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>(_baseUrl: string, path: string) => {
            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            return {
              mode: "text",
              thinkingText: "first think",
              outputText: "then answer",
              finishReason: "stop",
              modelLabel: "DeepSeek Web",
            } as T;
          },
        },
        randomToken: () => "token-123",
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

    const [result, eventTypes] = await Promise.all([
      stream?.result(),
      collectEventTypes(stream as AssistantMessageEventStreamLike),
    ]);

    expect(eventTypes).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(result).toMatchObject({
      stopReason: "stop",
    });
    const visibleThinkingBlocks = result?.content.filter(
      (part): part is ThinkingContent => part.type === "thinking" && part.thinking.trim().length > 0,
    );
    expect(visibleThinkingBlocks).toEqual([]);
    expect(result?.content.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: "then answer" },
    ]);
  });


  it("injects fallback instructions and emits pi tool-call events for structured tool turns", async () => {
    const calls: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    let config: ProviderConfig | undefined;

    registerDeepSeekExtension(
      {
        registerProvider(_name, providerConfig) {
          config = providerConfig as ProviderConfig;
        },
        on() {},
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>(
            _baseUrl: string,
            path: string,
            body: Record<string, unknown>,
          ) => {
            calls.push({ path, body });

            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            return {
              mode: "json_fallback",
              toolCall: {
                name: "bash",
                argumentsJson: "{\"cmd\":\"ls -la\"}",
              },
              finishReason: "stop",
              modelLabel: "DeepSeek Web",
            } as T;
          },
        },
        randomToken: () => "token-123",
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
            content: "inspect the project",
            timestamp: Date.now(),
          },
        ],
        tools: [
          {
            name: "bash",
            description: "Execute bash commands",
            inputSchema: {
              type: "object",
              properties: {
                cmd: { type: "string" },
              },
              required: ["cmd"],
            },
          },
        ],
      },
      {
        signal: new AbortController().signal,
      },
    );

    const events: StreamEvent[] = [];
    for await (const event of stream as AssistantMessageEventStreamLike) {
      events.push(event);
    }

    const providerChatCall = calls.find((call) => call.path === "/v1/provider/chat");
    const providerMessages = Array.isArray(providerChatCall?.body.messages)
      ? (providerChatCall.body.messages as Array<{ content?: string }>)
      : [];

    expect(providerMessages.at(-1)?.content).toBe("inspect the project");
    expect(providerChatCall?.body.sessionInit).toMatchObject({
      prompt: expect.stringContaining('"type":"message"'),
      fingerprint: expect.any(String),
      sessionKey: expect.any(String),
    });
    const providerSessionInit =
      (providerChatCall?.body as { sessionInit?: { prompt?: string } } | undefined)?.sessionInit;
    expect(String(providerSessionInit?.prompt ?? "")).toContain('"type":"tool_call"');
    expect(String(providerSessionInit?.prompt ?? "")).toContain("Tool name: bash");
    expect(String(providerSessionInit?.prompt ?? "")).toContain("\"cmd\"");
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(events).toContainEqual({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: {
        type: "toolCall",
        id: "deepseek-web-0",
        name: "bash",
        arguments: { cmd: "ls -la" },
      },
      partial: expect.objectContaining({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "deepseek-web-0",
            name: "bash",
            arguments: { cmd: "ls -la" },
          },
        ],
      }),
    });
  });

  it("converts a text-mode protocol tool_call envelope into pi tool-call events", async () => {
    let config: ProviderConfig | undefined;

    registerDeepSeekExtension(
      {
        registerProvider(_name, providerConfig) {
          config = providerConfig as ProviderConfig;
        },
        on() {},
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>(_baseUrl: string, path: string) => {
            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            return {
              mode: "text",
              outputText:
                "{\"type\":\"tool_call\",\"name\":\"bash\",\"arguments\":{\"cmd\":\"ls -la /Users/yc/ai/web-providers\"}}",
              finishReason: "stop",
              modelLabel: "Qwen Web",
            } as T;
          },
        },
        randomToken: () => "token-123",
      },
    );

    const stream = config?.streamSimple?.(
      {
        id: "qwen-web-chat",
        api: "qwen-web-api",
        provider: "qwen-web",
      },
      {
        messages: [
          {
            role: "user",
            content: "inspect this project",
            timestamp: Date.now(),
          },
        ],
        tools: [
          {
            name: "bash",
            description: "Execute bash commands",
            inputSchema: {
              type: "object",
              properties: {
                cmd: { type: "string" },
              },
              required: ["cmd"],
            },
          },
        ],
      },
      {
        signal: new AbortController().signal,
      },
    );

    const events: StreamEvent[] = [];
    for await (const event of stream as AssistantMessageEventStreamLike) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(events).toContainEqual({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: {
        type: "toolCall",
        id: "qwen-web-0",
        name: "bash",
        arguments: { cmd: "ls -la /Users/yc/ai/web-providers" },
      },
      partial: expect.objectContaining({
        stopReason: "toolUse",
      }),
    });
  });

  it("converts a text-mode protocol tool_call envelope even when the provider reports finishReason length", async () => {
    let config: ProviderConfig | undefined;

    registerDeepSeekExtension(
      {
        registerProvider(_name, providerConfig) {
          config = providerConfig as ProviderConfig;
        },
        on() {},
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>(_baseUrl: string, path: string) => {
            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            return {
              mode: "text",
              outputText:
                "{\"type\":\"tool_call\",\"name\":\"bash\",\"arguments\":{\"cmd\":\"pwd\"}}",
              finishReason: "length",
              modelLabel: "Qwen Web",
            } as T;
          },
        },
        randomToken: () => "token-123",
      },
    );

    const stream = config?.streamSimple?.(
      {
        id: "qwen-web-chat",
        api: "qwen-web-api",
        provider: "qwen-web",
      },
      {
        messages: [
          {
            role: "user",
            content: "show cwd",
            timestamp: Date.now(),
          },
        ],
        tools: [
          {
            name: "bash",
            inputSchema: {
              type: "object",
              properties: {
                cmd: { type: "string" },
              },
              required: ["cmd"],
            },
          },
        ],
      },
    );

    const events: StreamEvent[] = [];
    for await (const event of stream as AssistantMessageEventStreamLike) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "toolcall_end",
        toolCall: expect.objectContaining({
          name: "bash",
          arguments: { cmd: "pwd" },
        }),
      }),
    );
  });

  it("repairs malformed tool-call arguments against the active tool schema before emitting pi tool events", async () => {
    const calls: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    let config: ProviderConfig | undefined;
    let providerChatCount = 0;

    registerDeepSeekExtension(
      {
        registerProvider(_name, providerConfig) {
          config = providerConfig as ProviderConfig;
        },
        on() {},
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>(
            _baseUrl: string,
            path: string,
            body: Record<string, unknown>,
          ) => {
            calls.push({ path, body });

            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            providerChatCount += 1;
            if (providerChatCount === 1) {
              return {
                mode: "json_fallback",
                toolCall: {
                  name: "bash",
                  argumentsJson:
                    "{\"command\":\"ls -la /Users/yc/code/web-providers/src\",\"description\":\"List src directory structure\"}",
                },
                finishReason: "stop",
                modelLabel: "DeepSeek Web",
                outputText:
                  "{\"type\":\"tool_call\",\"name\":\"bash\",\"arguments\":{\"command\":\"ls -la /Users/yc/code/web-providers/src\",\"description\":\"List src directory structure\"}}",
              } as T;
            }

            return {
              mode: "json_fallback",
              toolCall: {
                name: "bash",
                argumentsJson: "{\"cmd\":\"ls -la /Users/yc/code/web-providers/src\"}",
              },
              finishReason: "stop",
              modelLabel: "DeepSeek Web",
              outputText:
                "{\"type\":\"tool_call\",\"name\":\"bash\",\"arguments\":{\"cmd\":\"ls -la /Users/yc/code/web-providers/src\"}}",
            } as T;
          },
        },
        randomToken: () => "token-123",
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
            content: "inspect src",
            timestamp: Date.now(),
          },
        ],
        tools: [
          {
            name: "bash",
            description: "Execute bash commands",
            inputSchema: {
              type: "object",
              properties: {
                cmd: { type: "string" },
              },
              required: ["cmd"],
              additionalProperties: false,
            },
          },
        ],
      },
      {
        signal: new AbortController().signal,
      },
    );

    const events: StreamEvent[] = [];
    for await (const event of stream as AssistantMessageEventStreamLike) {
      events.push(event);
    }

    const providerCalls = calls.filter((call) => call.path === "/v1/provider/chat");
    expect(providerCalls).toHaveLength(2);
    const repairMessages =
      (providerCalls[1]?.body as { messages?: Array<{ content?: string }> } | undefined)?.messages;
    expect(String(repairMessages?.[0]?.content ?? "")).toContain(
      "The previous reply violated the required JSON response protocol",
    );
    expect(String(repairMessages?.[0]?.content ?? "")).toContain(
      "\"cmd\"",
    );
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(events).toContainEqual({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: {
        type: "toolCall",
        id: "deepseek-web-0",
        name: "bash",
        arguments: { cmd: "ls -la /Users/yc/code/web-providers/src" },
      },
      partial: expect.objectContaining({
        stopReason: "toolUse",
      }),
    });
  });

  it("repairs malformed multi-object protocol text into a single message envelope", async () => {
    const calls: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    let config: ProviderConfig | undefined;
    let providerChatCount = 0;

    registerDeepSeekExtension(
      {
        registerProvider(_name, providerConfig) {
          config = providerConfig as ProviderConfig;
        },
        on() {},
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>(
            _baseUrl: string,
            path: string,
            body: Record<string, unknown>,
          ) => {
            calls.push({ path, body });

            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            providerChatCount += 1;
            if (providerChatCount === 1) {
              return {
                mode: "text",
                outputText:
                  '{"type":"tool_call","name":"read","arguments":{"path":"/tmp/a"}}~~\n{"type":"message","content":"hello"}',
                finishReason: "stop",
                modelLabel: "DeepSeek Web",
              } as T;
            }

            return {
              mode: "text",
              outputText: "hello",
              finishReason: "stop",
              modelLabel: "DeepSeek Web",
            } as T;
          },
        },
        randomToken: () => "token-123",
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
            content: "say hello",
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: new AbortController().signal,
      },
    );

    const [result, eventTypes] = await Promise.all([
      stream?.result(),
      collectEventTypes(stream as AssistantMessageEventStreamLike),
    ]);

    const providerCalls = calls.filter((call) => call.path === "/v1/provider/chat");
    expect(providerCalls).toHaveLength(1);
    expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("salvages the last valid message object when repair output contains extra protocol text", async () => {
    let config: ProviderConfig | undefined;
    let providerChatCount = 0;

    registerDeepSeekExtension(
      {
        registerProvider(_name, providerConfig) {
          config = providerConfig as ProviderConfig;
        },
        on() {},
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>(_baseUrl: string, path: string) => {
            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            providerChatCount += 1;
            if (providerChatCount === 1) {
              return {
                mode: "text",
                outputText: "{",
                finishReason: "stop",
                modelLabel: "DeepSeek Web",
              } as T;
            }

            return {
              mode: "text",
              outputText: [
                "The previous reply violated the required JSON response protocol.",
                "Return exactly one JSON object and nothing else.",
                "",
                '{"type":"message","content":"I\'m ready to coordinate."}',
              ].join("\n"),
              finishReason: "stop",
              modelLabel: "DeepSeek Web",
            } as T;
          },
        },
        randomToken: () => "token-123",
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
            content: "hey",
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: new AbortController().signal,
      },
    );

    const result = await stream?.result();

    expect(providerChatCount).toBe(2);
    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "I'm ready to coordinate." }],
    });
  });

  it("retries with a minimal repair prompt when the model echoes the repair instructions", async () => {
    const calls: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    let config: ProviderConfig | undefined;
    let providerChatCount = 0;

    registerDeepSeekExtension(
      {
        registerProvider(_name, providerConfig) {
          config = providerConfig as ProviderConfig;
        },
        on() {},
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>(
            _baseUrl: string,
            path: string,
            body: Record<string, unknown>,
          ) => {
            calls.push({ path, body });

            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            providerChatCount += 1;
            if (providerChatCount === 1) {
              return {
                mode: "text",
                outputText: "{",
                finishReason: "stop",
                modelLabel: "DeepSeek Web",
              } as T;
            }

            if (providerChatCount === 2) {
              return {
                mode: "text",
                outputText: [
                  "The previous reply violated the required JSON response protocol.",
                  "Return exactly one JSON object and nothing else.",
                  'For normal replies use: {"type":"message","content":"your response text"}',
                ].join("\n"),
                finishReason: "stop",
                modelLabel: "DeepSeek Web",
              } as T;
            }

            return {
              mode: "text",
              outputText: '{"type":"message","content":"Recovered on minimal repair."}',
              finishReason: "stop",
              modelLabel: "DeepSeek Web",
            } as T;
          },
        },
        randomToken: () => "token-123",
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
            content: "hey",
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: new AbortController().signal,
      },
    );

    const result = await stream?.result();

    const providerCalls = calls.filter((call) => call.path === "/v1/provider/chat");
    expect(providerCalls).toHaveLength(3);
    const minimalRepairMessage =
      (providerCalls[2]?.body as { messages?: Array<{ content?: string }> } | undefined)?.messages?.[0]
        ?.content ?? "";
    expect(minimalRepairMessage).toContain("Return exactly one JSON object and nothing else.");
    expect(minimalRepairMessage).not.toContain("Previous invalid reply:");
    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "Recovered on minimal repair." }],
    });
  });

  it("falls back to recovered plain text when repair still returns boilerplate plus a normal answer", async () => {
    let config: ProviderConfig | undefined;
    let providerChatCount = 0;

    registerDeepSeekExtension(
      {
        registerProvider(_name, providerConfig) {
          config = providerConfig as ProviderConfig;
        },
        on() {},
      },
      {
        spawnHelper: async () => ({
          baseUrl: "http://127.0.0.1:4318",
          token: "token-123",
          stop: async () => undefined,
        }),
        helperClient: {
          post: async <T>(_baseUrl: string, path: string) => {
            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            providerChatCount += 1;
            if (providerChatCount === 1) {
              return {
                mode: "text",
                outputText: "{",
                finishReason: "stop",
                modelLabel: "DeepSeek Web",
              } as T;
            }

            return {
              mode: "text",
              outputText: [
                "The previous reply violated the required JSON response protocol.",
                "Return exactly one JSON object and nothing else.",
                'For normal replies use: {"type":"message","content":"your response text"}',
                "",
                "你好，我在。",
              ].join("\n"),
              finishReason: "stop",
              modelLabel: "DeepSeek Web",
            } as T;
          },
        },
        randomToken: () => "token-123",
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
            content: "hey",
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: new AbortController().signal,
      },
    );

    const result = await stream?.result();

    expect(providerChatCount).toBe(2);
    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "你好，我在。" }],
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
          post: async <T>() =>
            ({ mode: "text", outputText: "ok", finishReason: "stop" } as T),
        },
        randomToken: () => "token-123",
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

  it("reuses one helper instance across deepseek and qwen streams", async () => {
    const calls: string[] = [];
    const configs = new Map<string, ProviderConfig>();

    registerDeepSeekExtension(
      {
        registerProvider(name, config) {
          configs.set(String(name), config as ProviderConfig);
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
            _baseUrl: string,
            path: string,
            body: Record<string, unknown>,
          ) => {
            calls.push(`${path}:${JSON.stringify(body)}`);
            if (path === "/v1/bind") {
              return { ok: true } as T;
            }

            return {
              mode: "text",
              outputText: "ok",
              finishReason: "stop",
            } as T;
          },
        },
        randomToken: () => "token-123",
      },
    );

    await configs
      .get("deepseek-web")
      ?.streamSimple?.(
        {
          id: "deepseek-web-chat",
          api: "deepseek-web-api",
          provider: "deepseek-web",
        },
        {
          messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
        },
      )
      .result();

    await configs
      .get("qwen-web")
      ?.streamSimple?.(
        {
          id: "qwen-web-chat",
          api: "qwen-web-api",
          provider: "qwen-web",
        },
        {
          messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
        },
      )
      .result();

    expect(calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
    expect(calls.some((call) => call.includes('"provider":"deepseek-web"'))).toBe(true);
    expect(calls.some((call) => call.includes('"provider":"qwen-web"'))).toBe(true);
  });
});
