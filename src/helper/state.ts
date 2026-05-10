import type {
  ActiveRequest,
  BoundSession,
  ProviderRequestDebugRecord,
  SessionStateMeta,
} from "./types";
import type { ProviderId } from "../shared/contracts";

const DEFAULT_SESSION_ID = "__default__";

export class HelperState {
  private boundSessionsBySession = new Map<string, Map<ProviderId, BoundSession>>();
  private sessionMeta = new Map<string, SessionStateMeta>();
  private activeRequest: ActiveRequest | null = null;
  private lastProviderRequests = new Map<ProviderId, ProviderRequestDebugRecord>();
  private degraded = false;
  private lastBridgeHeartbeatAt: string | null = null;

  private getOrCreateSessionBindings(sessionId: string) {
    const existing = this.boundSessionsBySession.get(sessionId);
    if (existing) {
      return existing;
    }

    const next = new Map<ProviderId, BoundSession>();
    this.boundSessionsBySession.set(sessionId, next);
    return next;
  }

  private ensureSessionMeta(sessionId: string) {
    const now = new Date().toISOString();
    const existing = this.sessionMeta.get(sessionId);
    if (existing) {
      existing.lastSeenAt = now;
      return existing;
    }

    const created: SessionStateMeta = {
      sessionId,
      createdAt: now,
      lastSeenAt: now,
    };
    this.sessionMeta.set(sessionId, created);
    return created;
  }

  touchSession(sessionId: string) {
    return this.ensureSessionMeta(sessionId);
  }

  getSessionState(sessionId: string) {
    return this.sessionMeta.get(sessionId) ?? null;
  }

  getSessionBoundSession(sessionId: string, provider?: ProviderId) {
    const bindings = this.boundSessionsBySession.get(sessionId);
    if (!bindings) {
      return null;
    }

    if (provider) {
      return bindings.get(provider) ?? null;
    }

    return bindings.values().next().value ?? null;
  }

  getAllSessionBoundSessions(sessionId: string) {
    const bindings = this.boundSessionsBySession.get(sessionId);
    return bindings ? new Map(bindings) : new Map<ProviderId, BoundSession>();
  }

  setSessionBoundSession(
    sessionId: string,
    providerOrSession: ProviderId | BoundSession | null,
    session?: BoundSession | null,
  ) {
    if (
      providerOrSession &&
      typeof providerOrSession === "object" &&
      "provider" in providerOrSession
    ) {
      this.touchSession(sessionId);
      this.getOrCreateSessionBindings(sessionId).set(
        providerOrSession.provider,
        providerOrSession,
      );
      return;
    }

    const bindings = this.boundSessionsBySession.get(sessionId);

    if (typeof providerOrSession === "string") {
      if (session) {
        this.touchSession(sessionId);
        this.getOrCreateSessionBindings(sessionId).set(providerOrSession, session);
        return;
      }

      bindings?.delete(providerOrSession);
      if (bindings && bindings.size === 0) {
        this.boundSessionsBySession.delete(sessionId);
      }
      return;
    }

    this.boundSessionsBySession.delete(sessionId);
  }

  clearSessionState(sessionId: string) {
    this.boundSessionsBySession.delete(sessionId);
    this.sessionMeta.delete(sessionId);
  }

  getBoundSession(provider?: ProviderId) {
    return this.getSessionBoundSession(DEFAULT_SESSION_ID, provider);
  }

  setBoundSession(providerOrSession: ProviderId | BoundSession | null, session?: BoundSession | null) {
    this.setSessionBoundSession(DEFAULT_SESSION_ID, providerOrSession, session);
  }

  hasAnyBoundSession() {
    for (const bindings of this.boundSessionsBySession.values()) {
      if (bindings.size > 0) {
        return true;
      }
    }

    return false;
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
    this.boundSessionsBySession.clear();
    this.sessionMeta.clear();
    this.activeRequest = null;
    this.lastProviderRequests.clear();
    this.degraded = false;
    this.lastBridgeHeartbeatAt = null;
  }
}
