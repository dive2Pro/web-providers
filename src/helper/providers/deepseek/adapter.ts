import type { BindResult } from "../../browser/types";
import type { BbBrowserTransport } from "../../browser/bb-browser-client";
import { HelperError } from "../../errors";
import {
  assertDeepSeekUrl,
  INJECTED_BRIDGE_SOURCE,
} from "./page-bridge";
import type { ProviderAdapter } from "../types";

const DEEPSEEK_PAGE_STATE_SCRIPT =
  `${INJECTED_BRIDGE_SOURCE}; window.__piDeepSeekBridge.getPageState()`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDeepSeekAdapter(
  transport: BbBrowserTransport,
): ProviderAdapter {
  function isNoPageTargetError(error: unknown) {
    return (
      error instanceof Error &&
      error.message.toLowerCase().includes("no page target found")
    );
  }

  async function resolveTab(input?: {
    tabId?: string;
    openNew?: boolean;
    openUrl?: string;
    passive?: boolean;
  }) {
    if (input?.tabId) {
      const tab = await transport.getTab?.(input.tabId);
      if (tab) {
        return tab;
      }
    }

    if (input?.openUrl && transport.findTabByUrl) {
      const tab = await transport.findTabByUrl(input.openUrl);
      if (tab) {
        return tab;
      }
    }

    if (input?.openNew) {
      const opened = await transport.openDeepSeek(
        input.openUrl ?? "https://chat.deepseek.com",
      );
      if (opened) {
        return opened;
      }

      throw new HelperError(
        "NOT_BOUND",
        "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
      );
    }

    return transport.findDeepSeekTab();
  }

  async function waitForReadyPageState(tabId: string) {
    const timeoutMs = 10_000;
    const pollMs = 250;
    const startedAt = Date.now();
    let lastState: BindResult["pageState"] | null = null;
    const fallbackState = {
      inputReady: false,
      busy: false,
      latestAssistantPreview: null,
      assistantCount: 0,
      blockingMessage: "DeepSeek tab is still loading. Wait for the page to finish loading.",
    } satisfies BindResult["pageState"];

    while (Date.now() - startedAt <= timeoutMs) {
      const rawState = await transport.evaluate<BindResult["pageState"] | undefined>(
        tabId,
        DEEPSEEK_PAGE_STATE_SCRIPT,
      );
      const pageState =
        rawState &&
        typeof rawState === "object" &&
        "inputReady" in rawState &&
        "busy" in rawState &&
        "assistantCount" in rawState
          ? rawState
          : null;

      if (!pageState) {
        await sleep(pollMs);
        continue;
      }

      lastState = pageState;

      if (pageState.inputReady || pageState.blockingMessage) {
        return pageState;
      }

      await sleep(pollMs);
    }

    return lastState ?? fallbackState;
  }

  return {
    providerId: "deepseek-web",
    async bindTab(input): Promise<BindResult> {
      const attemptBind = async (
        attemptInput?: {
          tabId?: string;
          openNew?: boolean;
          openUrl?: string;
          passive?: boolean;
        },
      ): Promise<BindResult> => {
        const tab = await resolveTab(attemptInput);
        const normalizedUrl = assertDeepSeekUrl(tab.url);
        await transport.evaluate(tab.id, INJECTED_BRIDGE_SOURCE);
        const pageState = await waitForReadyPageState(tab.id);

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
          if (input?.passive || input?.openNew || input?.tabId || input?.openUrl) {
            throw error;
          }

          await transport.openDeepSeek("https://chat.deepseek.com");
          throw new HelperError(
            "NOT_BOUND",
            "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
          );
        }

        if (isNoPageTargetError(error)) {
          try {
            return await attemptBind({ openNew: true, openUrl: input?.openUrl });
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
