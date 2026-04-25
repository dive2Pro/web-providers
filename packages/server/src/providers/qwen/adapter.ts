import type { BindResult } from "../../browser/types";
import type { BbBrowserTransport } from "../../browser/bb-browser-client";
import { HelperError } from "../../errors";
import { assertQwenUrl, QWEN_BIND_SCRIPT } from "./page-bridge";
import type { ProviderAdapter } from "../types";
import type { BindRetryOptions } from "../deepseek/adapter";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openAndWaitForQwenTab(
  transport: BbBrowserTransport,
  opts: BindRetryOptions = {},
): Promise<{ id: string; url: string }> {
  await transport.openQwen?.("https://chat.qwen.ai/");

  const maxWaitMs = opts.maxWaitMs ?? 12_000;
  const retryIntervalMs = opts.retryIntervalMs ?? 800;
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    await sleep(retryIntervalMs);
    try {
      if (!transport.findQwenTab) continue;
      const tab = await transport.findQwenTab();
      if (tab && typeof tab.id === "string") {
        return tab;
      }
    } catch (error) {
      if (error instanceof HelperError && error.code === "NOT_BOUND") {
        continue;
      }
      if (
        error instanceof Error &&
        error.message.toLowerCase().includes("no page target found")
      ) {
        continue;
      }
    }
  }

  throw new HelperError(
    "NOT_BOUND",
    "Opened Qwen in bb-browser. Finish login in that page and retry.",
  );
}

export function createQwenAdapter(
  transport?: BbBrowserTransport,
  retryOptions?: BindRetryOptions,
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
          tab = await openAndWaitForQwenTab(transport, retryOptions);
        } else if (
          error instanceof Error &&
          error.message.toLowerCase().includes("no page target found")
        ) {
          tab = await openAndWaitForQwenTab(transport, retryOptions);
        } else {
          throw error;
        }
      }

      const normalizedUrl = assertQwenUrl(tab.url);
      const pageState = await transport.evaluate<BindResult["pageState"]>(
        tab.id,
        QWEN_BIND_SCRIPT,
      );

      return {
        tabId: tab.id,
        url: normalizedUrl,
        loginState: "logged_in",
        bridgeInjected: true,
        pageState,
      };
    },
  };
}
