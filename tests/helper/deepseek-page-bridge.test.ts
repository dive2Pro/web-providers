import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { INJECTED_BRIDGE_SOURCE } from "../../src/helper/browser/deepseek-page-bridge";

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

function createBridgeTestContext(options?: { latestAssistantText?: string }) {
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
  const latestAssistantMarkdown = options?.latestAssistantText
    ? new FakeElement()
    : null;
  const latestAssistantMessage = options?.latestAssistantText
    ? new FakeElement()
    : null;

  if (latestAssistantMarkdown && latestAssistantMessage) {
    latestAssistantMarkdown.textContent = options.latestAssistantText;
    latestAssistantMessage.textContent = options.latestAssistantText;
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
  };
}

describe("deepseek page bridge", () => {
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
});
