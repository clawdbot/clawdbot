import { html, nothing } from "lit";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { CatalogOpenTarget } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import type { SidebarSessionSection } from "../lib/sessions/grouping.ts";
import type { SessionCatalogGroupsRenderer } from "./app-sidebar-session-catalog-render.ts";
import {
  renderRecentSession,
  renderSessionTree,
  type SessionListHost,
} from "./app-sidebar-session-row-render.ts";
import { renderSidebarSessionSectionHeader } from "./app-sidebar-session-section-header.ts";
import {
  rowDemandsVisibility,
  RowVisibilityReason,
  SIDEBAR_SESSION_PAGE_SIZE,
  SIDEBAR_SESSION_SEE_LESS_THRESHOLD,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";

type RenderableSessionSection = SidebarSessionSection<SidebarRecentSession> & {
  totalRowCount: number;
  visibleRowCount: number;
  visibleLimit: number;
  collapsedVisibleRowCount: number;
  renderHeader: boolean;
};

type SidebarSessionListHost = SessionListHost & {
  loadMoreSidebarSessions(): Promise<void>;
};

type SessionCatalogRenderSnapshot = {
  catalogs: readonly SessionCatalog[];
  basePath: string;
  routeSessionKey: string;
  newSessionAgentId: string;
  mainKey: string;
  loadingMoreCatalogIds: ReadonlySet<string>;
  projectGrouping: CatalogProjectGrouping;
  liveRows: readonly GatewaySessionRow[];
  toSidebarSession: (row: GatewaySessionRow) => SidebarRecentSession;
  ownerId: string | null;
  catalogOpenTarget: CatalogOpenTarget;
  terminalAvailable: boolean;
};

function renderSessionSection(params: {
  host: SidebarSessionListHost;
  section: RenderableSessionSection;
  nativeSessionsHaveMore?: boolean;
}) {
  const { host, section } = params;
  const totalRowCount = section.totalRowCount;
  const group = section.category;
  const personOwner = section.personOwner;
  // Pinned rows render in the nav zone; renderHeader records whether this list
  // section owns collapse UI or sits directly below the global toolbar.
  const collapsed = section.renderHeader && host.collapsedSessionSections.has(section.id);
  const label = personOwner
    ? personOwner.label || personOwner.id
    : section.groups
      ? t("chat.sidebar.groups")
      : section.work
        ? t("chat.sidebar.coding")
        : group
          ? group
          : t("chat.sidebar.otherSessions");
  const zone = personOwner
    ? "person"
    : section.groups
      ? "groups"
      : section.work
        ? "coding"
        : group
          ? "category"
          : "threads";
  // Collapsed Coding still signals live runs so background work stays visible.
  const collapsedRunningDot =
    collapsed &&
    section.work &&
    section.rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.ActiveRun));
  const collapsedAttentionDot =
    collapsed &&
    section.rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.Attention));
  const newSessionAccess = host.readNewSessionAccess();
  const groupWriteAccess = host.readSessionMutationAccess({
    method: "sessions.groups.put",
    requiredScope: "operator.write",
  });
  const sectionDropEnabled = groupWriteAccess.allowed && !personOwner;
  const sectionClass = [
    "sidebar-recent-sessions__group",
    `sidebar-recent-sessions__group--zone-${zone}`,
    collapsed ? "sidebar-recent-sessions__group--collapsed" : "",
    host.sessionOrganizer.draggingSidebarSection === section.id
      ? "sidebar-recent-sessions__group--dragging"
      : "",
    host.sessionOrganizer.sessionDropTarget === section.id
      ? "sidebar-recent-sessions__group--session-drop"
      : "",
    host.sessionOrganizer.sidebarSectionDropTarget?.sectionId === section.id
      ? `sidebar-recent-sessions__group--section-drop-${host.sessionOrganizer.sidebarSectionDropTarget.position}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div
      class=${sectionClass}
      data-session-section=${section.id}
      data-zone=${zone}
      @dragover=${sectionDropEnabled
        ? (event: DragEvent) => host.sectionDragOver(event, section.id, group)
        : nothing}
      @dragleave=${sectionDropEnabled
        ? (event: DragEvent) => host.sectionDragLeave(event, section.id, group)
        : nothing}
      @drop=${sectionDropEnabled
        ? (event: DragEvent) => host.sectionDrop(event, section.id, group)
        : nothing}
    >
      ${section.renderHeader
        ? renderSidebarSessionSectionHeader({
            sectionId: section.id,
            draggable: !personOwner,
            disabledReason: groupWriteAccess.allowed ? undefined : groupWriteAccess.reason,
            onStartDrag: (sectionId) => host.startSidebarSectionDrag(sectionId),
            onFinishDrag: () => host.finishSidebarSectionDrag(),
            onContextMenu: group
              ? (event: MouseEvent) => {
                  event.preventDefault();
                  host.sidebarMenus.openSessionGroupMenu(group, event.clientX, event.clientY, null);
                }
              : undefined,
            content: html`
              <button
                type="button"
                class="sidebar-session-group-toggle"
                aria-expanded=${String(!collapsed)}
                aria-label=${label}
                @click=${() => host.toggleSection(section.id)}
              >
                <span class="sidebar-session-group-toggle__lead" aria-hidden="true">
                  <span class="sidebar-session-group-toggle__icon"
                    >${collapsed ? icons.chevronRight : icons.chevronDown}</span
                  >
                </span>
                ${personOwner
                  ? html`<openclaw-viewer-avatar
                      .user=${{
                        id: personOwner.id,
                        name: personOwner.label,
                        avatarUrl: personOwner.avatarUrl,
                        watchedSessions: [],
                      }}
                      .markAsViewer=${false}
                      variant="session"
                      aria-hidden="true"
                    ></openclaw-viewer-avatar>`
                  : nothing}
                <span class="sidebar-recent-sessions__label-text">${label}</span>
                ${collapsed && totalRowCount > 0
                  ? html`<span class="sidebar-session-group-count">${totalRowCount}</span>`
                  : nothing}
                ${collapsedRunningDot
                  ? html`<span
                      class="session-run-spinner sidebar-session-group-running"
                      role="img"
                      aria-label=${t("sessionsView.activeRun")}
                      title=${t("sessionsView.activeRun")}
                    ></span>`
                  : nothing}
                ${collapsedAttentionDot
                  ? html`<span
                      class="sidebar-session-group-attention"
                      role="img"
                      aria-label=${t("sessionsView.attentionRequired")}
                      title=${t("sessionsView.attentionRequired")}
                    ></span>`
                  : nothing}
              </button>
              ${group
                ? html`
                    <button
                      type="button"
                      class="sidebar-session-group-actions sidebar-new-session"
                      title=${newSessionAccess.allowed
                        ? t("sessionsView.newSessionInGroup", { group })
                        : newSessionAccess.reason}
                      aria-label=${t("sessionsView.newSessionInGroup", { group })}
                      ?disabled=${!newSessionAccess.allowed}
                      @click=${(event: MouseEvent) => {
                        event.stopPropagation();
                        host.openNewSession({ group });
                      }}
                    >
                      ${icons.plus}
                    </button>
                    <button
                      type="button"
                      class="sidebar-session-group-actions"
                      title=${t("sessionsView.groupMenu", { group })}
                      aria-label=${t("sessionsView.groupMenu", { group })}
                      aria-haspopup="menu"
                      aria-expanded=${String(host.sidebarMenus.sessionGroupMenu?.group === group)}
                      @click=${(event: MouseEvent) => {
                        event.stopPropagation();
                        const trigger = event.currentTarget as HTMLElement;
                        const rect = trigger.getBoundingClientRect();
                        host.sidebarMenus.openSessionGroupMenu(
                          group,
                          rect.right,
                          rect.bottom + 4,
                          trigger,
                        );
                      }}
                    >
                      ${icons.moreHorizontal}
                    </button>
                  `
                : nothing}
            `,
          })
        : nothing}
      ${collapsed
        ? nothing
        : html`
            ${section.rows.length > 0
              ? html`<div class="sidebar-recent-sessions__list" role="list" aria-label=${label}>
                  ${section.rows.map((session) => renderSessionTree({ host, session }))}
                </div>`
              : nothing}
            ${renderSessionPagination({
              host,
              section,
              nativeSessionsHaveMore: params.nativeSessionsHaveMore ?? false,
            })}
          `}
    </div>
  `;
}

