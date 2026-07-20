import { state } from "lit/decorators.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { compareSessionRowsByUpdatedAt } from "../lib/sessions/index.ts";
import { AppSidebarSessionAttentionElement } from "./app-sidebar-session-attention.ts";
import { adoptedCatalogSessionKeys } from "./app-sidebar-session-catalogs.ts";
import { SessionPullRequestIndicatorsController } from "./app-sidebar-session-pr-indicators.ts";
import type { SidebarRecentSession, SidebarSessionSortMode } from "./app-sidebar-session-types.ts";

/** Shared ordering and PR-state projection used by sidebar navigation. */
export abstract class AppSidebarSessionProjectionElement extends AppSidebarSessionAttentionElement {
  @state() protected sessionSortMode: SidebarSessionSortMode = "created";

  private readonly sessionPullRequestIndicators = new SessionPullRequestIndicatorsController(this, {
    getConnected: () => this.connected,
    getRows: () => this.visibleSessionPullRequestRows(),
    getSelectedAgentId: () => this.selectedAgentIdForSessions(),
    getSnapshot: () => this.context?.gateway.snapshot,
  });

  protected readonly compareSidebarSessionRows = (
    a: SessionsListResult["sessions"][number],
    b: SessionsListResult["sessions"][number],
  ) => {
    if (this.sessionSortMode === "updated") {
      return compareSessionRowsByUpdatedAt(a, b);
    }
    return (
      (this.sessionCreatedOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
      (this.sessionCreatedOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER)
    );
  };

  protected promoteCreatedSession(sessionKey: string) {
    const currentOrder = this.sessionCreatedOrder.get(sessionKey);
    if (currentOrder === 0) {
      return;
    }
    for (const [key, order] of this.sessionCreatedOrder) {
      if (key !== sessionKey && (currentOrder === undefined || order < currentOrder)) {
        this.sessionCreatedOrder.set(key, order + 1);
      }
    }
    this.sessionCreatedOrder.set(sessionKey, 0);
    this.requestUpdate();
  }

  protected sessionPullRequestIndicatorState(sessionKey: string, worktreeId: string) {
    return this.sessionPullRequestIndicators.state(sessionKey, worktreeId);
  }

  private visibleSessionPullRequestRows(): SidebarRecentSession[] {
    const rows = this.visibleSessionRowsInOrder();
    const adopted = adoptedCatalogSessionKeys(this.sessionCatalogs);
    if (adopted.size === 0) {
      return rows;
    }
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const liveRows = [
      ...(this.sessionsResult?.sessions ?? []),
      ...Object.values(this.sessionRowsByAgent).flat(),
    ];
    for (const row of liveRows) {
      if (adopted.has(row.key) && !byKey.has(row.key)) {
        byKey.set(row.key, this.projectSidebarSession(row));
      }
    }
    return [...byKey.values()];
  }

  protected abstract visibleSessionRowsInOrder(): SidebarRecentSession[];
  protected abstract projectSidebarSession(row: GatewaySessionRow): SidebarRecentSession;
}
