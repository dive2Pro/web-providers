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
  return {
    providerId: "deepseek-web",
    async bindTab(): Promise<BindResult> {
      let tab: { id: string; url: string };

      try {
        tab = await transport.findDeepSeekTab();
      } catch (error) {
        if (error instanceof HelperError && error.code === "NOT_BOUND") {
          await transport.openDeepSeek("https://chat.deepseek.com");
          throw new HelperError(
            "NOT_BOUND",
            "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
          );
        }

        if (
          error instanceof Error &&
          error.message.toLowerCase().includes("no page target found")
        ) {
          await transport.openDeepSeek("https://chat.deepseek.com");
          throw new HelperError(
            "NOT_BOUND",
            "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
          );
        }

        throw error;
      }

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
    },
  };
}
