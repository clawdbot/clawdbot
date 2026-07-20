import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import {
  fetchSessionPullRequestIndicatorState,
  type SessionPullRequestIndicatorState,
} from "./session-menu-work.ts";

const REFRESH_MS = 60_000;

type IndicatorEntry = {
  state: SessionPullRequestIndicatorState;
  worktreeId: string;
};

type SessionPullRequestIndicatorsOptions = {
  getConnected: () => boolean;
  getRows: () => readonly SidebarRecentSession[];
  getSelectedAgentId: () => string;
  getSnapshot: () => ApplicationGatewaySnapshot | undefined;
};

/** Polls compact PR state for visible worktree rows; the gateway owns caching. */
export class SessionPullRequestIndicatorsController implements ReactiveController {
  private readonly states = new Map<string, IndicatorEntry>();
  private client: GatewayBrowserClient | null = null;
  private agentId: string | null = null;
  private connected = false;
  private epoch = 0;
  private eligibleSignature = "";
  private refresh: Promise<void> | null = null;
  private refreshAgain = false;
  private refreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private refreshScheduled = false;

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
    this.scheduleRefresh();
  }

  hostDisconnected(): void {
    this.connected = false;
    this.client = null;
    this.agentId = null;
    this.reset(false);
  }

  state(sessionKey: string, worktreeId: string): SessionPullRequestIndicatorState {
    const entry = this.states.get(sessionKey);
    return entry?.worktreeId === worktreeId ? entry.state : "none";
  }

  private scheduleRefresh(): void {
    if (this.refreshScheduled) {
      return;
    }
    this.refreshScheduled = true;
    globalThis.setTimeout(() => {
      this.refreshScheduled = false;
      if (this.connected) {
        this.refreshVisible(false);
      }
    }, 0);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer === null) {
      return;
    }
    globalThis.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private scheduleRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      return;
    }
    this.refreshTimer = globalThis.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshVisible(true);
    }, REFRESH_MS);
  }

  private reset(requestUpdate: boolean): void {
    this.epoch += 1;
    this.eligibleSignature = "";
    this.refreshAgain = false;
    this.clearRefreshTimer();
    if (this.states.size === 0) {
      return;
    }
    this.states.clear();
    if (requestUpdate) {
      this.host.requestUpdate();
    }
  }

  private refreshVisible(force: boolean): void {
    const snapshot = this.options.getSnapshot();
    if (
      !snapshot?.client ||
      !this.options.getConnected() ||
      isGatewayMethodAdvertised(snapshot, "controlUi.sessionPullRequests") !== true
    ) {
      this.client = null;
      this.agentId = null;
      this.reset(true);
      return;
    }
    const selectedAgentId = this.options.getSelectedAgentId();
    if (snapshot.client !== this.client || selectedAgentId !== this.agentId) {
      this.reset(true);
      this.client = snapshot.client;
      this.agentId = selectedAgentId;
    }

    const eligibleRows = this.options
      .getRows()
      .filter((session) => !session.isChild && session.worktreeId);
    const eligibleKeys = new Set(eligibleRows.map((session) => session.key));
    if ([...this.states.keys()].some((sessionKey) => !eligibleKeys.has(sessionKey))) {
      for (const sessionKey of this.states.keys()) {
        if (!eligibleKeys.has(sessionKey)) {
          this.states.delete(sessionKey);
        }
      }
      this.host.requestUpdate();
    }
    if (eligibleRows.length === 0) {
      this.eligibleSignature = "";
      this.clearRefreshTimer();
      return;
    }

    const signature = JSON.stringify(
      eligibleRows.map((session) => [session.key, session.worktreeId]),
    );
    if (!force && signature === this.eligibleSignature) {
      if (this.refresh === null) {
        this.scheduleRefreshTimer();
      }
      return;
    }
    this.eligibleSignature = signature;
    if (this.refresh) {
      this.refreshAgain = true;
      return;
    }

    this.clearRefreshTimer();
    const epoch = this.epoch;
    const refresh = this.load({
      client: snapshot.client,
      selectedAgentId,
      eligibleRows,
      epoch,
      signature,
    });
    this.refresh = refresh;
    void refresh.finally(() => {
      if (this.refresh !== refresh) {
        return;
      }
      this.refresh = null;
      if (!this.connected) {
        return;
      }
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.refreshVisible(true);
        return;
      }
      if (epoch === this.epoch && signature === this.eligibleSignature) {
        this.scheduleRefreshTimer();
      }
    });
  }

  private async load(params: {
    client: GatewayBrowserClient;
    selectedAgentId: string;
    eligibleRows: readonly SidebarRecentSession[];
    epoch: number;
    signature: string;
  }): Promise<void> {
    for (const session of params.eligibleRows) {
      if (!this.isCurrent(params)) {
        return;
      }
      try {
        const indicatorState = await fetchSessionPullRequestIndicatorState({
          client: params.client,
          pullRequestsAvailable: true,
          sessionKey: session.key,
          agentId: parseAgentSessionKey(session.key)?.agentId ?? params.selectedAgentId,
        });
        if (indicatorState === null || !this.isCurrent(params)) {
          continue;
        }
        const worktreeId = session.worktreeId;
        const current = this.states.get(session.key);
        if (
          worktreeId &&
          (current?.state !== indicatorState || current.worktreeId !== worktreeId)
        ) {
          this.states.set(session.key, { state: indicatorState, worktreeId });
          this.host.requestUpdate();
        }
      } catch {
        // Optional metadata: preserve the last-known indicator and retry next poll.
      }
    }
  }

  private isCurrent(params: {
    client: GatewayBrowserClient;
    epoch: number;
    signature: string;
  }): boolean {
    return (
      this.connected &&
      this.options.getConnected() &&
      params.epoch === this.epoch &&
      params.signature === this.eligibleSignature &&
      this.options.getSnapshot()?.client === params.client
    );
  }
}
