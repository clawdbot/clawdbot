import { initialState, Task, TaskStatus } from "@lit/task";
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
  private eligibleSignature = "";
  private readonly refreshTask: Task;
  private refreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private refreshScheduled = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: SessionPullRequestIndicatorsOptions,
  ) {
    host.addController(this);
    this.refreshTask = new Task(host, {
      autoRun: false,
      // Rows are represented by a deterministic primitive so Lit can shallow-compare args.
      args: () => [null as GatewayBrowserClient | null, "", ""] as const,
      task: async ([client, selectedAgentId, signature], { signal }) => {
        if (!client || !signature) {
          return initialState;
        }
        const eligibleRows = this.options
          .getRows()
          .filter((session) => !session.isChild && session.worktreeId);
        const currentSignature = JSON.stringify(
          eligibleRows.map((session) => [session.key, session.worktreeId]),
        );
        if (currentSignature !== signature) {
          return initialState;
        }
        const entries: Array<readonly [string, IndicatorEntry]> = [];
        for (const session of eligibleRows) {
          if (signal.aborted) {
            break;
          }
          try {
            const state = await fetchSessionPullRequestIndicatorState({
              client,
              pullRequestsAvailable: true,
              sessionKey: session.key,
              agentId: parseAgentSessionKey(session.key)?.agentId ?? selectedAgentId,
            });
            if (state !== null && session.worktreeId) {
              entries.push([session.key, { state, worktreeId: session.worktreeId }]);
            }
          } catch {
            // Optional metadata: preserve the last-known indicator and retry next poll.
          }
        }
        return { client, entries };
      },
      onComplete: ({ client, entries }) => {
        if (this.options.getSnapshot()?.client !== client) {
          return;
        }
        let changed = false;
        for (const [sessionKey, entry] of entries) {
          const current = this.states.get(sessionKey);
          if (current?.state !== entry.state || current.worktreeId !== entry.worktreeId) {
            this.states.set(sessionKey, entry);
            changed = true;
          }
        }
        if (changed) {
          this.host.requestUpdate();
        }
        this.scheduleRefreshTimer();
      },
    });
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
    const shouldInvalidate = this.eligibleSignature !== "";
    this.eligibleSignature = "";
    if (shouldInvalidate) {
      void this.refreshTask.run([null, "", ""]);
    }
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
      const shouldInvalidate = this.eligibleSignature !== "";
      this.eligibleSignature = "";
      this.clearRefreshTimer();
      if (shouldInvalidate) {
        void this.refreshTask.run([null, "", ""]);
      }
      return;
    }

    const signature = JSON.stringify(
      eligibleRows.map((session) => [session.key, session.worktreeId]),
    );
    if (!force && signature === this.eligibleSignature) {
      if (this.refreshTask.status !== TaskStatus.PENDING) {
        this.scheduleRefreshTimer();
      }
      return;
    }
    this.eligibleSignature = signature;
    this.clearRefreshTimer();
    void this.refreshTask.run([snapshot.client, selectedAgentId, signature]);
  }
}
