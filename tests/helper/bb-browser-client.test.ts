import { describe, expect, it } from "vitest";
import { HelperError } from "../../src/helper/errors";
import {
  BbBrowserClient,
  extractTabsFromTabList,
  unwrapEvalResult,
} from "../../src/helper/browser/bb-browser-client";

describe("BbBrowserClient", () => {
  it("extracts tabs from bb-browser tab list envelopes", () => {
    expect(
      extractTabsFromTabList({
        id: "req-1",
        success: true,
        data: {
          tabs: [
            {
              index: 0,
              url: "about:blank",
              title: "about:blank",
              active: true,
              tabId: "tab-blank",
            },
            {
              index: 1,
              url: "https://chat.deepseek.com",
              title: "DeepSeek",
              active: false,
              tabId: "tab-deepseek",
            },
          ],
          activeIndex: 0,
        },
      }),
    ).toEqual([
      { index: 0, id: "tab-blank", url: "about:blank" },
      { index: 1, id: "tab-deepseek", url: "https://chat.deepseek.com" },
    ]);
  });

  it("unwraps bb-browser eval envelopes to the nested result payload", () => {
    expect(
      unwrapEvalResult({
        id: "req-2",
        success: true,
        data: {
          result: {
            ok: true,
            reply: "hello",
          },
        },
      }),
    ).toEqual({
      ok: true,
      reply: "hello",
    });
  });

  it("binds a DeepSeek tab and injects the page bridge", async () => {
    const evaluations: Array<{ tabId: string; script: string }> = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(tabId: string, script: string) => {
        evaluations.push({ tabId, script });
        return undefined as T;
      },
    });

    const result = await client.bindDeepSeekTab();

    expect(result).toEqual({
      tabId: "tab-1",
      url: "https://chat.deepseek.com/",
      loginState: "logged_in",
      bridgeInjected: true,
      pageState: {
        inputReady: true,
        busy: false,
        latestAssistantPreview: null,
        assistantCount: 0,
      },
    });
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.tabId).toBe("tab-1");
  });

  it("rejects non-DeepSeek tabs during bind", async () => {
    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://example.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>() => undefined as T,
    });

    await expect(client.bindDeepSeekTab()).rejects.toMatchObject({
      code: "PAGE_UNAVAILABLE",
    });
  });

  it("translates missing page-target errors into NOT_BOUND", async () => {
    const opened: string[] = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => {
        throw new Error("No page target found");
      },
      openDeepSeek: async (url: string) => {
        opened.push(url);
      },
      submitPrompt: async () => undefined,
      evaluate: async <T>() => undefined as T,
    });

    await expect(client.bindDeepSeekTab()).rejects.toEqual(
      new HelperError(
        "NOT_BOUND",
        "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
      ),
    );
    expect(opened).toEqual(["https://chat.deepseek.com"]);
  });

  it("translates page timeout responses into HelperError", async () => {
    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("getPageState")) {
          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
          } as T;
        }

        return {
          inputReady: true,
          busy: false,
          latestAssistantPreview: null,
          assistantCount: 0,
        } as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "hello",
        timeoutMs: 1000,
      }),
    ).rejects.toEqual(
      new HelperError("TIMEOUT", "The page did not finish streaming in time"),
    );
  });

  it("submits prompt through transport and returns fresh assistant reply", async () => {
    let submittedPrompt: string | null = null;
    let pollCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async (_tabId: string, prompt: string) => {
        submittedPrompt = prompt;
      },
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("getPageState")) {
          pollCount += 1;
          if (pollCount === 1) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "old reply",
              assistantCount: 1,
            } as T;
          }

          if (pollCount === 2) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: "new reply",
              assistantCount: 2,
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "new reply",
            assistantCount: 2,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "hello",
        timeoutMs: 3000,
      }),
    ).resolves.toEqual({
      reply: "new reply",
      modelLabel: "DeepSeek Web",
    });

    expect(submittedPrompt).toBe("hello");
  });

  it("treats assistant count increase as a fresh reply even when text repeats", async () => {
    let pollCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("getPageState")) {
          pollCount += 1;
          if (pollCount === 1) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "same reply",
              assistantCount: 1,
            } as T;
          }

          if (pollCount === 2) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: "same reply",
              assistantCount: 2,
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "same reply",
            assistantCount: 2,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "repeat",
        timeoutMs: 3000,
      }),
    ).resolves.toEqual({
      reply: "same reply",
      modelLabel: "DeepSeek Web",
    });
  });

  it("extends timeout window while assistant text keeps streaming", async () => {
    let pollCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("getPageState")) {
          pollCount += 1;
          if (pollCount === 1) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "A",
              assistantCount: 1,
            } as T;
          }

          if (pollCount === 2) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: "AB",
              assistantCount: 2,
            } as T;
          }

          if (pollCount === 3) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: "ABC",
              assistantCount: 2,
            } as T;
          }

          if (pollCount === 4) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "ABC",
              assistantCount: 2,
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "ABC",
            assistantCount: 2,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "stream",
        timeoutMs: 400,
      }),
    ).resolves.toEqual({
      reply: "ABC",
      modelLabel: "DeepSeek Web",
    });
  });

  it("does not idle-timeout while page reports busy before first visible token", async () => {
    let pollCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("getPageState")) {
          pollCount += 1;
          if (pollCount === 1) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: null,
              assistantCount: 0,
            } as T;
          }

          if (pollCount <= 4) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: null,
              assistantCount: 0,
            } as T;
          }

          if (pollCount === 5) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: "first token",
              assistantCount: 1,
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "first token",
            assistantCount: 1,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "busy-first-token",
        timeoutMs: 400,
      }),
    ).resolves.toEqual({
      reply: "first token",
      modelLabel: "DeepSeek Web",
    });
  });

  it("returns a recovered final reply after timeout polling misses page progress", async () => {
    let pollCount = 0;
    let resetCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge = undefined")) {
          resetCount += 1;
          return true as T;
        }

        if (script.includes("getPageState")) {
          pollCount += 1;

          if (pollCount === 1) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "old reply",
              assistantCount: 1,
            } as T;
          }

          if (resetCount > 0) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "new reply",
              assistantCount: 2,
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "old reply",
            assistantCount: 1,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "recover",
        timeoutMs: 400,
      }),
    ).resolves.toEqual({
      reply: "new reply",
      modelLabel: "DeepSeek Web",
    });

    expect(resetCount).toBe(1);
  });
});
