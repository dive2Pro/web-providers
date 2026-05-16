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
  public tagName = "DIV";
  public innerText = "";
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
    this.tagName = "TEXTAREA";
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
  includeNewChatButton?: boolean;
  includeModeButtons?: boolean;
  composerKind?: "textarea" | "contenteditable" | "none";
  modeControlsAsRadios?: boolean;
  selectedMode?: "expert" | "default";
  modeButtonsAppearAfterMs?: number;
  expertModeLabel?: string;
  flashModeLabel?: string;
  initialUrl?: string;
  newChatTargetUrl?: string;
  newChatNavigatesAfterMs?: number;
  includeContinueButton?: boolean;
  documentReadyState?: "loading" | "interactive" | "complete";
}) {
  const createdAt = Date.now();
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
  const modeGroupRoot = new FakeElement();
  const stoppedReplyCard = new FakeElement();
  const continueButton = new FakeElement({
    attributes: {
      role: "button",
      "aria-disabled": "false",
    },
  });
  const textarea = new FakeTextarea(composerSend);
  const contenteditableComposer = new FakeElement({
    attributes: {
      role: "textbox",
      contenteditable: "true",
    },
  });
  contenteditableComposer.tagName = "DIV";
  const newChatButton = new FakeElement({
    attributes: {
      "aria-label": "New Chat",
    },
  });
  const expertModeButton = new FakeElement({
    attributes: {
      role: options?.modeControlsAsRadios ? "radio" : "button",
      "aria-checked":
        options?.modeControlsAsRadios && options?.selectedMode === "expert"
          ? "true"
          : "false",
      "aria-pressed": options?.selectedMode === "expert" ? "true" : "false",
    },
  });
  const flashModeButton = new FakeElement({
    attributes: {
      role: options?.modeControlsAsRadios ? "radio" : "button",
      "aria-checked":
        options?.modeControlsAsRadios && options?.selectedMode === "default"
          ? "true"
          : "false",
      "aria-pressed": options?.selectedMode === "default" ? "true" : "false",
    },
  });
  expertModeButton.textContent = options?.expertModeLabel ?? "Expert";
  flashModeButton.textContent = options?.flashModeLabel ?? "Flash";
  continueButton.textContent = "Continue";
  expertModeButton.parentElement = modeGroupRoot;
  flashModeButton.parentElement = modeGroupRoot;
  continueButton.parentElement = stoppedReplyCard;
  expertModeButton.click = () => {
    expertModeButton.clicked += 1;
    expertModeButton.setAttribute("aria-checked", "true");
    flashModeButton.setAttribute("aria-checked", "false");
    expertModeButton.setAttribute("aria-pressed", "true");
    flashModeButton.setAttribute("aria-pressed", "false");
  };
  flashModeButton.click = () => {
    flashModeButton.clicked += 1;
    flashModeButton.setAttribute("aria-checked", "true");
    expertModeButton.setAttribute("aria-checked", "false");
    flashModeButton.setAttribute("aria-pressed", "true");
    expertModeButton.setAttribute("aria-pressed", "false");
  };
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

  let continueVisible = options?.includeContinueButton === true;
  const syncContinueCard = () => {
    stoppedReplyCard.textContent = continueVisible ? "Stopped\nContinue" : "";
  };
  syncContinueCard();

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
    readyState: options?.documentReadyState ?? "complete",
    body: {
      innerText: continueVisible ? "Stopped\nContinue" : "",
    },
    querySelector(selector: string) {
      const composerKind = options?.composerKind ?? "textarea";

      if (selector === "textarea" && composerKind === "textarea") {
        return textarea;
      }

      if (
        composerKind === "contenteditable" &&
        (
          selector === "[contenteditable='true'][role='textbox']" ||
          selector === "[contenteditable='plaintext-only'][role='textbox']" ||
          selector === "[contenteditable='true']" ||
          selector === "[contenteditable='plaintext-only']" ||
          selector === "div[role='textbox']"
        )
      ) {
        return contenteditableComposer;
      }

      if (
        options?.includeNewChatButton &&
        (selector === "button[aria-label='New Chat']" ||
          selector === "a[aria-label='New Chat']")
      ) {
        return newChatButton;
      }

      return null;
    },
    querySelectorAll(selector: string) {
      const shouldShowModeButtons =
        options?.includeModeButtons &&
        Date.now() - createdAt >= (options?.modeButtonsAppearAfterMs ?? 0);

      if (
        selector === "button, a, div[role='button']" ||
        selector ===
          "button, a, div[role='button'], [role='radio'], input[type='radio']"
      ) {
        const modeControls = shouldShowModeButtons
          ? options?.modeControlsAsRadios
            ? [flashModeButton, expertModeButton]
            : [expertModeButton, flashModeButton]
          : [];
        return [
          ...(options?.includeNewChatButton ? [newChatButton] : []),
          ...modeControls,
          ...(continueVisible ? [continueButton] : []),
          unrelatedPageIcon,
          composerToggle,
          composerAttach,
          composerSend,
        ];
      }

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

  const setContinueVisible = (nextValue: boolean) => {
    continueVisible = nextValue;
    document.body.innerText = nextValue ? "Stopped\nContinue" : "";
    syncContinueCard();
  };

  continueButton.click = () => {
    continueButton.clicked += 1;
    setContinueVisible(false);
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

  const windowLocation = {
    href: options?.initialUrl ?? "https://chat.deepseek.com/",
    pathname: (() => {
      try {
        return new URL(options?.initialUrl ?? "https://chat.deepseek.com/").pathname;
      } catch {
        return "/";
      }
    })(),
  };

  newChatButton.click = () => {
    newChatButton.clicked += 1;
    const targetUrl = options?.newChatTargetUrl;
    if (targetUrl) {
      setTimeout(() => {
        windowLocation.href = targetUrl;
        windowLocation.pathname = new URL(targetUrl).pathname;
      }, options?.newChatNavigatesAfterMs ?? 0);
    }
  };

  const windowObject: Record<string, unknown> = {
    location: windowLocation,
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
    contenteditableComposer,
    unrelatedPageIcon,
    composerSend,
    newChatButton,
    expertModeButton,
    flashModeButton,
    latestAssistantMarkdown,
    latestAssistantMessage,
    continueButton,
    setContinueVisible,
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
      toolCalls: [
        {
          name: "read",
          argumentsJson: "{\"path\":\"src/app.ts\"}",
        },
      ],
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
      toolCalls: [
        {
          name: "read",
          argumentsJson: "{\"path\":\"src/app.ts\"}",
        },
      ],
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
      rawOutputText: "{\"type\":\"message\",\"content\":\"hello from deepseek\"}",
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
      toolCalls: [
        {
          name: "bash",
          argumentsJson: "{\"cmd\":\"ls -la\"}",
        },
      ],
      outputText: reply,
    });
  });

  it("classifies embedded JSON fallback tool calls from mixed prose", () => {
    const reply = [
      "我先检查一下目录。",
      '{"type":"tool_call","name":"bash","arguments":{"cmd":"ls -la"}}',
    ].join("\n");

    expect(
      classifyCompletionTurn({
        reply,
        rawEvents: [],
      }),
    ).toEqual({
      mode: "json_fallback",
      toolCalls: [
        {
          name: "bash",
          argumentsJson: "{\"cmd\":\"ls -la\"}",
        },
      ],
      outputText: reply,
    });
  });

  it("uses only the assistant markdown block for the latest preview", () => {
    const { context, latestAssistantMarkdown, latestAssistantMessage } = createBridgeTestContext({
      assistantVisible: true,
    });

    if (!latestAssistantMarkdown || !latestAssistantMessage) {
      throw new Error("expected assistant nodes to exist");
    }

    latestAssistantMarkdown.textContent = "final answer";
    latestAssistantMessage.textContent = "Thought for 2 seconds\nfinal answer";

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();

    expect(bridge.getPageState()).toMatchObject({
      latestAssistantPreview: "final answer",
    });
  });

  it("treats a contenteditable DeepSeek composer as input-ready", () => {
    const { context, contenteditableComposer } = createBridgeTestContext({
      composerKind: "contenteditable",
    });

    contenteditableComposer.parentElement = new FakeElement();

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge.getPageState()).toMatchObject({
      inputReady: true,
      shellReady: true,
      blockingMessage: null,
    });
  });

  it("does not report loading when the DeepSeek app shell is visible before the composer mounts", () => {
    const { context } = createBridgeTestContext({
      composerKind: "none",
      includeNewChatButton: true,
      includeModeButtons: true,
      documentReadyState: "interactive",
    });

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge.getPageState()).toMatchObject({
      inputReady: true,
      shellReady: true,
      blockingMessage: null,
    });
  });

  it("reports an empty embedded page separately from an in-flight load", () => {
    const { context } = createBridgeTestContext({
      composerKind: "none",
      documentReadyState: "complete",
    });

    context.document.body.innerText = "";
    context.document.querySelectorAll = () => [];

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge.getPageState()).toMatchObject({
      inputReady: false,
      shellReady: false,
      blockingMessage:
        "DeepSeek finished loading an empty page in the embedded browser. Reload the page or sign in manually, then retry.",
    });
  });

  it("does not treat a bare home link and generic icon buttons as the DeepSeek app shell", () => {
    const { context } = createBridgeTestContext({
      composerKind: "none",
      documentReadyState: "interactive",
    });
    const homeLink = new FakeElement({
      attributes: {
        href: "/",
      },
    });
    homeLink.tagName = "A";
    const genericIconButton = new FakeElement({
      className: "ds-icon-button",
      attributes: {
        role: "button",
      },
    });
    const originalQuerySelector = context.document.querySelector.bind(context.document);
    const originalQuerySelectorAll = context.document.querySelectorAll.bind(context.document);
    context.document.querySelector = (selector: string) => {
      if (selector === "a[href='/']") {
        return homeLink;
      }

      return originalQuerySelector(selector);
    };
    context.document.querySelectorAll = (selector: string) => {
      if (
        selector === "button, a, div[role='button']" ||
        selector ===
          "button, a, div[role='button'], [role='radio'], input[type='radio']"
      ) {
        return [homeLink, genericIconButton];
      }

      return originalQuerySelectorAll(selector);
    };

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge.getPageState()).toMatchObject({
      inputReady: false,
      shellReady: false,
      blockingMessage: "DeepSeek tab is still loading. Wait for the page to finish loading.",
      diagnostics: {
        interactiveComposerReady: false,
      },
    });
  });

  it("keeps multi-object protocol output as plain text for upper-layer repair", () => {
    const reply = [
      '{"type":"message","content":"先看下项目结构"}',
      '{"type":"tool_call","name":"bash","arguments":{"command":"ls -la"}}',
      '{"type":"tool_call","name":"read","arguments":{"file":"package.json"}}',
    ].join("\n");

    expect(
      classifyCompletionTurn({
        reply,
        rawEvents: [],
      }),
    ).toEqual({
      mode: "text",
      outputText: reply,
    });
  });

  it("switches DeepSeek into expert mode when starting a new chat", async () => {
    const { context, newChatButton, expertModeButton, flashModeButton } =
      createBridgeTestContext({
        includeNewChatButton: true,
        includeModeButtons: true,
        selectedMode: "default",
      });

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    const result = await bridge.startNewChat({ targetModelType: "expert" });

    expect(result).toEqual({ ok: true });
    expect(newChatButton.clicked).toBe(1);
    expect(expertModeButton.clicked).toBe(1);
    expect(expertModeButton.getAttribute("aria-pressed")).toBe("true");
    expect(flashModeButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("waits for the DeepSeek mode buttons to appear before switching to expert mode", async () => {
    const { context, expertModeButton, flashModeButton } =
      createBridgeTestContext({
        includeNewChatButton: true,
        includeModeButtons: true,
        selectedMode: "default",
        modeButtonsAppearAfterMs: 900,
      });

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    const result = await bridge.startNewChat({ targetModelType: "expert" });

    expect(result).toEqual({ ok: true });
    expect(expertModeButton.clicked).toBe(1);
    expect(expertModeButton.getAttribute("aria-pressed")).toBe("true");
    expect(flashModeButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("recognizes the DeepThink toggle as the DeepSeek expert mode control", async () => {
    const { context, expertModeButton } = createBridgeTestContext({
      includeNewChatButton: true,
      includeModeButtons: true,
      selectedMode: "default",
      expertModeLabel: "DeepThink",
      flashModeLabel: "Search",
    });

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    const result = await bridge.startNewChat({ targetModelType: "expert" });

    expect(result).toEqual({ ok: true });
    expect(expertModeButton.clicked).toBe(1);
    expect(expertModeButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("prefers the second root-page radio for expert mode even without matching labels", async () => {
    const { context, expertModeButton, flashModeButton } =
      createBridgeTestContext({
        includeNewChatButton: true,
        includeModeButtons: true,
        modeControlsAsRadios: true,
        selectedMode: "default",
        expertModeLabel: "模式二",
        flashModeLabel: "模式一",
      });

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    const result = await bridge.startNewChat({ targetModelType: "expert" });

    expect(result).toEqual({ ok: true });
    expect(expertModeButton.clicked).toBe(1);
    expect(expertModeButton.getAttribute("aria-checked")).toBe("true");
    expect(flashModeButton.getAttribute("aria-checked")).toBe("false");
  });

  it("prefers the first root-page radio for default mode on the Chinese page", async () => {
    const { context, expertModeButton, flashModeButton } =
      createBridgeTestContext({
        includeModeButtons: true,
        modeControlsAsRadios: true,
        selectedMode: "expert",
        expertModeLabel: "专家模式",
        flashModeLabel: "快速模式",
      });

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    const result = await bridge.setModelType({ targetModelType: "default" });

    expect(result).toEqual({ ok: true });
    expect(flashModeButton.clicked).toBe(1);
    expect(flashModeButton.getAttribute("aria-checked")).toBe("true");
    expect(expertModeButton.getAttribute("aria-checked")).toBe("false");
  });

  it("waits for the page url to leave the previous DeepSeek conversation before sending", async () => {
    const { context, newChatButton } = createBridgeTestContext({
      includeNewChatButton: true,
      includeModeButtons: true,
      selectedMode: "default",
      initialUrl: "https://chat.deepseek.com/a/chat/s/original-session",
      newChatTargetUrl: "https://chat.deepseek.com/",
      newChatNavigatesAfterMs: 300,
    });

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    const result = await bridge.startNewChat({ targetModelType: "expert" });

    expect(result).toEqual({ ok: true });
    expect(newChatButton.clicked).toBe(1);
    expect((context.window as Record<string, any>).location.pathname).toBe("/");
  });

  it("classifies a tool_calls JSON envelope into multiple structured tool calls", () => {
    expect(
      classifyCompletionTurn({
        reply:
          "{\"type\":\"tool_calls\",\"calls\":[{\"name\":\"read\",\"arguments\":{\"path\":\"src/app.ts\"}},{\"name\":\"bash\",\"arguments\":{\"cmd\":\"pwd\"}}]}",
        rawEvents: [],
      }),
    ).toEqual({
      mode: "json_fallback",
      toolCalls: [
        {
          name: "read",
          argumentsJson: "{\"path\":\"src/app.ts\"}",
        },
        {
          name: "bash",
          argumentsJson: "{\"cmd\":\"pwd\"}",
        },
      ],
      outputText:
        "{\"type\":\"tool_calls\",\"calls\":[{\"name\":\"read\",\"arguments\":{\"path\":\"src/app.ts\"}},{\"name\":\"bash\",\"arguments\":{\"cmd\":\"pwd\"}}]}",
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

  it("auto-clicks Continue and waits for the resumed DeepSeek reply to finish", async () => {
    const { context, composerSend, continueButton, setContinueVisible } =
      createBridgeTestContext();
    let streamStage = 0;

    class FakeInterruptedXmlHttpRequest {
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
        if (streamStage === 0) {
          streamStage += 1;
          setTimeout(() => {
            this.pushChunk(
              [
                "event: ready",
                "data: {\"request_message_id\":21,\"response_message_id\":22,\"model_type\":\"default\"}",
                "",
                "data: {\"v\":{\"response\":{\"message_id\":22,\"status\":\"WIP\",\"fragments\":[{\"type\":\"RESPONSE\",\"content\":\"hello\"}]}}}",
                "",
                "event: close",
                "data: {\"click_behavior\":\"none\",\"auto_resume\":false}",
                "",
              ].join("\n"),
              4,
            );
            setContinueVisible(true);
          }, 50);
          return undefined;
        }

        streamStage += 1;
        setTimeout(() => {
          this.pushChunk(
            [
              "event: ready",
              "data: {\"request_message_id\":21,\"response_message_id\":22,\"model_type\":\"default\"}",
              "",
              "data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\" world\"}",
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

    context.XMLHttpRequest = FakeInterruptedXmlHttpRequest;
    (context.window as Record<string, unknown>).XMLHttpRequest =
      FakeInterruptedXmlHttpRequest;

    composerSend.click = () => {
      const xhr = new FakeInterruptedXmlHttpRequest();
      xhr.open("POST", "/api/v0/chat/completion");
      xhr.send();
      composerSend.clicked += 1;
    };

    const originalContinueClick = continueButton.click.bind(continueButton);
    continueButton.click = () => {
      originalContinueClick();
      const xhr = new FakeInterruptedXmlHttpRequest();
      xhr.open("POST", "/api/v0/chat/completion");
      xhr.send();
    };

    vm.runInNewContext(INJECTED_BRIDGE_SOURCE, context);

    const bridge = (context.window as Record<string, any>).__piDeepSeekBridge;
    expect(bridge).toBeTruthy();

    const result = await bridge.sendPrompt({ prompt: "hello", timeoutMs: 3_000 });

    expect(result).toEqual({
      ok: true,
      turn: {
        mode: "text",
        outputText: "hello world",
      },
      meta: {
        source: "bridge_stream",
        completionObserved: true,
      },
    });
    expect(composerSend.clicked).toBe(1);
    expect(continueButton.clicked).toBe(1);
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
        thinkingText: "需要先理清",
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
        thinkingText: "We need",
        outputText: "Hey!",
        rawOutputText: "{\"type\":\"message\",\"content\":\"Hey!\"}",
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
        toolCalls: [
          {
            name: "read",
            argumentsJson: "{\"path\":\"src/app.ts\"}",
          },
        ],
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
