import type { BbBrowserTransport } from "../browser/bb-browser-client";
import type { ProviderId } from "@web-providers/shared";
import { createDeepSeekAdapter } from "./deepseek/adapter";
import { createQwenAdapter } from "./qwen/adapter";
import type { ProviderAdapter } from "./types";

export function createProviderRegistry(
  transport: BbBrowserTransport,
): Record<ProviderId, ProviderAdapter> {
  return {
    "deepseek-web": createDeepSeekAdapter(transport),
    "qwen-web": createQwenAdapter(transport),
  };
}
