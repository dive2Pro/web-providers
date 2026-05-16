import { describe, expect, it } from "vitest";
import { createDeepSeekAdapter } from "../../src/helper/providers/deepseek/adapter";

describe("deepseek adapter", () => {
  it("waits through transient loading states until the page becomes ready", async () => {
    let pageStateCallCount = 0;

    const adapter = createDeepSeekAdapter({
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (!script.includes("getPageState()")) {
          return undefined as T;
        }

        pageStateCallCount += 1;
        if (pageStateCallCount === 1) {
          return {
            inputReady: false,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
            blockingMessage:
              "DeepSeek tab is still loading. Wait for the page to finish loading.",
          } as T;
        }

        return {
          inputReady: true,
          busy: false,
          latestAssistantPreview: null,
          assistantCount: 0,
          shellReady: true,
          blockingMessage: null,
        } as T;
      },
    } as never);

    const result = await adapter.bindTab();

    expect(result.loginState).toBe("logged_in");
    expect(pageStateCallCount).toBe(2);
  });
});
