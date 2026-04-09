import type { ProviderId } from "../../shared/contracts";
import type { BindResult } from "../browser/types";

export interface ProviderAdapter {
  providerId: ProviderId;
  bindTab(): Promise<BindResult>;
}
