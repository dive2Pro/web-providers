import type { BindResult } from "../../browser/types";
import type { BbBrowserTransport } from "../../browser/bb-browser-client";
import { HelperError } from "../../errors";
import {
  assertDeepSeekUrl,
  INJECTED_BRIDGE_SOURCE,
} from "./page-bridge";
import type { ProviderAdapter } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BindRetryOptions {
  maxWaitMs?: number;
  retryIntervalMs?: number;
}

async function openAndWaitForTab(
  transport: BbBrowserTransport,
  opts: BindRetryOptions = {},
): Promise<{ id: string; url: string }> {
  await transport.openDeepSeek("https://chat.deepseek.com");

  const maxWaitMs = opts.maxWaitMs ?? 12_000;
  const retryIntervalMs = opts.retryIntervalMs ?? 800;
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    await sleep(retryIntervalMs);
    try {
      const tab = await transport.findDeepSeekTab();
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
    "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
  );
}

export function createDeepSeekAdapter(
  transport: BbBrowserTransport,
  retryOptions?: BindRetryOptions,
): ProviderAdapter {
  return {
    providerId: "deepseek-web",
    async bindTab(): Promise<BindResult> {
      let tab: { id: string; url: string };

      try {
        tab = await transport.findDeepSeekTab();
      } catch (error) {
        if (error instanceof HelperError && error.code === "NOT_BOUND") {
          tab = await openAndWaitForTab(transport, retryOptions);
        } else if (
          error instanceof Error &&
          error.message.toLowerCase().includes("no page target found")
        ) {
          tab = await openAndWaitForTab(transport, retryOptions);
        } else {
          throw error;
        }
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
