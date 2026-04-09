import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  classifyCompletionTurn,
  INJECTED_BRIDGE_SOURCE,
} from "../../src/helper/browser/deepseek-page-bridge";

class FakeEvent {
  constructor(
    public type: string,
    public options?: Record<string, unknown>,
  ) {}
}

class FakeElement {
  public className = "";
  public parentElement: FakeElement | null = null;
  public textContent = "";
  public clicked = 0;
  private readonly attributes = new Map<string, string>();

  constructor(init?: { className?: string; attributes?: Record<string, string> }) {
    if (init?.className) {
      this.className = init.className;
    }

    if (init?.attributes) {
      for (const [key, value] of Object.entries(init.attributes)) {
        this.attributes.set(key, value);
      }
    }
  }

  focus() {}

  click() {
    this.clicked += 1;
  }

  dispatchEvent(_event: FakeEvent) {
    return true;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  querySelector(_selector: string): FakeElement | null {
    return null;
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }

  closest(_selector: string) {
    return null as FakeElement | null;
  }
}

class FakeTextarea extends FakeElement {
  declare value: string;
  private nativeValue = "";

  constructor(private readonly sendButton: FakeElement) {
    super();
    Object.defineProperty(this, "value", {
      configurable: true,
      writable: true,
      value: "",
    });
  }

  syncReactValue(nextValue: string) {
    this.nativeValue = nextValue;
    Object.defineProperty(this, "value", {
      configurable: true,
      writable: true,
      value: nextValue,
    });

    if (nextValue.length > 0) {
      this.sendButton.setAttribute("aria-disabled", "false");
      this.sendButton.className = this.sendButton.className.replace(
        " ds-icon-button--disabled",
        "",
      );
      return;
    }

    this.sendButton.setAttribute("aria-disabled", "true");
    if (!this.sendButton.className.includes("ds-icon-button--disabled")) {
      this.sendButton.className += " ds-icon-button--disabled";
    }
  }

  getNativeValue() {
    return this.nativeValue;
  }
}

Object.defineProperty(FakeTextarea.prototype, "value", {
  configurable: true,
  get(this: FakeTextarea) {
    return this.getNativeValue();
  },
  set(this: FakeTextarea, nextValue: string) {
    this.syncReactValue(String(nextValue));
  },
});

function createBridgeTestContext(options?: {
  latestAssistantText?: string;
  assistantVisible?: boolean;
}) {
  const unrelatedPageIcon = new FakeElement({
    className: "_7d1f5e2 ds-icon-button ds-icon-button--l ds-icon-button--sizing-icon",
    attributes: {
      role: "button",
      "aria-disabled": "false",
    },
  });
  const composerToggle = new FakeElement({
    attributes: {
      role: "button",
      "aria-disabled": "false",
    },
  });
  const composerAttach = new FakeElement({
    className: "f02f0e25 ds-icon-button ds-icon-button--l ds-icon-button--sizing-container",
    attributes: {
      role: "button",
      "aria-disabled": "false",
    },
  });
  const composerSend = new FakeElement({
    className:
      "_52c986b ds-icon-button ds-icon-button--l ds-icon-button--sizing-container ds-icon-button--disabled",
    attributes: {
      role: "button",
      "aria-disabled": "true",
    },
  });
  const composerRoot = new FakeElement();
  const composerInputWrapper = new FakeElement();
  const textarea = new FakeTextarea(composerSend);
  const shouldCreateAssistant = options?.assistantVisible === true ||
    typeof options?.latestAssistantText === "string";
  const latestAssistantMarkdown = shouldCreateAssistant
    ? new FakeElement()
    : null;
  const latestAssistantMessage = shouldCreateAssistant
    ? new FakeElement()
    : null;

  if (latestAssistantMarkdown && latestAssistantMessage) {
    latestAssistantMarkdown.textContent = options?.latestAssistantText ?? "";
    latestAssistantMessage.textContent = options?.latestAssistantText ?? "";
    latestAssistantMessage.querySelector = (selector: string) => {
      if (selector === ".ds-markdown") {
        return latestAssistantMarkdown;
      }

      return null;
    };
  }

  composerRoot.querySelectorAll = (selector: string) => {
    if (
      selector === "div[role='button'], button" ||
      selector === "button, div[role='button']"
    ) {
      return [composerToggle, composerAttach, composerSend];
    }

    return [];
  };

  textarea.closest = (selector: string) => {
    if (selector === ".aaff8b8f") {
      return composerRoot;
    }

    return null;
  };
  textarea.parentElement = composerInputWrapper;
  composerInputWrapper.parentElement = composerRoot;

  const document = {
    body: {
      innerText: "",
    },
    querySelector(selector: string) {
      if (selector === "textarea") {
        return textarea;
      }

      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "div[role='button']") {
        return [unrelatedPageIcon, composerToggle, composerAttach, composerSend];
      }

      if (selector === ".ds-message") {
        return latestAssistantMessage ? [latestAssistantMessage] : [];
      }

      if (selector === ".ds-markdown, .markdown, [class*='markdown']") {
        return latestAssistantMarkdown ? [latestAssistantMarkdown] : [];
      }

      return [];
    },
  };

