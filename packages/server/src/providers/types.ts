import type { ProviderId } from "@web-providers/shared";
import type { BindResult } from "../browser/types";

export interface ProviderAdapter {
  providerId: ProviderId;
  bindTab(input?: { preferredTabId?: string }): Promise<BindResult>;
}
