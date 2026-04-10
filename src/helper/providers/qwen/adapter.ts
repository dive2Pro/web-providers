import type { BindResult } from "../../browser/types";
import type { BbBrowserTransport } from "../../browser/bb-browser-client";
import { HelperError } from "../../errors";
import { assertQwenUrl, QWEN_BIND_SCRIPT } from "./page-bridge";
import type { ProviderAdapter } from "../types";

export function createQwenAdapter(
  transport?: BbBrowserTransport,
): ProviderAdapter {
  return {
    providerId: "qwen-web",
    async bindTab(): Promise<BindResult> {
      if (!transport?.findQwenTab) {
        throw new HelperError(
          "NOT_BOUND",
          "Opened Qwen in bb-browser. Finish login in that page and retry.",
        );
      }

      let tab: { id: string; url: string };

      try {
        tab = await transport.findQwenTab();
      } catch (error) {
        if (error instanceof HelperError && error.code === "NOT_BOUND") {
          await transport.openQwen?.("https://chat.qwen.ai/");
          throw new HelperError(
            "NOT_BOUND",
            "Opened Qwen in bb-browser. Finish login in that page and retry.",
          );
        }

        if (
          error instanceof Error &&
          error.message.toLowerCase().includes("no page target found")
        ) {
          await transport.openQwen?.("https://chat.qwen.ai/");
          throw new HelperError(
            "NOT_BOUND",
            "Opened Qwen in bb-browser. Finish login in that page and retry.",
          );
        }

        throw error;
      }

      const normalizedUrl = assertQwenUrl(tab.url);
      const pageState = await transport.evaluate<BindResult["pageState"]>(
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
    },
  };
}
