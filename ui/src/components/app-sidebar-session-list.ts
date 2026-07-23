import type { PropertyValues, TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import { renderSessionList } from "./app-sidebar-session-list-render.ts";
import { AppSidebarSessionNarrationElement } from "./app-sidebar-session-narration-element.ts";
import { renderSessionTree, type SessionListHost } from "./app-sidebar-session-row-render.ts";
import {
  loadStoredSidebarCatalogGrouping,
  storeSidebarCatalogGrouping,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import { renderSessionCreatorFilter } from "./session-owner-chip.ts";

/** Session-list presentation and catalog renderer wiring. */
export abstract class AppSidebarSessionListElement
  extends AppSidebarSessionNarrationElement
  implements SessionListHost
{
  @state() protected catalogProjectGrouping = loadStoredSidebarCatalogGrouping();

  protected override willUpdate(changed: PropertyValues<this>) {
    super.willUpdate(changed);
    // A fresh draft must be visible where it will live: genuinely expand a
    // collapsed Threads section (persisted) instead of overriding at render
    // time, so the header toggle keeps matching the visible state.
    if (
      changed.has("draftSessionAgentId") &&
      this.draftSessionAgentId &&
      this.collapsedSessionSections.has("ungrouped")
    ) {
      this.toggleSection("ungrouped");
    }
  }

  startSessionDrag(session: SidebarRecentSession): void {
    this.draggingSessionKey = session.key;
    this.draggingSidebarEntry = session.pinned ? `session:${session.key}` : null;
  }

  finishSessionDrag(): void {
    this.finishSidebarEntryDrag();
    this.sessionDropTarget = null;
  }

  toggleSessionPin(session: SidebarRecentSession): void {
    void this.patchSession(session, { pinned: !session.pinned });
  }

  toggleSessionMenu(
    session: SidebarRecentSession,
    menuSession: SidebarRecentSession,
    trigger: HTMLElement,
  ): void {
    if (this.sessionMenu?.session.key === session.key) {
      this.closeSessionMenu();
      return;
    }
    const rect = trigger.getBoundingClientRect();
    this.openSessionMenu(menuSession, rect.right, rect.bottom + 4, trigger);
  }

  startSessionGroupDrag(group: string): void {
    this.draggingSessionGroup = group;
  }

  finishSessionGroupDrag(): void {
    this.draggingSessionGroup = null;
    this.sessionGroupDropTarget = null;
  }

  openNewSession(): void {
    this.onOpenNewSession?.(this.expandedAgentId());
  }

  setVisibleSessionLimit(limit: number): void {
    this.visibleSessionLimit = limit;
  }

  dismissSessionMutationError(): void {
    this.sessionMutationError = null;
  }

  toggleCatalogProjectGrouping(): void {
    const next = this.catalogProjectGrouping === "project" ? "none" : "project";
    storeSidebarCatalogGrouping(next);
    this.catalogProjectGrouping = next;
  }

  openCatalogMenu(
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger?: HTMLElement,
  ): void {
    this.catalogMenu.open(request, x, y, trigger);
  }

  protected renderPinnedSidebarSession(session: SidebarRecentSession): TemplateResult {
    return renderSessionTree({
      host: this,
      session,
    });
  }

  protected renderSessions() {
    const navigationState = this.getSessionNavigationState();
    const visibleSessions = this.selectedAgentSessionRows(navigationState);
    const expandedAgentId = this.expandedAgentId();
    const liveRows = [
      ...(this.sessionsResult?.sessions ?? []),
      ...Object.values(this.sessionRowsByAgent).flat(),
    ];
    const sidebarRowsByKey = new Map<string, SidebarRecentSession>();
    for (const row of liveRows) {
      if (!sidebarRowsByKey.has(row.key)) {
        sidebarRowsByKey.set(row.key, navigationState.toSidebarSession(row));
      }
    }
    const { sections, expandedRows, visibleRows } = this.zonedVisibleSections(visibleSessions);
    return renderSessionList({
      host: this,
      empty: visibleSessions.length === 0,
      sections,
      expandedRows,
      visibleRowCount: visibleRows.length,
      showDraft:
        Boolean(this.draftSessionAgentId) &&
        normalizeAgentId(this.draftSessionAgentId) === expandedAgentId,
      creatorFilter: renderSessionCreatorFilter({
        creators: this.sessionOwnershipVisible ? this.sessionCreatorOptions : [],
        selectedId: this.sessionCreatorFilterActive ? this.sessionCreatorFilterId : null,
        onChange: (creatorId) => {
          this.sessionCreatorFilterId = creatorId;
          void this.context?.sessions.setCreatorFilter(creatorId);
        },
      }),
      catalogs: {
        catalogs: this.sessionCatalogs,
        basePath: this.basePath,
        routeSessionKey: this.activeRouteId === "chat" ? this.getRouteSessionKey() : "",
        newSessionAgentId: expandedAgentId,
        loadingMoreCatalogIds: this.loadingMoreSessionCatalogIds,
        projectGrouping: this.catalogProjectGrouping,
        liveRows,
        sidebarRowsByKey,
        creatorId: this.activeSessionCreatorId,
        catalogOpenTarget: this.catalogOpenTarget,
        terminalAvailable: this.terminalAvailable,
      },
    });
  }
}
