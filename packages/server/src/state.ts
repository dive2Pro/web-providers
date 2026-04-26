import type {
  ActiveRequest,
  BoundSession,
  ProviderRequestDebugRecord,
} from "./types";
import type { ProviderId } from "@web-providers/shared";

export class HelperState {
  private boundSessions = new Map<ProviderId, Map<string, BoundSession>>();
  private activeRequest: ActiveRequest | null = null;
  private lastProviderRequests = new Map<ProviderId, ProviderRequestDebugRecord>();
  private degraded = false;
  private lastBridgeHeartbeatAt: string | null = null;

  private getSessionKey(piSessionId?: string | null) {
    return piSessionId ?? "__default__";
  }

  getBoundSession(provider?: ProviderId, piSessionId?: string | null) {
    if (provider) {
      const sessions = this.boundSessions.get(provider);
      if (!sessions) {
        return null;
      }

      if (piSessionId !== undefined && piSessionId !== null) {
        return sessions.get(this.getSessionKey(piSessionId)) ?? null;
      }

      return sessions.values().next().value ?? null;
    }

    for (const sessions of this.boundSessions.values()) {
      const session = sessions.values().next().value;
      if (session) {
        return session;
      }
    }

    return null;
  }

  setBoundSession(session: BoundSession) {
    const providerSessions = this.boundSessions.get(session.provider) ?? new Map();
    providerSessions.set(this.getSessionKey(session.piSessionId), session);
    this.boundSessions.set(session.provider, providerSessions);
  }

  clearBoundSession(provider?: ProviderId, piSessionId?: string | null) {
    if (!provider) {
      this.boundSessions.clear();
      return;
    }

    if (piSessionId === undefined || piSessionId === null) {
      this.boundSessions.delete(provider);
      return;
    }

    const providerSessions = this.boundSessions.get(provider);
    if (!providerSessions) {
      return;
    }

    providerSessions.delete(this.getSessionKey(piSessionId));
    if (providerSessions.size === 0) {
      this.boundSessions.delete(provider);
    }
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
    this.boundSessions.clear();
    this.activeRequest = null;
    this.lastProviderRequests.clear();
    this.degraded = false;
    this.lastBridgeHeartbeatAt = null;
  }
}