  class FakeXmlHttpRequest {
    addEventListener(_type?: string, _handler?: () => void) {}

    open(_method?: string, _url?: string) {
      return undefined;
    }

    send() {
      return undefined;
    }
  }

  const windowObject: Record<string, unknown> = {
    location: {
      href: "https://chat.deepseek.com/",
    },
  };

  const context: Record<string, any> = {
    window: windowObject,
    document,
    XMLHttpRequest: FakeXmlHttpRequest,
    HTMLElement: FakeElement,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    URL,
    setTimeout,
    clearTimeout,
    console,
  };

  windowObject.window = windowObject;
  windowObject.document = document;
  windowObject.XMLHttpRequest = FakeXmlHttpRequest;
  windowObject.HTMLElement = FakeElement;
  windowObject.Event = FakeEvent;
  windowObject.KeyboardEvent = FakeEvent;
  windowObject.URL = URL;
  windowObject.setTimeout = setTimeout;
  windowObject.clearTimeout = clearTimeout;
  windowObject.console = console;

  return {
    context,
    textarea,
    unrelatedPageIcon,
    composerSend,
    latestAssistantMarkdown,
    latestAssistantMessage,
  };
}

describe("deepseek page bridge", () => {
  it("classifies native tool-call payloads from captured SSE records", () => {
    expect(
      classifyCompletionTurn({
        reply: "",
        rawEvents: [
          {
            eventType: null,
            parsed: {
              v: {
                response: {
                  tool_calls: [
                    {
                      function: {
                        name: "read",
                        arguments: "{\"path\":\"src/app.ts\"}",
                      },
                    },
                  ],
                },
              },
            },
            at: Date.now(),
          },
        ],
      }),
    ).toEqual({
      mode: "native_tool_call",
      toolCall: {
        name: "read",
        argumentsJson: "{\"path\":\"src/app.ts\"}",
      },
    });
  });

  it("classifies strict JSON fallback text when native payloads are absent", () => {
    expect(
      classifyCompletionTurn({
        reply: "{\"type\":\"tool_call\",\"name\":\"read\",\"arguments\":{\"path\":\"src/app.ts\"}}",
        rawEvents: [],
      }),
    ).toEqual({
      mode: "json_fallback",
      toolCall: {
        name: "read",
        argumentsJson: "{\"path\":\"src/app.ts\"}",
      },
      outputText: "{\"type\":\"tool_call\",\"name\":\"read\",\"arguments\":{\"path\":\"src/app.ts\"}}",
    });
  });

  it("classifies strict JSON message envelopes as assistant text", () => {
    expect(
      classifyCompletionTurn({
        reply: "{\"type\":\"message\",\"content\":\"hello from deepseek\"}",
        rawEvents: [],
      }),
    ).toEqual({
      mode: "text",
      outputText: "hello from deepseek",
    });
  });

  it("keeps prose-wrapped JSON as plain text", () => {
    expect(
      classifyCompletionTurn({
        reply: "I will call a tool now\n{\"type\":\"tool_call\"}",
        rawEvents: [],
      }),
    ).toEqual({
      mode: "text",
      outputText: "I will call a tool now\n{\"type\":\"tool_call\"}",
    });
  });

  it("classifies fenced JSON fallback tool calls even when the assistant adds a short preface", () => {
    const reply = [
      "I will inspect the project first.",
      "",
      "```json",
      '{"type":"tool_call","name":"bash","arguments":{"cmd":"ls -la"}}',
      "```",
    ].join("\n");

    expect(
      classifyCompletionTurn({
        reply,
        rawEvents: [],
      }),
    ).toEqual({
      mode: "json_fallback",
      toolCall: {
        name: "bash",
        argumentsJson: "{\"cmd\":\"ls -la\"}",
      },
      outputText: reply,
    });
  });

  it("clicks the composer send button instead of the first page icon button", async () => {
    const { context, textarea, unrelatedPageIcon, composerSend } =
      createBridgeTestContext();

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();

    const result = await bridge.submitPrompt({ prompt: "hello" });

    expect(result).toEqual({ ok: true });
    expect(textarea.value).toBe("hello");
    expect(composerSend.clicked).toBe(1);
    expect(unrelatedPageIcon.clicked).toBe(0);
  });

  it("uses the native textarea setter so React enables the send button", async () => {
    const { context, composerSend } = createBridgeTestContext();

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();
    expect(composerSend.getAttribute("aria-disabled")).toBe("true");

    const result = await bridge.submitPrompt({ prompt: "hello" });

    expect(result).toEqual({ ok: true });
    expect(composerSend.getAttribute("aria-disabled")).toBe("false");
  });

  it("falls back to keyboard submission when clicking send does not start generation", async () => {
    const { context, composerSend, textarea } = createBridgeTestContext();
    let keyboardSubmitCount = 0;

    class FakeStreamingXmlHttpRequest {
      public readyState = 0;
      public responseText = "";
      private readonly listeners = new Map<string, Array<() => void>>();

      addEventListener(type: string, handler: () => void) {
        const current = this.listeners.get(type) ?? [];
        current.push(handler);
        this.listeners.set(type, current);
      }

      open(_method?: string, _url?: string) {
        return undefined;
      }

      send() {
        setTimeout(() => {
          this.pushChunk(
            [
              "event: ready",
              "data: {\"request_message_id\":1,\"response_message_id\":2,\"model_type\":\"default\"}",
              "",
              "data: {\"v\":{\"response\":{\"message_id\":2,\"status\":\"WIP\",\"fragments\":[{\"type\":\"RESPONSE\",\"content\":\"fallback worked\"}]}}}",
              "",
              "data: {\"p\":\"response/status\",\"o\":\"SET\",\"v\":\"FINISHED\"}",
              "",
              "event: close",
              "data: {\"click_behavior\":\"none\",\"auto_resume\":false}",
              "",
            ].join("\n"),
            4,
          );
        }, 50);
        return undefined;
      }

      private pushChunk(chunk: string, readyState: number) {
        this.responseText += chunk;
        this.readyState = readyState;
        for (const handler of this.listeners.get("readystatechange") ?? []) {
          handler();
        }
      }
    }

    context.XMLHttpRequest = FakeStreamingXmlHttpRequest;
    (context.window as Record<string, unknown>).XMLHttpRequest = FakeStreamingXmlHttpRequest;

    composerSend.click = () => {
      composerSend.clicked += 1;
    };
    textarea.dispatchEvent = (event: FakeEvent) => {
      if (event.type === "keydown" && event.options?.key === "Enter") {
        keyboardSubmitCount += 1;
        const xhr = new FakeStreamingXmlHttpRequest();
        xhr.open("POST", "/api/v0/chat/completion");
        xhr.send();
      }

      return true;
    };

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();

    const result = await bridge.sendPrompt({ prompt: "hello", timeoutMs: 3_000 });

    expect(result).toEqual({
      ok: true,
      turn: {
        mode: "text",
        outputText: "fallback worked",
      },
      meta: {
        source: "bridge_stream",
        completionObserved: true,
      },
    });
    expect(composerSend.clicked).toBe(1);
    expect(keyboardSubmitCount).toBe(1);
  });

  it("does not return the previous assistant reply when no fresh reply arrives", async () => {
    const { context } = createBridgeTestContext({
      latestAssistantText: "previous assistant reply",
    });

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();

    const result = await bridge.sendPrompt({ prompt: "hello", timeoutMs: 10 });

    expect(result).toEqual({
      ok: false,
      error: "AUTOMATION_DESYNC",
      message: "Prompt submission did not start a DeepSeek response",
    });
  });

  it("does not return text from DOM alone when completion events never arrive", async () => {
    const {
      context,
      latestAssistantMarkdown,
      latestAssistantMessage,
    } = createBridgeTestContext({
      assistantVisible: true,
    });

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();

    setTimeout(() => {
      if (latestAssistantMarkdown) {
        latestAssistantMarkdown.textContent = "I'm";
      }
      if (latestAssistantMessage) {
        latestAssistantMessage.textContent = "I'm";
      }
    }, 100);

    setTimeout(() => {
      if (latestAssistantMarkdown) {
        latestAssistantMarkdown.textContent = "I'm here to help with your task.";
      }
      if (latestAssistantMessage) {
        latestAssistantMessage.textContent = "I'm here to help with your task.";
      }
    }, 2_000);

    const result = await bridge.sendPrompt({ prompt: "hello", timeoutMs: 4_000 });

    expect(result).toEqual({
      ok: false,
      error: "TIMEOUT",
      message: "The page did not finish streaming in time",
    });
  });

  it("reconstructs streamed SSE reply chunks when continuation data blocks omit patch metadata", async () => {
    const { context, composerSend } = createBridgeTestContext();

    class FakeStreamingXmlHttpRequest {
      public readyState = 0;
      public responseText = "";
      private readonly listeners = new Map<string, Array<() => void>>();

      addEventListener(type: string, handler: () => void) {
        const current = this.listeners.get(type) ?? [];
        current.push(handler);
        this.listeners.set(type, current);
      }

      open(_method?: string, _url?: string) {
        return undefined;
      }

      send() {
        setTimeout(() => {
          this.pushChunk(
            [
              "event: ready",
              "data: {\"request_message_id\":1,\"response_message_id\":2,\"model_type\":\"default\"}",
              "",
              "data: {\"v\":{\"response\":{\"message_id\":2,\"status\":\"WIP\",\"fragments\":[{\"type\":\"RESPONSE\",\"content\":\"I'm\"}]}}}",
              "",
              "data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\" here\"}",
              "",
              "data: {\"v\":\" to help\"}",
              "",
              "data: {\"v\":\" with your task.\"}",
              "",
              "data: {\"p\":\"response/status\",\"o\":\"SET\",\"v\":\"FINISHED\"}",
              "",
              "event: close",
              "data: {\"click_behavior\":\"none\",\"auto_resume\":false}",
              "",
            ].join("\n"),
            4,
          );
        }, 50);
        return undefined;
      }

      private pushChunk(chunk: string, readyState: number) {
        this.responseText += chunk;
        this.readyState = readyState;
        for (const handler of this.listeners.get("readystatechange") ?? []) {
          handler();
        }
      }
    }

    context.XMLHttpRequest = FakeStreamingXmlHttpRequest;
    (context.window as Record<string, unknown>).XMLHttpRequest = FakeStreamingXmlHttpRequest;

    composerSend.click = () => {
      const xhr = new FakeStreamingXmlHttpRequest();
      xhr.open("POST", "/api/v0/chat/completion");
      xhr.send();
      composerSend.clicked += 1;
    };

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();

    const result = await bridge.sendPrompt({ prompt: "hello", timeoutMs: 2_000 });

    expect(result).toEqual({
      ok: true,
      turn: {
        mode: "text",
        outputText: "I'm here to help with your task.",
      },
      meta: {
        source: "bridge_stream",
        completionObserved: true,
      },
    });
  });

  it("separates THINK fragments from RESPONSE fragments in thinking mode", async () => {
    const { context, composerSend } = createBridgeTestContext();

    class FakeThinkingXmlHttpRequest {
      public readyState = 0;
      public responseText = "";
      private readonly listeners = new Map<string, Array<() => void>>();

      addEventListener(type: string, handler: () => void) {
        const current = this.listeners.get(type) ?? [];
        current.push(handler);
        this.listeners.set(type, current);
      }

      open(_method?: string, _url?: string) {
        return undefined;
      }

      send() {
        setTimeout(() => {
          this.pushChunk(
            [
              "event: ready",
              "data: {\"request_message_id\":5,\"response_message_id\":6,\"model_type\":\"expert\"}",
              "",
              "data: {\"v\":{\"response\":{\"message_id\":6,\"status\":\"WIP\",\"fragments\":[{\"id\":2,\"type\":\"THINK\",\"content\":\"需要\"}]}}}",
              "",
              "data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\"先理清\"}",
              "",
              "data: {\"p\":\"response/fragments\",\"o\":\"APPEND\",\"v\":[{\"id\":3,\"type\":\"RESPONSE\",\"content\":\"最终\"}]}",
              "",
              "data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\"答案\"}",
              "",
              "data: {\"p\":\"response/status\",\"o\":\"SET\",\"v\":\"FINISHED\"}",
              "",
              "event: close",
              "data: {\"click_behavior\":\"none\",\"auto_resume\":false}",
              "",
            ].join("\n"),
            4,
          );
        }, 50);
        return undefined;
      }

      private pushChunk(chunk: string, readyState: number) {
        this.responseText += chunk;
        this.readyState = readyState;
        for (const handler of this.listeners.get("readystatechange") ?? []) {
          handler();
        }
      }
    }

    context.XMLHttpRequest = FakeThinkingXmlHttpRequest;
    (context.window as Record<string, unknown>).XMLHttpRequest = FakeThinkingXmlHttpRequest;

    composerSend.click = () => {
      const xhr = new FakeThinkingXmlHttpRequest();
      xhr.open("POST", "/api/v0/chat/completion");
      xhr.send();
      composerSend.clicked += 1;
    };

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();

    const result = await bridge.sendPrompt({ prompt: "hello", timeoutMs: 2_000 });

    expect(result).toEqual({
      ok: true,
      turn: {
        mode: "text",
        outputText: "最终答案",
      },
      meta: {
        source: "bridge_stream",
        completionObserved: true,
      },
    });
  });

  it("returns the captured completion text even when DOM shows a cleaner final reply", async () => {
    const {
      context,
      composerSend,
      latestAssistantMarkdown,
      latestAssistantMessage,
    } = createBridgeTestContext({
      latestAssistantText: "",
      assistantVisible: true,
    });

    class FakePartialJsonXmlHttpRequest {
      public readyState = 0;
      public responseText = "";
      private readonly listeners = new Map<string, Array<() => void>>();

      addEventListener(type: string, handler: () => void) {
        const current = this.listeners.get(type) ?? [];
        current.push(handler);
        this.listeners.set(type, current);
      }

      open(_method?: string, _url?: string) {
        return undefined;
      }

      send() {
        setTimeout(() => {
          this.pushChunk(
            [
              "event: ready",
              "data: {\"request_message_id\":7,\"response_message_id\":8,\"model_type\":\"default\"}",
              "",
              "data: {\"v\":{\"response\":{\"message_id\":8,\"status\":\"WIP\",\"fragments\":[{\"type\":\"RESPONSE\",\"content\":\"{\\\"\"}]}}}",
              "",
              "event: close",
              "data: {\"click_behavior\":\"none\",\"auto_resume\":false}",
              "",
            ].join("\n"),
            4,
          );
        }, 50);
        return undefined;
      }

      private pushChunk(chunk: string, readyState: number) {
        this.responseText += chunk;
        this.readyState = readyState;
        for (const handler of this.listeners.get("readystatechange") ?? []) {
          handler();
        }
      }
    }

    context.XMLHttpRequest = FakePartialJsonXmlHttpRequest;
    (context.window as Record<string, unknown>).XMLHttpRequest = FakePartialJsonXmlHttpRequest;

    composerSend.click = () => {
      const xhr = new FakePartialJsonXmlHttpRequest();
      xhr.open("POST", "/api/v0/chat/completion");
      xhr.send();
      composerSend.clicked += 1;
    };

    setTimeout(() => {
      if (latestAssistantMarkdown) {
        latestAssistantMarkdown.textContent = "你好，我在。";
      }
      if (latestAssistantMessage) {
        latestAssistantMessage.textContent = "你好，我在。";
      }
    }, 150);

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();

    const result = await bridge.sendPrompt({ prompt: "hello", timeoutMs: 3_000 });

    expect(result).toEqual({
      ok: true,
      turn: {
        mode: "text",
        outputText: "{\"",
      },
      meta: {
        source: "bridge_stream",
        completionObserved: true,
      },
    });
  });

  it("captures completion content updates when patch path is present without op", async () => {
    const { context, composerSend } = createBridgeTestContext();

    class FakeImplicitAppendXmlHttpRequest {
      public readyState = 0;
      public responseText = "";
      private readonly listeners = new Map<string, Array<() => void>>();

      addEventListener(type: string, handler: () => void) {
        const current = this.listeners.get(type) ?? [];
        current.push(handler);
        this.listeners.set(type, current);
      }

      open(_method?: string, _url?: string) {
        return undefined;
      }

      send() {
        setTimeout(() => {
          this.pushChunk(
            [
              "event: ready",
              "data: {\"request_message_id\":11,\"response_message_id\":12,\"model_type\":\"default\"}",
              "",
              "data: {\"v\":{\"response\":{\"message_id\":12,\"status\":\"WIP\",\"fragments\":[{\"id\":2,\"type\":\"THINK\",\"content\":\"We\"}]}}}",
              "",
              "data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\" need\"}",
              "",
              "data: {\"p\":\"response/fragments\",\"o\":\"APPEND\",\"v\":[{\"id\":3,\"type\":\"RESPONSE\",\"content\":\"{\\\"\"}]}",
              "",
              "data: {\"p\":\"response/fragments/-1/content\",\"v\":\"type\"}",
              "",
              "data: {\"v\":\"\\\":\\\"\"}",
              "",
              "data: {\"v\":\"message\"}",
              "",
              "data: {\"v\":\"\\\",\\\"content\\\":\\\"\"}",
              "",
              "data: {\"v\":\"Hey\"}",
              "",
              "data: {\"v\":\"!\\\"}\"}",
              "",
              "data: {\"p\":\"response/status\",\"o\":\"SET\",\"v\":\"FINISHED\"}",
              "",
              "event: close",
              "data: {\"click_behavior\":\"none\",\"auto_resume\":false}",
              "",
            ].join("\n"),
            4,
          );
        }, 50);
        return undefined;
      }

      private pushChunk(chunk: string, readyState: number) {
        this.responseText += chunk;
        this.readyState = readyState;
        for (const handler of this.listeners.get("readystatechange") ?? []) {
          handler();
        }
      }
    }

    context.XMLHttpRequest = FakeImplicitAppendXmlHttpRequest;
    (context.window as Record<string, unknown>).XMLHttpRequest = FakeImplicitAppendXmlHttpRequest;

    composerSend.click = () => {
      const xhr = new FakeImplicitAppendXmlHttpRequest();
      xhr.open("POST", "/api/v0/chat/completion");
      xhr.send();
      composerSend.clicked += 1;
    };

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();

    const result = await bridge.sendPrompt({ prompt: "hello", timeoutMs: 2_000 });

    expect(result).toEqual({
      ok: true,
      turn: {
        mode: "text",
        outputText: "Hey!",
      },
      meta: {
        source: "bridge_stream",
        completionObserved: true,
      },
    });
  });

  it("returns streamed tool calls without waiting for assistant DOM text", async () => {
    const { context, composerSend } = createBridgeTestContext();

    class FakeToolCallXmlHttpRequest {
      public readyState = 0;
      public responseText = "";
      private readonly listeners = new Map<string, Array<() => void>>();

      addEventListener(type: string, handler: () => void) {
        const current = this.listeners.get(type) ?? [];
        current.push(handler);
        this.listeners.set(type, current);
      }

      open(_method?: string, _url?: string) {
        return undefined;
      }

      send() {
        setTimeout(() => {
          this.pushChunk(
            [
              "event: ready",
              "data: {\"request_message_id\":9,\"response_message_id\":10,\"model_type\":\"default\"}",
              "",
              "data: {\"v\":{\"response\":{\"message_id\":10,\"status\":\"WIP\",\"fragments\":[{\"type\":\"RESPONSE\",\"content\":\"{\\\"type\\\":\\\"tool_call\\\",\\\"name\\\":\\\"read\\\",\\\"arguments\\\":{\\\"path\\\":\\\"src/app.ts\\\"}}\"}]}}}",
              "",
              "data: {\"p\":\"response/status\",\"o\":\"SET\",\"v\":\"FINISHED\"}",
              "",
              "event: close",
              "data: {\"click_behavior\":\"none\",\"auto_resume\":false}",
              "",
            ].join("\n"),
            4,
          );
        }, 50);
        return undefined;
      }

      private pushChunk(chunk: string, readyState: number) {
        this.responseText += chunk;
        this.readyState = readyState;
        for (const handler of this.listeners.get("readystatechange") ?? []) {
          handler();
        }
      }
    }

    context.XMLHttpRequest = FakeToolCallXmlHttpRequest;
    (context.window as Record<string, unknown>).XMLHttpRequest = FakeToolCallXmlHttpRequest;

    composerSend.click = () => {
      const xhr = new FakeToolCallXmlHttpRequest();
      xhr.open("POST", "/api/v0/chat/completion");
      xhr.send();
      composerSend.clicked += 1;
    };

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();

    const result = await bridge.sendPrompt({ prompt: "hello", timeoutMs: 2_000 });

    expect(result).toEqual({
      ok: true,
      turn: {
        mode: "json_fallback",
        toolCall: {
          name: "read",
          argumentsJson: "{\"path\":\"src/app.ts\"}",
        },
        outputText:
          "{\"type\":\"tool_call\",\"name\":\"read\",\"arguments\":{\"path\":\"src/app.ts\"}}",
      },
      meta: {
        source: "bridge_stream",
        completionObserved: true,
      },
    });
  });
});
