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
  const VERSION = 3;
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

  function findComposer() {
    return document.querySelector("textarea");
  }

  function findSendButton() {
    const nativeButton =
      document.querySelector("button[type='submit']") ||
      document.querySelector("button[aria-label='Send']") ||
      document.querySelector("button[aria-label='发送']") ||
      document.querySelector("button[data-testid='send']");

    if (nativeButton) {
      return nativeButton;
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

  async function waitForReply(timeoutMs) {
    const startedAt = Date.now();
    let lastText = "";
    let stableCount = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const node = latestAssistantNode();
      const nextText = node ? (node.textContent || "").trim() : "";
      const stopButton = findStopButton();

      if (nextText && nextText !== lastText) {
        lastText = nextText;
        stableCount = 0;
      } else if (nextText) {
        stableCount += 1;
      }

      if (nextText && !stopButton && stableCount >= 3) {
        return { ok: true, reply: nextText };
      }

      await sleep(250);
    }

    return { ok: false, error: "TIMEOUT" };
  }

  window[KEY] = {
    __version: VERSION,
    getPageState() {
      const composer = findComposer();
      const latestAssistant = latestAssistantNode();
      return {
        inputReady: Boolean(composer),
        busy: Boolean(
          findStopButton()
        ),
        latestAssistantPreview: latestAssistant ? (latestAssistant.textContent || "").trim() || null : null,
        assistantCount: assistantMessageCount(),
      };
    },
    async submitPrompt({ prompt }) {
      const composer = findComposer();
      if (!composer) {
        return { ok: false, error: "AUTOMATION_DESYNC" };
      }

      composer.focus();
      composer.value = prompt;
      composer.dispatchEvent(new Event("input", { bubbles: true }));

      const sendButton = findSendButton();
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
      const submitted = await window[KEY].submitPrompt({ prompt });
      if (!submitted.ok) {
        return submitted;
      }

      return waitForReply(timeoutMs);
    },
  };

  return window[KEY];
})();
`;
