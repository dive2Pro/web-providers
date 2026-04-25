import type { BbBrowserTransport } from "../browser/bb-browser-client";
import type { ProviderId } from "@web-providers/shared";
import { createDeepSeekAdapter, type BindRetryOptions } from "./deepseek/adapter";
import { createQwenAdapter } from "./qwen/adapter";
import type { ProviderAdapter } from "./types";

export function createProviderRegistry(
  transport: BbBrowserTransport,
  retryOptions?: BindRetryOptions,
): Record<ProviderId, ProviderAdapter> {
  return {
    "deepseek-web": createDeepSeekAdapter(transport, retryOptions),
    "qwen-web": createQwenAdapter(transport, retryOptions),
  };
}
