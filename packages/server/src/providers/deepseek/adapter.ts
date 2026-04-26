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

async function resolveDeepSeekTab(
  transport: BbBrowserTransport,
  opts: BindRetryOptions = {},
  preferredTabId?: string,
): Promise<{ id: string; url: string }> {
  if (preferredTabId && transport.getTab) {
    const preferredTab = await transport.getTab(preferredTabId);
    if (preferredTab && preferredTab.url.includes("deepseek.com")) {
      return preferredTab;
    }
  }

  try {
    return await transport.findDeepSeekTab();
  } catch (error) {
    if (error instanceof HelperError && error.code === "NOT_BOUND") {
      return openAndWaitForTab(transport, opts);
    }
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("no page target found")
    ) {
      return openAndWaitForTab(transport, opts);
    }
    throw error;
  }
}

export function createDeepSeekAdapter(
  transport: BbBrowserTransport,
  retryOptions?: BindRetryOptions,
): ProviderAdapter {
  return {
    providerId: "deepseek-web",
    async bindTab(input = {}): Promise<BindResult> {
      const tab = await resolveDeepSeekTab(
        transport,
        retryOptions,
        input.preferredTabId,
      );

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
