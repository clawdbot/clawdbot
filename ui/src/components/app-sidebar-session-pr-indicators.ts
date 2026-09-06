import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import {
  summarizeSessionPullRequests,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
  type SessionPullRequestSnapshotStore,
} from "../lib/session-pull-requests.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { parseAgentSessionKey, scopedSessionArtifactKey } from "../lib/sessions/session-key.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type IndicatorEntry = {
  summary: SessionCatalogPullRequestSummary | undefined;
  worktreeId: string;
};

type SessionPullRequestIndicatorsOptions = {
  getConnected: () => boolean;
  getRows: () => readonly SidebarRecentSession[];
  getSelectedAgentId: () => string;
  getGateway: () => ApplicationGateway | undefined;
  getSessions: () => SessionCapability | undefined;
};

/** Projects pushed PR snapshots for the currently visible worktree rows. */
export class SessionPullRequestIndicatorsController implements ReactiveController {
  private readonly states = new Map<string, IndicatorEntry>();
  private gateway: ApplicationGateway | null = null;
  private client: GatewayBrowserClient | null = null;
  private agentId: string | null = null;
  private store: SessionPullRequestSnapshotStore | null = null;
  private stopStoreUpdates: (() => void) | null = null;
  private connected = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: SessionPullRequestIndicatorsOptions,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.connected = true;
  }

  hostUpdated(): void {
    // Reuse the projection before the host releases it in updated(). Changes
    // here can still schedule a follow-up render to clear stale PR summaries.
    if (this.connected) {
      this.refreshVisible();
    }
  }

  hostDisconnected(): void {
    this.connected = false;
    this.releaseStore();
    this.reset(false);
  }

  summary(
    sessionKey: string,
    worktreeId: string,
    initial?: SessionCatalogPullRequestSummary,
  ): SessionCatalogPullRequestSummary | undefined {
    const entry = this.states.get(sessionKey);
    // A ready empty snapshot is authoritative; only seed a row before its first snapshot.
    return entry?.worktreeId === worktreeId ? entry.summary : initial;
  }

  private releaseStore(): void {
    this.store?.unwatch(this);
    this.stopStoreUpdates?.();
    this.stopStoreUpdates = null;
    this.store = null;
    this.gateway = null;
    this.client = null;
    this.agentId = null;
  }

  private reset(requestUpdate: boolean): void {
    if (this.states.size === 0) {
      return;
    }
    this.states.clear();
    if (requestUpdate) {
      this.host.requestUpdate();
    }
  }

  private eligibleRows(): readonly SidebarRecentSession[] {
    return this.options.getRows().filter((session) => !session.isChild && session.worktreeId);
  }

  private scopedKey(sessionKey: string): string {
    return scopedSessionArtifactKey(
      sessionKey,
      parseAgentSessionKey(sessionKey)?.agentId ?? this.options.getSelectedAgentId(),
    );
  }

  private applySnapshots(rows?: readonly SidebarRecentSession[]): void {
    const store = this.store;
    if (!store) {
      return;
    }
    let changed = false;
    for (const session of rows ?? this.eligibleRows()) {
      if (!session.worktreeId) {
        continue;
      }
      const snapshot = store.get(this.scopedKey(session.key));
      // Empty failure snapshots retain the rendered chip; snapshots carrying
      // last-known PRs can also hydrate a newly mounted row.
      if (!snapshot) {
        const removed = this.states.delete(session.key);
        if (removed) {
          const sessions = this.options.getSessions();
          if (sessions) {
            sessions.setPullRequestSummary(
              session.key,
              undefined,
              sessions.capturePullRequestEpoch(session.key),
            );
          }
        }
        changed = removed || changed;
        continue;
      }
      if (snapshot.status !== "ready" && snapshot.pullRequests.length === 0) {
        continue;
      }
      const current = this.states.get(session.key);
      const entry = {
        summary: summarizeSessionPullRequests(snapshot.pullRequests, current?.summary),
        worktreeId: session.worktreeId,
      };
      if (
        !current ||
        current.summary !== entry.summary ||
        current.worktreeId !== entry.worktreeId
      ) {
        this.states.set(session.key, entry);
        changed = true;
      }
    }
    if (changed) {
      this.host.requestUpdate();
    }
  }

  private refreshVisible(): void {
    const gateway = this.options.getGateway();
    if (
      !gateway ||
      !this.options.getConnected() ||
      isGatewayMethodAdvertised(gateway.snapshot, SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD) !== true
    ) {
      this.releaseStore();
      this.reset(true);
      return;
    }
    if (gateway !== this.gateway) {
      this.releaseStore();
      this.gateway = gateway;
      this.store = sessionPullRequestsForGateway(gateway);
      this.stopStoreUpdates = this.store.subscribe(() => this.applySnapshots());
    }
    if (gateway.snapshot.client !== this.client) {
      this.client = gateway.snapshot.client;
      this.reset(true);
    }
    const selectedAgentId = this.options.getSelectedAgentId();
    if (selectedAgentId !== this.agentId) {
      this.agentId = selectedAgentId;
      this.reset(true);
    }

    const eligibleRows = this.eligibleRows();
    const eligibleKeys = new Set(eligibleRows.map((session) => session.key));
    let removed = false;
    for (const sessionKey of this.states.keys()) {
      if (!eligibleKeys.has(sessionKey)) {
        this.states.delete(sessionKey);
        removed = true;
      }
    }
    if (removed) {
      this.host.requestUpdate();
    }
    this.store?.watch(
      this,
      eligibleRows.map((session) => this.scopedKey(session.key)),
    );
    this.applySnapshots(eligibleRows);
  }
}
