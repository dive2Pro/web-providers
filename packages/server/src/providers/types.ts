import type { ProviderId } from "@web-providers/shared";
import type { BindResult } from "../browser/types";

export interface ProviderAdapter {
  providerId: ProviderId;
  bindTab(): Promise<BindResult>;
}
