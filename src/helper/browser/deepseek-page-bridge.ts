import { HelperError } from "../errors";

export const DEEPSEEK_HOST_ALLOWLIST = new Set([
  "chat.deepseek.com",
  "www.deepseek.com",
  "deepseek.com",
]);

export function assertDeepSeekUrl(rawUrl: string) {
  const url = new URL(rawUrl);

  if (!DEEPSEEK_HOST_ALLOWLIST.has(url.host)) {
    throw new HelperError(
      "PAGE_UNAVAILABLE",
      `Unsupported DeepSeek host: ${url.host}`,
    );
  }

  return url.toString();
}

export const INJECTED_BRIDGE_SOURCE = `
(() => {
  const KEY = "__piDeepSeekBridge";
  const VERSION = 8;
  const existing = window[KEY];
  if (
    existing &&
    existing.__version === VERSION &&
    typeof existing.getPageState === "function" &&
    typeof existing.submitPrompt === "function"
  ) {
    return existing;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const COMPLETION_PATH = "/api/v0/chat/completion";

  function createCompletionState() {
    return {
      observed: false,
      startedAt: 0,
      lastEventAt: 0,
      requestMessageId: null,
      responseMessageId: null,
      modelType: null,
      status: "idle",
      reply: "",
      error: null,
      closed: false,
    };
  }

  const completionState = createCompletionState();

  function resetCompletionState() {
    Object.assign(completionState, createCompletionState(), {
      startedAt: Date.now(),
    });
  }

  function markCompletionObserved() {
    completionState.observed = true;
    completionState.lastEventAt = Date.now();
  }

  function normalizeCompletionStatus(value) {
    if (typeof value !== "string") {
      return null;
    }

    if (value === "FINISHED") {
      return "finished";
    }

    if (value === "WIP") {
      return "streaming";
    }

    return value.toLowerCase();
  }

  function matchesCompletionUrl(rawUrl) {
    if (typeof rawUrl !== "string" || rawUrl.length === 0) {
      return false;
    }

    try {
      return new URL(rawUrl, window.location.href).pathname === COMPLETION_PATH;
    } catch {
      return rawUrl.includes(COMPLETION_PATH);
    }
  }

  function applyCompletionPayload(eventType, dataText) {
    if (eventType === "close") {
      completionState.closed = true;
      if (completionState.status === "streaming" && completionState.reply.trim().length > 0) {
        completionState.status = "finished";
      }
      return;
    }

    if (!dataText) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(dataText);
    } catch {
      return;
    }

    markCompletionObserved();

    if (eventType === "ready") {
      completionState.requestMessageId = parsed.request_message_id ?? null;
      completionState.responseMessageId = parsed.response_message_id ?? null;
      completionState.modelType = parsed.model_type ?? null;
      completionState.status = "streaming";
      return;
    }

    if (eventType === "update_session") {
      return;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.v &&
      typeof parsed.v === "object" &&
      parsed.v.response &&
      typeof parsed.v.response === "object"
    ) {
      const response = parsed.v.response;
      if (Array.isArray(response.fragments)) {
        const fullReply = response.fragments
          .filter((fragment) => fragment?.type === "RESPONSE")
          .map((fragment) => (typeof fragment.content === "string" ? fragment.content : ""))
          .join("");
        if (fullReply.length > 0) {
          completionState.reply = fullReply;
        }
      }

      const nextStatus = normalizeCompletionStatus(response.status);
      if (nextStatus) {
        completionState.status = nextStatus;
      }

      return;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.p === "response/fragments/-1/content" &&
      parsed.o === "APPEND" &&
      typeof parsed.v === "string"
    ) {
      completionState.reply += parsed.v;
      completionState.status = "streaming";
      return;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.p === "response/status" &&
      parsed.o === "SET"
    ) {
      const nextStatus = normalizeCompletionStatus(parsed.v);
      if (nextStatus) {
        completionState.status = nextStatus;
      }
      return;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.p === "response" &&
      parsed.o === "BATCH" &&
      Array.isArray(parsed.v)
    ) {
      const statusPatch = parsed.v.find(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          (entry.p === "status" || entry.p === "quasi_status"),
      );
      const nextStatus = normalizeCompletionStatus(statusPatch?.v);
      if (nextStatus) {
        completionState.status = nextStatus;
      }
    }
  }

  function installNetworkHook() {
    if (window.__piDeepSeekXhrHookInstalled) {
      return;
    }

    window.__piDeepSeekXhrHookInstalled = true;

    const XHR = XMLHttpRequest.prototype;
    const originalOpen = XHR.open;
    const originalSend = XHR.send;

    XHR.open = function(method, url) {
      this.__piDeepSeekUrl = url;
      return originalOpen.apply(this, arguments);
    };

    XHR.send = function(body) {
      if (matchesCompletionUrl(this.__piDeepSeekUrl)) {
        let seenLength = 0;
        let buffer = "";

        const flush = () => {
          const responseText =
            typeof this.responseText === "string" ? this.responseText : "";
          const nextChunk = responseText.slice(seenLength);
          if (nextChunk.length === 0) {
            return;
          }

          seenLength = responseText.length;
          buffer += nextChunk.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");

          let boundary = buffer.indexOf("\\n\\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 2);

            if (block.length > 0) {
              let eventType = null;
              const dataLines = [];
              for (const line of block.split("\\n")) {
                if (line.startsWith("event:")) {
                  eventType = line.slice(6).trim();
                  continue;
                }

                if (line.startsWith("data:")) {
                  dataLines.push(line.slice(5).trimStart());
                }
              }

              applyCompletionPayload(eventType, dataLines.join("\\n"));
            }

            boundary = buffer.indexOf("\\n\\n");
          }
        };

        this.addEventListener("readystatechange", () => {
          if (this.readyState === 3 || this.readyState === 4) {
            flush();
          }

          if (this.readyState === 4) {
            const trailing = buffer.trim();
            if (trailing.length > 0) {
              let eventType = null;
              const dataLines = [];
              for (const line of trailing.split("\\n")) {
                if (line.startsWith("event:")) {
                  eventType = line.slice(6).trim();
                  continue;
                }

                if (line.startsWith("data:")) {
                  dataLines.push(line.slice(5).trimStart());
                }
              }

              applyCompletionPayload(eventType, dataLines.join("\\n"));
            }

            if (completionState.status === "streaming" && completionState.reply.trim().length > 0) {
              completionState.status = "finished";
            }
          }
        });
      }

      return originalSend.apply(this, arguments);
    };
  }

  installNetworkHook();

  function findComposer() {
    return document.querySelector("textarea");
  }

  function findComposerControlsRoot(composer) {
    let node = composer?.parentElement || null;
    while (node) {
      const controls = node.querySelectorAll("button, div[role='button']");
      if (controls.length > 0) {
        return node;
      }

      node = node.parentElement;
    }

    return null;
  }

  function findSendButton(composer) {
    const controlsRoot = findComposerControlsRoot(composer);
    const scopedQuery = (selector) =>
      controlsRoot?.querySelector(selector) || document.querySelector(selector);
    const nativeButton =
      scopedQuery("button[type='submit']") ||
      scopedQuery("button[aria-label='Send']") ||
      scopedQuery("button[aria-label='发送']") ||
      scopedQuery("button[data-testid='send']") ||
      scopedQuery("div[role='button'][aria-label='Send']") ||
      scopedQuery("div[role='button'][aria-label='发送']") ||
      scopedQuery("div[role='button'][data-testid='send']");

    if (nativeButton) {
      return nativeButton;
    }

    const scopedButtons = controlsRoot
      ? Array.from(controlsRoot.querySelectorAll("button, div[role='button']"))
      : [];
    const enabledScopedIconButtons = scopedButtons.filter((button) => {
      const className = (button.className || "").toString();
      const isIconButton = className.includes("ds-icon-button");
      const isDisabled =
        button.getAttribute("aria-disabled") === "true" ||
        className.includes("ds-icon-button--disabled");
      return isIconButton && !isDisabled;
    });

    if (enabledScopedIconButtons.length > 0) {
      return enabledScopedIconButtons.at(-1) || null;
    }

    const roleButtons = Array.from(document.querySelectorAll("div[role='button']"));
    const enabledIconButton = roleButtons.find((button) => {
      const className = (button.className || "").toString();
      const isIconButton = className.includes("ds-icon-button");
      const isDisabled =
        button.getAttribute("aria-disabled") === "true" ||
        className.includes("ds-icon-button--disabled");
      return isIconButton && !isDisabled;
    });

    return enabledIconButton || null;
  }

  function findStopButton() {
    return (
      document.querySelector("button[aria-label='Stop']") ||
      document.querySelector("button[aria-label='Stop generating']") ||
      document.querySelector("button[aria-label='停止']") ||
      document.querySelector("button[aria-label='停止生成']") ||
      document.querySelector("button[data-testid='stop']")
    );
  }

  function setComposerValue(composer, nextValue) {
    const prototype = Object.getPrototypeOf(composer);
    const valueDescriptor =
      prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;

    if (typeof valueDescriptor?.set === "function") {
      valueDescriptor.set.call(composer, nextValue);
      return;
    }

    composer.value = nextValue;
  }

  function latestAssistantNode() {
    const dsMessages = Array.from(document.querySelectorAll(".ds-message"));
    for (let index = dsMessages.length - 1; index >= 0; index -= 1) {
      const message = dsMessages[index];
      if (message && message.querySelector(".ds-markdown")) {
        return message;
      }
    }

    const markdownBlocks = Array.from(
      document.querySelectorAll(".ds-markdown, .markdown, [class*='markdown']")
    );
    if (markdownBlocks.length > 0) {
      return markdownBlocks.at(-1) || null;
    }

    const candidates = Array.from(
      document.querySelectorAll("[data-role='assistant'], .assistant, [data-message-author-role='assistant']")
    );
    return candidates.at(-1) || null;
  }

  function assistantMessageCount() {
    const dsMessages = Array.from(document.querySelectorAll(".ds-message"));
    const dsAssistantCount = dsMessages.filter((message) => message?.querySelector(".ds-markdown")).length;
    if (dsAssistantCount > 0) {
      return dsAssistantCount;
    }

    const markdownBlocks = document.querySelectorAll(".ds-markdown, .markdown, [class*='markdown']");
    if (markdownBlocks.length > 0) {
      return markdownBlocks.length;
    }

    return document.querySelectorAll("[data-role='assistant'], .assistant, [data-message-author-role='assistant']").length;
  }

  async function waitForReply(timeoutMs, baselineState) {
    const startedAt = Date.now();
    const baselineReply = (baselineState?.latestAssistantPreview || "").trim();
    const baselineAssistantCount = baselineState?.assistantCount || 0;
    let latestFreshDomText = "";
    let previousFreshDomText = "";
    let sawFreshDomReply = false;
    let stableCount = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const pageState = window[KEY].getPageState();
      const streamedReply = completionState.reply.trim();

      if (pageState.blockingMessage) {
        return {
          ok: false,
          error: "PAGE_UNAVAILABLE",
          message: "DeepSeek requires manual verification in the browser tab before chatting",
        };
      }

      if (completionState.status === "finished" && streamedReply.length > 0) {
        return { ok: true, reply: streamedReply };
      }

      if (streamedReply.length > 0 && completionState.closed) {
        return { ok: true, reply: streamedReply };
      }

      const nextText = (pageState.latestAssistantPreview || "").trim();
      const hasFreshDomReply =
        pageState.assistantCount > baselineAssistantCount ||
        (nextText.length > 0 && nextText !== baselineReply);

      if (hasFreshDomReply && nextText.length > 0) {
        sawFreshDomReply = true;
        latestFreshDomText = nextText;

        if (nextText !== previousFreshDomText) {
          previousFreshDomText = nextText;
          stableCount = 0;
        } else {
          stableCount += 1;
        }
      } else {
        stableCount = 0;
      }

      if (!completionState.observed && sawFreshDomReply && !pageState.busy && stableCount >= 3) {
        return { ok: true, reply: latestFreshDomText };
      }

      await sleep(250);
    }

    const fallbackReply = completionState.reply.trim() || latestFreshDomText;
    if (fallbackReply.length > 0) {
      return { ok: true, reply: fallbackReply };
    }

    return {
      ok: false,
      error: "TIMEOUT",
      message: "The page did not finish streaming in time",
    };
  }

  window[KEY] = {
    __version: VERSION,
    getPageState() {
      const composer = findComposer();
      const latestAssistant = latestAssistantNode();
      const pageText = (document.body?.innerText || "").trim();
      const blockingMessage = pageText.includes("One more step before you proceed")
        ? "One more step before you proceed..."
        : null;
      const streamedReply = completionState.reply.trim();
      const domReply = latestAssistant ? (latestAssistant.textContent || "").trim() || null : null;
      return {
        inputReady: Boolean(composer),
        busy: Boolean(findStopButton()) || completionState.status === "streaming",
        latestAssistantPreview: streamedReply || domReply,
        assistantCount:
          completionState.observed && (streamedReply.length > 0 || completionState.responseMessageId !== null)
            ? Math.max(assistantMessageCount(), 1)
            : assistantMessageCount(),
        blockingMessage,
      };
    },
    async submitPrompt({ prompt }) {
      const composer = findComposer();
      if (!composer) {
        return { ok: false, error: "AUTOMATION_DESYNC" };
      }

      composer.focus();
      setComposerValue(composer, prompt);
      composer.dispatchEvent(new Event("input", { bubbles: true }));

      const sendButton = findSendButton(composer);
      if (sendButton instanceof HTMLElement) {
        sendButton.click();
      } else {
        composer.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
            code: "Enter",
          })
        );
      }

      return { ok: true };
    },
    async sendPrompt({ prompt, timeoutMs }) {
      const baselineState = window[KEY].getPageState();
      resetCompletionState();
      const submitted = await window[KEY].submitPrompt({ prompt });
      if (!submitted.ok) {
        return submitted;
      }

      return waitForReply(timeoutMs, baselineState);
    },
  };

  return window[KEY];
})();
`;