function renderSessionPagination(params: {
  host: SidebarSessionListHost;
  section: RenderableSessionSection;
  nativeSessionsHaveMore: boolean;
}) {
  const { host, section } = params;
  const canLoadMore = section.id === "ungrouped" && params.nativeSessionsHaveMore;
  const canShowMore = section.visibleRowCount < section.totalRowCount || canLoadMore;
  const canShowLess =
    section.visibleRowCount > SIDEBAR_SESSION_SEE_LESS_THRESHOLD &&
    section.visibleRowCount > section.collapsedVisibleRowCount;
  if (!canShowMore && !canShowLess) {
    return nothing;
  }
  return html`
    <div class="sidebar-session-pagination">
      ${canShowMore
        ? html`<button
            type="button"
            class="sidebar-session-pagination__button"
            aria-label=${t("chat.selectors.loadMoreSessions")}
            @click=${() => {
              const nextLimit = section.visibleLimit + SIDEBAR_SESSION_PAGE_SIZE;
              host.setVisibleSessionLimit(section.id, nextLimit);
              if (canLoadMore && nextLimit > section.totalRowCount) {
                void host.loadMoreSidebarSessions();
              }
            }}
          >
            ${t("chat.selectors.loadMoreSessions")}
          </button>`
        : nothing}
      ${canShowLess
        ? html`<button
            type="button"
            class="sidebar-session-pagination__button"
            aria-label=${t("usage.details.collapse")}
            @click=${() => {
              host.clearSessionSelection();
              host.setVisibleSessionLimit(section.id, SIDEBAR_SESSION_PAGE_SIZE);
            }}
          >
            ${t("usage.details.collapse")}
          </button>`
        : nothing}
    </div>
  `;
}

