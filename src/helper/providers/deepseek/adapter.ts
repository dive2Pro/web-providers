import type { BindResult } from "../../browser/types";
import type { BbBrowserTransport } from "../../browser/bb-browser-client";
import { HelperError } from "../../errors";
import {
  assertDeepSeekUrl,
  INJECTED_BRIDGE_SOURCE,
} from "./page-bridge";
import type { ProviderAdapter } from "../types";

export function createDeepSeekAdapter(
  transport: BbBrowserTransport,
): ProviderAdapter {
  function isNoPageTargetError(error: unknown) {
    return (
      error instanceof Error &&
      error.message.toLowerCase().includes("no page target found")
    );
  }

  async function resolveTab(input?: { tabId?: string; openNew?: boolean }) {
    if (input?.tabId) {
      const tab = await transport.getTab?.(input.tabId);
      if (tab) {
        return tab;
      }
    }

    if (input?.openNew) {
      const opened = await transport.openDeepSeek("https://chat.deepseek.com");
      if (opened) {
        return opened;
      }
    }

    return transport.findDeepSeekTab();
  }

  return {
    providerId: "deepseek-web",
    async bindTab(input): Promise<BindResult> {
      const attemptBind = async (
        attemptInput?: { tabId?: string; openNew?: boolean },
      ): Promise<BindResult> => {
        const tab = await resolveTab(attemptInput);
        const normalizedUrl = assertDeepSeekUrl(tab.url);
        await transport.evaluate(tab.id, INJECTED_BRIDGE_SOURCE);

        return {
          tabId: tab.id,
          url: normalizedUrl,
          loginState: "logged_in",
          bridgeInjected: true,
          pageState: {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
          },
        };
      };

      try {
        return await attemptBind(input);
      } catch (error) {
        if (error instanceof HelperError && error.code === "NOT_BOUND") {
          await transport.openDeepSeek("https://chat.deepseek.com");
          throw new HelperError(
            "NOT_BOUND",
            "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
          );
        }

        if (isNoPageTargetError(error)) {
          try {
            return await attemptBind({ openNew: true });
          } catch (retryError) {
            if (isNoPageTargetError(retryError)) {
              throw new HelperError(
                "NOT_BOUND",
                "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
              );
            }
            throw retryError;
          }
        }

        throw error;
      }
    },
  };
}
