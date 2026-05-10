import type { BindResult } from "../../browser/types";
import type { BbBrowserTransport } from "../../browser/bb-browser-client";
import { HelperError } from "../../errors";
import { assertQwenUrl, QWEN_BIND_SCRIPT } from "./page-bridge";
import type { ProviderAdapter } from "../types";

export function createQwenAdapter(
  transport?: BbBrowserTransport,
): ProviderAdapter {
  const qwenTransport = transport;
  function isNoPageTargetError(error: unknown) {
    return (
      error instanceof Error &&
      error.message.toLowerCase().includes("no page target found")
    );
  }

  async function resolveTab(input?: { tabId?: string; openNew?: boolean }) {
    if (!qwenTransport) {
      throw new HelperError(
        "NOT_BOUND",
        "Opened Qwen in bb-browser. Finish login in that page and retry.",
      );
    }

    if (input?.tabId) {
      const tab = await qwenTransport.getTab?.(input.tabId);
      if (tab) {
        return tab;
      }
    }

    if (input?.openNew) {
      const opened = await qwenTransport.openQwen?.("https://chat.qwen.ai/");
      if (opened) {
        return opened;
      }
    }

    if (!qwenTransport.findQwenTab) {
      throw new HelperError(
        "NOT_BOUND",
        "Opened Qwen in bb-browser. Finish login in that page and retry.",
      );
    }

    return qwenTransport.findQwenTab();
  }

  return {
    providerId: "qwen-web",
    async bindTab(input): Promise<BindResult> {
      const attemptBind = async (
        attemptInput?: { tabId?: string; openNew?: boolean },
      ): Promise<BindResult> => {
        const tab = await resolveTab(attemptInput);
        const normalizedUrl = assertQwenUrl(tab.url);
        const pageState = await qwenTransport!.evaluate<BindResult["pageState"]>(
          tab.id,
          QWEN_BIND_SCRIPT,
        );

        return {
          tabId: tab.id,
          url: normalizedUrl,
          loginState: pageState.inputReady ? "logged_in" : "logged_out",
          bridgeInjected: true,
          pageState,
        };
      };

      try {
        return await attemptBind(input);
      } catch (error) {
        if (error instanceof HelperError && error.code === "NOT_BOUND") {
          await qwenTransport?.openQwen?.("https://chat.qwen.ai/");
          throw new HelperError(
            "NOT_BOUND",
            "Opened Qwen in bb-browser. Finish login in that page and retry.",
          );
        }

        if (isNoPageTargetError(error)) {
          try {
            return await attemptBind({ openNew: true });
          } catch (retryError) {
            if (isNoPageTargetError(retryError)) {
              throw new HelperError(
                "NOT_BOUND",
                "Opened Qwen in bb-browser. Finish login in that page and retry.",
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