function renderSessionCatalog(params: {
  host: SessionListHost;
  snapshot: SessionCatalogRenderSnapshot;
  catalog: SessionCatalog;
  renderer: SessionCatalogGroupsRenderer;
}) {
  const { host, snapshot, catalog, renderer } = params;
  const newSessionAccess = host.readNewSessionAccess();
  const groupWriteAccess = host.readSessionMutationAccess({
    method: "sessions.groups.put",
    requiredScope: "operator.write",
  });
  return html`
    ${renderer({
      catalogs: [catalog],
      connected: host.connected,
      basePath: snapshot.basePath,
      routeSessionKey: snapshot.routeSessionKey,
      newSessionAgentId: snapshot.newSessionAgentId,
      mainKey: snapshot.mainKey,
      collapsedSections: host.collapsedSessionSections,
      loadingMoreCatalogIds: snapshot.loadingMoreCatalogIds,
      projectGrouping: snapshot.projectGrouping,
      liveRows: snapshot.liveRows,
      ownerId: snapshot.ownerId,
      renderLiveRow: (row, display) =>
        renderRecentSession({
          host,
          session: snapshot.toSidebarSession(row),
          display,
        }),
      onToggleSection: (sectionId) => host.toggleSection(sectionId),
      draggingSectionId: host.sessionOrganizer.draggingSidebarSection,
      sectionDropTarget: host.sessionOrganizer.sidebarSectionDropTarget,
      onSectionDragOver: (event, sectionId) => host.sectionDragOver(event, sectionId),
      onSectionDragLeave: (event, sectionId) => host.sectionDragLeave(event, sectionId),
      onSectionDrop: (event, sectionId) => host.sectionDrop(event, sectionId),
      onStartSectionDrag: (sectionId) => host.startSidebarSectionDrag(sectionId),
      onFinishSectionDrag: () => host.finishSidebarSectionDrag(),
      viewMenuOpenCatalogId: host.sidebarMenus.catalogViewMenuPosition?.catalogId ?? null,
      ownerFilterActive: host.sessionOwnerFilterActive,
      onOpenViewMenu: (catalogId, trigger, position) => {
        if (position) {
          host.sidebarMenus.openCatalogViewMenu(catalogId, position.x, position.y, trigger);
          return;
        }
        host.sidebarMenus.toggleCatalogViewMenu(catalogId, trigger);
      },
      onLoadMore: (catalogId) => void host.sessionData.loadMoreSessionCatalog(catalogId),
      onOpenNewSession: (agentId, target) => host.requestOpenNewSession(agentId, target),
      newSessionDisabledReason: newSessionAccess.allowed ? undefined : newSessionAccess.reason,
      sectionDragDisabledReason: groupWriteAccess.allowed ? undefined : groupWriteAccess.reason,
      onNavigate: host.onNavigate,
      catalogOpenTarget: snapshot.catalogOpenTarget,
      terminalAvailable: snapshot.terminalAvailable,
      onOpenTerminal: openCatalogSessionInTerminal,
      onOpenMenu: (request, x, y, trigger) => host.openCatalogMenu(request, x, y, trigger),
      isMenuOpen: (key) => host.sidebarMenus.catalogMenu.isOpenFor(key),
    })}
  `;
}

