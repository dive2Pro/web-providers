import type {
  ActiveRequest,
  BoundSession,
  PersistedSessionBindingSession,
  ProviderRequestDebugRecord,
  SessionBindingDebugRecord,
  SessionStateMeta,
} from "./types";
import { getBoundSessionKey } from "./types";
import type { ProviderId } from "../shared/contracts";

const DEFAULT_SESSION_ID = "__default__";

export class HelperState {
  private boundSessionsBySession = new Map<string, Map<string, BoundSession>>();
  private sessionMeta = new Map<string, SessionStateMeta>();
  private activeRequestsByTabId = new Map<string, ActiveRequest>();
  private runningBindings = new Set<string>();
  private lastProviderRequests = new Map<ProviderId, ProviderRequestDebugRecord>();
  private degraded = false;
  private lastBridgeHeartbeatAt: string | null = null;

  private getBindingKey(
    sessionId: string,
    provider: ProviderId,
    modelId?: string | null,
  ) {
    return `${sessionId}::${getBoundSessionKey({ provider, modelId })}`;
  }

  private getOrCreateSessionBindings(sessionId: string) {
    const existing = this.boundSessionsBySession.get(sessionId);
    if (existing) {
      return existing;
    }

    const next = new Map<string, BoundSession>();
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

  getAllSessionBindingDebugRecords() {
    const records: SessionBindingDebugRecord[] = [];

    for (const [sessionId, meta] of this.sessionMeta.entries()) {
      const bindings = this.boundSessionsBySession.get(sessionId);
      if (!bindings || bindings.size === 0) {
        continue;
      }

      const bindingEntries = [...bindings.values()].sort((left, right) =>
        getBoundSessionKey(left).localeCompare(getBoundSessionKey(right)),
      );

      const providers = Object.fromEntries(
        bindingEntries.map((session) => [
          session.provider,
          {
            tabId: session.tabId,
            tabUrl: session.tabUrl,
            conversationId: session.conversationId,
            loginState: session.loginState,
            bridgeInjected: session.bridgeInjected,
          },
        ]),
      ) as SessionBindingDebugRecord["providers"];

      records.push({
        sessionId,
        createdAt: meta.createdAt,
        lastSeenAt: meta.lastSeenAt,
        bindings: bindingEntries.map((session) => ({
          bindingKey: getBoundSessionKey(session),
          provider: session.provider,
          modelId: session.modelId,
          tabId: session.tabId,
          tabUrl: session.tabUrl,
          conversationId: session.conversationId,
          loginState: session.loginState,
          bridgeInjected: session.bridgeInjected,
          providerInitialized: session.providerInitialized,
        })),
        providers,
      });
    }

    return records.sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId),
    );
  }

  getSessionBoundSession(
    sessionId: string,
    provider?: ProviderId,
    modelId?: string | null,
  ) {
    const bindings = this.boundSessionsBySession.get(sessionId);
    if (!bindings) {
      return null;
    }

    if (provider) {
      return bindings.get(getBoundSessionKey({ provider, modelId })) ?? null;
    }

    return bindings.values().next().value ?? null;
  }

  getProviderFallbackBoundSession(sessionId: string, provider: ProviderId) {
    return this.getSessionBoundSession(sessionId, provider, null);
  }

  getAllSessionBoundSessions(sessionId: string) {
    const bindings = this.boundSessionsBySession.get(sessionId);
    return bindings ? new Map(bindings) : new Map<string, BoundSession>();
  }

  getAllProviderBoundSessions(sessionId: string, provider: ProviderId) {
    const bindings = this.boundSessionsBySession.get(sessionId);
    if (!bindings) {
      return [];
    }

    return [...bindings.values()].filter((session) => session.provider === provider);
  }

  setSessionBoundSession(sessionId: string, session: BoundSession) {
    this.touchSession(sessionId);
    this.getOrCreateSessionBindings(sessionId).set(
      getBoundSessionKey(session),
      session,
    );
  }

  clearSessionBoundSession(
    sessionId: string,
    provider: ProviderId,
    modelId?: string | null,
  ) {
    const bindings = this.boundSessionsBySession.get(sessionId);
    bindings?.delete(getBoundSessionKey({ provider, modelId }));
    if (bindings && bindings.size === 0) {
      this.boundSessionsBySession.delete(sessionId);
    }
  }

  clearProviderBoundSessions(sessionId: string, provider: ProviderId) {
    const bindings = this.boundSessionsBySession.get(sessionId);
    if (!bindings) {
      return;
    }

    for (const [bindingKey, session] of bindings.entries()) {
      if (session.provider === provider) {
        bindings.delete(bindingKey);
      }
    }

    if (bindings.size === 0) {
      this.boundSessionsBySession.delete(sessionId);
    }
  }

  clearSessionState(sessionId: string) {
    this.boundSessionsBySession.delete(sessionId);
    this.sessionMeta.delete(sessionId);
  }

  hydrateSessionBindings(sessions: PersistedSessionBindingSession[]) {
    this.boundSessionsBySession.clear();
    this.sessionMeta.clear();

    for (const session of sessions) {
      this.sessionMeta.set(session.sessionId, session.meta);

      const bindings = new Map<string, BoundSession>();
      for (const binding of session.bindings) {
        const normalizedSession: BoundSession = {
          ...binding,
          modelId: binding.modelId,
        };
        bindings.set(getBoundSessionKey(normalizedSession), normalizedSession);
      }

      if (bindings.size > 0) {
        this.boundSessionsBySession.set(session.sessionId, bindings);
      }
    }
  }

  exportSessionBindings() {
    const sessions: PersistedSessionBindingSession[] = [];

    for (const [sessionId, meta] of this.sessionMeta.entries()) {
      const bindings = this.boundSessionsBySession.get(sessionId);
      if (!bindings || bindings.size === 0) {
        continue;
      }

      sessions.push({
        sessionId,
        meta,
        bindings: [...bindings.values()].sort((left, right) =>
          getBoundSessionKey(left).localeCompare(getBoundSessionKey(right)),
        ),
      });
    }

    return sessions.sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId),
    );
  }

  getBoundSession(provider?: ProviderId, modelId?: string | null) {
    return this.getSessionBoundSession(DEFAULT_SESSION_ID, provider, modelId);
  }

  setBoundSession(session: BoundSession) {
    this.setSessionBoundSession(DEFAULT_SESSION_ID, session);
  }

  hasAnyBoundSession() {
    for (const bindings of this.boundSessionsBySession.values()) {
      if (bindings.size > 0) {
        return true;
      }
    }

    return false;
  }

  getActiveRequest(tabId?: string) {
    if (tabId) {
      return this.activeRequestsByTabId.get(tabId) ?? null;
    }

    return this.activeRequestsByTabId.values().next().value ?? null;
  }

  setActiveRequest(tabId: string, request: ActiveRequest | null) {
    if (request) {
      this.activeRequestsByTabId.set(tabId, request);
      return;
    }

    this.activeRequestsByTabId.delete(tabId);
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

  hasRunningRequest(tabId?: string) {
    if (tabId) {
      return this.activeRequestsByTabId.get(tabId)?.status === "running";
    }

    for (const request of this.activeRequestsByTabId.values()) {
      if (request.status === "running") {
        return true;
      }
    }

    return false;
  }

  tryAcquireBinding(
    sessionId: string,
    provider: ProviderId,
    modelId?: string | null,
  ) {
    const key = this.getBindingKey(sessionId, provider, modelId);
    if (this.runningBindings.has(key)) {
      return false;
    }

    this.runningBindings.add(key);
    return true;
  }

  releaseBinding(
    sessionId: string,
    provider: ProviderId,
    modelId?: string | null,
  ) {
    this.runningBindings.delete(this.getBindingKey(sessionId, provider, modelId));
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
    this.activeRequestsByTabId.clear();
    this.runningBindings.clear();
    this.lastProviderRequests.clear();
    this.degraded = false;
    this.lastBridgeHeartbeatAt = null;
  }
}
