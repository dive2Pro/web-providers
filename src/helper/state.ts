import type {
  ActiveRequest,
  BoundSession,
  ProviderRequestDebugRecord,
} from "./types";
import type { ProviderId } from "../shared/contracts";

export class HelperState {
  private boundSessions = new Map<ProviderId, BoundSession>();
  private activeRequest: ActiveRequest | null = null;
  private lastProviderRequests = new Map<ProviderId, ProviderRequestDebugRecord>();
  private degraded = false;
  private lastBridgeHeartbeatAt: string | null = null;

  getBoundSession(provider?: ProviderId) {
    if (provider) {
      return this.boundSessions.get(provider) ?? null;
    }

    return this.boundSessions.values().next().value ?? null;
  }

  setBoundSession(providerOrSession: ProviderId | BoundSession | null, session?: BoundSession | null) {
    if (
      providerOrSession &&
      typeof providerOrSession === "object" &&
      "provider" in providerOrSession
    ) {
      this.boundSessions.set(providerOrSession.provider, providerOrSession);
      return;
    }

    if (typeof providerOrSession === "string") {
      if (session) {
        this.boundSessions.set(providerOrSession, session);
        return;
      }

      this.boundSessions.delete(providerOrSession);
      return;
    }

    this.boundSessions.clear();
  }

  getActiveRequest() {
    return this.activeRequest;
  }

  setActiveRequest(request: ActiveRequest | null) {
    this.activeRequest = request;
  }

  getLastProviderRequest(provider?: ProviderId) {
    if (provider) {
      return this.lastProviderRequests.get(provider) ?? null;
    }

    return this.lastProviderRequests.values().next().value ?? null;
  }

  setLastProviderRequest(
    providerOrRecord: ProviderId | ProviderRequestDebugRecord | null,
    record?: ProviderRequestDebugRecord | null,
  ) {
    if (
      providerOrRecord &&
      typeof providerOrRecord === "object" &&
      "provider" in providerOrRecord
    ) {
      this.lastProviderRequests.set(providerOrRecord.provider, providerOrRecord);
      return;
    }

    if (typeof providerOrRecord === "string") {
      if (record) {
        this.lastProviderRequests.set(providerOrRecord, record);
        return;
      }

      this.lastProviderRequests.delete(providerOrRecord);
      return;
    }

    this.lastProviderRequests.clear();
  }

  getAllLastProviderRequests() {
    return Object.fromEntries(this.lastProviderRequests.entries());
  }

  hasRunningRequest() {
    return this.activeRequest?.status === "running";
  }

  getDegraded() {
    return this.degraded;
  }

  setDegraded(value: boolean) {
    this.degraded = value;
  }

  getLastBridgeHeartbeatAt() {
    return this.lastBridgeHeartbeatAt;
  }

  setLastBridgeHeartbeatAt(value: string | null) {
    this.lastBridgeHeartbeatAt = value;
  }

  resetRuntime() {
    this.activeRequest = null;
    this.lastProviderRequests.clear();
    this.degraded = false;
    this.lastBridgeHeartbeatAt = null;
  }
}
