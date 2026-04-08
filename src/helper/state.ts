import type {
  ActiveRequest,
  BoundSession,
  ProviderRequestDebugRecord,
} from "./types";

export class HelperState {
  private boundSession: BoundSession | null = null;
  private activeRequest: ActiveRequest | null = null;
  private lastProviderRequest: ProviderRequestDebugRecord | null = null;
  private degraded = false;
  private lastBridgeHeartbeatAt: string | null = null;

  getBoundSession() {
    return this.boundSession;
  }

  setBoundSession(session: BoundSession | null) {
    this.boundSession = session;
  }

  getActiveRequest() {
    return this.activeRequest;
  }

  setActiveRequest(request: ActiveRequest | null) {
    this.activeRequest = request;
  }

  getLastProviderRequest() {
    return this.lastProviderRequest;
  }

  setLastProviderRequest(record: ProviderRequestDebugRecord | null) {
    this.lastProviderRequest = record;
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
    this.lastProviderRequest = null;
    this.degraded = false;
    this.lastBridgeHeartbeatAt = null;
  }
}