function renderSessionListBody(params: {
  host: SidebarSessionListHost;
  sections: RenderableSessionSection[];
  nativeSessionsHaveMore: boolean;
  catalogs: SessionCatalogRenderSnapshot;
  catalogRenderer: SessionCatalogGroupsRenderer | null;
}) {
  const { host } = params;
  const catalogsBySectionId = new Map(
    params.catalogs.catalogs.map((catalog) => [`catalog:${catalog.id}`, catalog]),
  );
  return html`
    ${params.sections.map((section) => {
      if (section.id.startsWith("catalog:")) {
        const catalog = catalogsBySectionId.get(section.id);
        return catalog && params.catalogRenderer
          ? renderSessionCatalog({
              host,
              snapshot: params.catalogs,
              catalog,
              renderer: params.catalogRenderer,
            })
          : nothing;
      }
      if (section.id === "work") {
        if (section.totalRowCount === 0) {
          return nothing;
        }
        return renderSessionSection({ host, section });
      }
      // Empty Other remains useful only as a collaborator or drag destination.
      if (
        section.id === "ungrouped" &&
        section.totalRowCount === 0 &&
        !params.nativeSessionsHaveMore &&
        !host.sessionOwnershipVisible &&
        host.sessionsStatusFilter === "active" &&
        host.sessionOrganizer.draggingSessionKey === null
      ) {
        return nothing;
      }
      return renderSessionSection({
        host,
        section,
        nativeSessionsHaveMore: params.nativeSessionsHaveMore,
      });
    })}
  `;
}

function renderSessionListToolbar(host: SidebarSessionListHost) {
  const newSessionAccess = host.readNewSessionAccess();
  const filtered = host.sessionOwnerFilterActive || host.sessionsStatusFilter !== "active";
  return html`
    <div class="sidebar-session-toolbar">
      <span class="sidebar-recent-sessions__label-text">${t("chat.sidebar.threads")}</span>
      <button
        type="button"
        class="sidebar-session-toolbar__button sidebar-session-sort ${filtered
          ? "sidebar-session-sort--filtered"
          : ""}"
        title=${t("chat.sidebar.sortSessions")}
        aria-label=${t("chat.sidebar.sortSessions")}
        aria-haspopup="menu"
        aria-expanded=${String(host.sidebarMenus.sessionSortMenuPosition !== null)}
        @click=${(event: MouseEvent) =>
          host.sidebarMenus.toggleSessionSortMenu(event.currentTarget as HTMLElement)}
      >
        ${icons.listFilter}
      </button>
      <button
        type="button"
        class="sidebar-session-toolbar__button sidebar-new-session"
        title=${newSessionAccess.allowed
          ? t("chat.runControls.newSession")
          : newSessionAccess.reason}
        aria-label=${t("chat.runControls.newSession")}
        ?disabled=${!newSessionAccess.allowed}
        @click=${() => host.openNewSession()}
      >
        ${icons.plus}
      </button>
    </div>
  `;
}

export function renderSessionList(params: {
  host: SidebarSessionListHost;
  empty: boolean;
  sections: RenderableSessionSection[];
  nativeSessionsHaveMore: boolean;
  catalogs: SessionCatalogRenderSnapshot;
  catalogRenderer: SessionCatalogGroupsRenderer | null;
}) {
  const { host } = params;
  return html`
    <section
      class="sidebar-sessions ${host.sessionOrganizer.sessionListRemovalDrop
        ? "sidebar-sessions--removal-drop"
        : ""}"
      @dragover=${(event: DragEvent) => host.handleSessionListDragOver(event)}
      @dragleave=${(event: DragEvent) => host.handleSessionListDragLeave(event)}
      @drop=${(event: DragEvent) => host.handleSessionListDrop(event)}
    >
      ${renderSessionListToolbar(host)}
      ${host.sessionData.sessionMutationError
        ? html`
            <div
              class="sidebar-session-error callout danger callout--dismissible"
              role="alert"
              data-sidebar-session-error
            >
              <span class="callout__content">${host.sessionData.sessionMutationError}</span>
              <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
                <button
                  class="callout__dismiss"
                  type="button"
                  @click=${() => host.dismissSessionMutationError()}
                  aria-label=${t("chat.actions.dismissError")}
                >
                  ${icons.x}
                </button>
              </openclaw-tooltip>
            </div>
          `
        : nothing}
      <div class="sidebar-recent-sessions">
        ${renderSessionListBody({
          host,
          sections: params.sections,
          nativeSessionsHaveMore: params.nativeSessionsHaveMore,
          catalogs: params.catalogs,
          catalogRenderer: params.catalogRenderer,
        })}
        ${host.sessionsStatusFilter === "archived" && params.empty
          ? html`<span class="sidebar-session-empty-hint"
              >${t("sessionsView.noArchivedSessions")}</span
            >`
          : nothing}
      </div>
    </section>
  `;
}
