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

  querySelector(_selector: string) {
    return null;
  }

  querySelectorAll(_selector: string) {
    return [] as FakeElement[];
  }

  closest(_selector: string) {
    return null as FakeElement | null;
  }
}

class FakeTextarea extends FakeElement {
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
    addEventListener() {}
  }

  FakeXmlHttpRequest.prototype.open = function open() {
    return undefined;
  };

  FakeXmlHttpRequest.prototype.send = function send() {
    return undefined;
  };

  const windowObject: Record<string, unknown> = {
    location: {
      href: "https://chat.deepseek.com/",
    },
  };

  const context = {
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
      error: "TIMEOUT",
      message: "The page did not finish streaming in time",
    });
  });

  it("waits for the DOM preview to settle before returning a fresh reply without SSE events", async () => {
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
      ok: true,
      turn: {
        mode: "text",
        outputText: "I'm here to help with your task.",
      },
      meta: {
        source: "bridge_timeout_recovery",
        completionObserved: false,
      },
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

      open() {
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
});
