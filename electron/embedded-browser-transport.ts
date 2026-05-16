import type { WebContents } from "electron";
import type { BbBrowserTransport } from "../src/helper/browser/bb-browser-client";
import { HelperError } from "../src/helper/errors";

type EmbeddedBrowserTabHandle = {
  id: string;
  url: string;
  webContents: WebContents;
};

export function createEmbeddedBrowserTransport(input: {
  getTabById: (tabId: string) => EmbeddedBrowserTabHandle | null;
  listTabs: () => EmbeddedBrowserTabHandle[];
  getActiveTab: () => EmbeddedBrowserTabHandle | null;
  createTab: (url: string) => Promise<EmbeddedBrowserTabHandle>;
  executeTimeoutMs?: number;
}): BbBrowserTransport {
  const executeTimeoutMs = input.executeTimeoutMs ?? 12_000;

  function findMatchingTab(predicate: (tab: EmbeddedBrowserTabHandle) => boolean) {
    const activeTab = input.getActiveTab();
    if (activeTab && predicate(activeTab)) {
      return activeTab;
    }

    return input.listTabs().find((tab) => predicate(tab)) ?? null;
  }

  function requireTab(tabId: string) {
    const tab = input.getTabById(tabId);
    if (!tab) {
      throw new HelperError("NOT_BOUND", `No browser tab is available for ${tabId}`);
    }

    return tab;
  }

  async function executeJavaScriptWithTimeout<T>(
    tab: EmbeddedBrowserTabHandle,
    code: string,
    action: string,
  ) {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        tab.webContents.executeJavaScript<T>(code),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(
                `Embedded browser ${action} timed out after ${executeTimeoutMs}ms on ${tab.id}`,
              ),
            );
          }, executeTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  return {
    async getConnectionStatus() {
      return "connected";
    },

    async getTab(tabId: string) {
      const tab = requireTab(tabId);
      return {
        id: tab.id,
        url: tab.url,
      };
    },

    async findTabByUrl(url: string) {
      const matchingTab = input.listTabs().find(
        (tab) => normalizeUrlForMatch(tab.url) === normalizeUrlForMatch(url),
      );

      return matchingTab
        ? {
            id: matchingTab.id,
            url: matchingTab.url,
          }
        : null;
    },

    async findDeepSeekTab() {
      const matchingTab = findMatchingTab((tab) => isDeepSeekUrl(tab.url));
      if (!matchingTab) {
        throw new HelperError("NOT_BOUND", "No logged-in DeepSeek tab is available");
      }

      return {
        id: matchingTab.id,
        url: matchingTab.url,
      };
    },

    async findQwenTab() {
      const matchingTab = findMatchingTab((tab) => isQwenUrl(tab.url));
      if (!matchingTab) {
        throw new HelperError("NOT_BOUND", "No logged-in Qwen tab is available");
      }

      return {
        id: matchingTab.id,
        url: matchingTab.url,
      };
    },

    async openDeepSeek(url: string) {
      const tab = await input.createTab(url);
      return {
        id: tab.id,
        url: tab.url,
      };
    },

    async openQwen(url: string) {
      const tab = await input.createTab(url);
      return {
        id: tab.id,
        url: tab.url,
      };
    },

    async evaluate<T>(tabId: string, script: string): Promise<T> {
      const serializedScript = JSON.stringify(script);
      const tab = requireTab(tabId);
      const result = await executeJavaScriptWithTimeout<{
        value: T | null;
      }>(
        tab,
        `(async () => {
        const __embeddedScript = ${serializedScript};
        const __embeddedEval = async () => (0, eval)(__embeddedScript);
        const __value = await __embeddedEval();

        try {
          return { value: structuredClone(__value) };
        } catch {}

        try {
          return { value: JSON.parse(JSON.stringify(__value ?? null)) };
        } catch {
          return { value: null };
        }
      })()`,
        "evaluate",
      );

      return (result?.value ?? null) as T;
    },

    async submitPrompt(tabId: string, prompt: string) {
      const promptLiteral = JSON.stringify(prompt);
      const tab = requireTab(tabId);
      const result = await executeJavaScriptWithTimeout<{
        ok?: boolean;
        message?: string;
      }>(
        tab,
        `(() => {
        const prompt = ${promptLiteral};

        if (window.__piDeepSeekBridge?.submitPrompt) {
          return window.__piDeepSeekBridge.submitPrompt({ prompt });
        }

        const qwenComposer =
          document.querySelector("textarea.message-input-textarea") ??
          document.querySelector("[contenteditable='true'][role='textbox']") ??
          document.querySelector("textarea") ??
          document.querySelector("[contenteditable='true']");

        if (qwenComposer instanceof HTMLTextAreaElement) {
          qwenComposer.focus();
          const prototype = Object.getPrototypeOf(qwenComposer);
          const valueDescriptor =
            prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;
          if (typeof valueDescriptor?.set === "function") {
            valueDescriptor.set.call(qwenComposer, prompt);
          } else {
            qwenComposer.value = prompt;
          }
          qwenComposer.dispatchEvent(new Event("input", { bubbles: true }));
          qwenComposer.dispatchEvent(new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
            code: "Enter",
          }));
          return { ok: true };
        }

        if (qwenComposer instanceof HTMLElement) {
          qwenComposer.focus();
          qwenComposer.textContent = prompt;
          qwenComposer.dispatchEvent(new Event("input", { bubbles: true }));
          qwenComposer.dispatchEvent(new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
            code: "Enter",
          }));
          return { ok: true };
        }

        return { ok: false, message: "Chat composer not found in the embedded browser." };
      })()`,
        "submitPrompt",
      );

      if (result?.ok === false) {
        throw new Error(result.message ?? "Failed to submit prompt in the embedded browser.");
      }
    },
  };
}

function normalizeUrlForMatch(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/\/$/, "");
  }
}

function isDeepSeekUrl(url: string) {
  try {
    return new URL(url).host.includes("deepseek.com");
  } catch {
    return false;
  }
}

function isQwenUrl(url: string) {
  try {
    return new URL(url).host === "chat.qwen.ai";
  } catch {
    return false;
  }
}
