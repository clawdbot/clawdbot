import { html, nothing, type TemplateResult } from "lit";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { titleForRoute } from "../app-navigation.ts";
import type { CatalogOpenTarget } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import { writeSessionGroupDragData } from "../lib/sessions/drag.ts";
import type { SidebarSessionSection } from "../lib/sessions/grouping.ts";
import { renderSessionCatalogGroups } from "./app-sidebar-session-catalogs.ts";
import {
  renderRecentSession,
  renderSessionTree,
  type SessionListHost,
} from "./app-sidebar-session-row-render.ts";
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
};

type SessionCatalogRenderSnapshot = {
  catalogs: readonly SessionCatalog[];
  basePath: string;
  routeSessionKey: string;
  newSessionAgentId: string;
  loadingMoreCatalogIds: ReadonlySet<string>;
  projectGrouping: CatalogProjectGrouping;
  liveRows: readonly GatewaySessionRow[];
  sidebarRowsByKey: ReadonlyMap<string, SidebarRecentSession>;
  creatorId: string | null;
  catalogOpenTarget: CatalogOpenTarget;
  terminalAvailable: boolean;
};

function renderSessionSection(params: {
  host: SessionListHost;
  section: RenderableSessionSection;
  trailing?: TemplateResult | typeof nothing;
  showDraft?: boolean;
}) {
  const { host, section } = params;
  const trailing = params.trailing ?? nothing;
  const showDraft = params.showDraft ?? false;
  const totalRowCount = section.totalRowCount;
  const group = section.category;
  // zonedVisibleSections removes pinned rows; AppSidebar renders them through
  // renderPinnedSidebarSession, so every section here has a header.
  const collapsed = host.collapsedSessionSections.has(section.id);
  const label = section.groups
    ? t("chat.sidebar.groups")
    : section.work
      ? t("chat.sidebar.coding")
      : group
        ? group
        : t("chat.sidebar.threads");
  const zone = section.groups ? "groups" : section.work ? "coding" : group ? "category" : "threads";
  // Collapsed Coding still signals live runs so background work stays visible.
  const collapsedRunningDot =
    collapsed &&
    section.work &&
    section.rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.ActiveRun));
  const collapsedAttentionDot =
    collapsed &&
    section.rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.Attention));
  const acceptsSessions =
    host.sessionsGrouping === "category" && (section.id === "ungrouped" || Boolean(group));
  const sectionClass = [
    "sidebar-recent-sessions__group",
    `sidebar-recent-sessions__group--zone-${zone}`,
    collapsed ? "sidebar-recent-sessions__group--collapsed" : "",
    group && host.sessionOrganizer.draggingSessionGroup === group
      ? "sidebar-recent-sessions__group--dragging"
      : "",
    host.sessionOrganizer.sessionDropTarget === section.id
      ? "sidebar-recent-sessions__group--session-drop"
      : "",
    group && host.sessionOrganizer.sessionGroupDropTarget?.group === group
      ? `sidebar-recent-sessions__group--group-drop-${host.sessionOrganizer.sessionGroupDropTarget.position}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div
      class=${sectionClass}
      data-session-section=${section.id}
      @dragover=${acceptsSessions || group
        ? (event: DragEvent) => host.sectionDragOver(event, section.id, group)
        : nothing}
      @dragleave=${acceptsSessions || group
        ? (event: DragEvent) => host.sectionDragLeave(event, section.id, group)
        : nothing}
      @drop=${acceptsSessions || group
        ? (event: DragEvent) => host.sectionDrop(event, section.id, group)
        : nothing}
    >
      ${html`
        <div
          class="sidebar-recent-sessions__head ${group
            ? "sidebar-recent-sessions__head--draggable"
            : ""}"
          draggable=${group ? "true" : "false"}
          @dragstart=${group
            ? (event: DragEvent) => {
                if (event.dataTransfer) {
                  writeSessionGroupDragData(event.dataTransfer, group);
                  host.startSessionGroupDrag(group);
                }
              }
            : nothing}
          @dragend=${group
            ? () => {
                host.finishSessionGroupDrag();
              }
            : nothing}
          @contextmenu=${group
            ? (event: MouseEvent) => {
                event.preventDefault();
                host.sidebarMenus.openSessionGroupMenu(group, event.clientX, event.clientY, null);
              }
            : nothing}
        >
          ${group
            ? html`<span class="sidebar-session-group-drag-handle" aria-hidden="true"></span>`
            : nothing}
          <button
            type="button"
            class="sidebar-session-group-toggle"
            aria-expanded=${String(!collapsed)}
            aria-label=${label}
            @click=${() => host.toggleSection(section.id)}
          >
            <span class="sidebar-recent-sessions__label-text">${label}</span>
            <span class="sidebar-session-group-toggle__icon" aria-hidden="true"
              >${collapsed ? icons.chevronRight : icons.chevronDown}</span
            >
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
          ${section.id === "ungrouped"
            ? html`
                <button
                  type="button"
                  class="sidebar-session-group-actions sidebar-session-sort ${host.sessionCreatorFilterActive
                    ? "sidebar-session-sort--filtered"
                    : ""}"
                  title=${t("chat.sidebar.sortSessions")}
                  aria-label=${t("chat.sidebar.sortSessions")}
                  aria-haspopup="menu"
                  aria-expanded=${String(host.sidebarMenus.sessionSortMenuPosition !== null)}
                  @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    host.sidebarMenus.toggleSessionSortMenu(event.currentTarget as HTMLElement);
                  }}
                >
                  ${icons.listFilter}
                </button>
                <button
                  type="button"
                  class="sidebar-session-group-actions sidebar-new-session"
                  title=${host.connected
                    ? t("chat.runControls.newSession")
                    : t("chat.runControls.newSessionDisconnected")}
                  aria-label=${t("chat.runControls.newSession")}
                  ?disabled=${!host.connected}
                  @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    host.openNewSession();
                  }}
                >
                  ${icons.plus}
                </button>
              `
            : nothing}
          ${group
            ? html`
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
        </div>
      `}
      ${collapsed
        ? nothing
        : html`
            ${section.rows.length > 0 || showDraft
              ? html`<div class="sidebar-recent-sessions__list" role="list" aria-label=${label}>
                  ${showDraft ? renderDraftSessionRow() : nothing}
                  ${section.rows.map((session) => renderSessionTree({ host, session }))}
                </div>`
              : nothing}
            ${renderSessionPagination({ host, section })} ${trailing}
          `}
    </div>
  `;
}

function renderDraftSessionRow() {
  return html`
    <div class="sidebar-recent-session sidebar-recent-session--draft">
      <span class="sidebar-recent-session__link">
        <span class="sidebar-session-indicator" aria-hidden="true">
          <span class="sidebar-session-indicator__dot"></span>
        </span>
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__name">${t("newSession.draftRow")}</span>
        </span>
      </span>
    </div>
  `;
}

function renderSessionPagination(params: {
  host: SessionListHost;
  section: RenderableSessionSection;
}) {
  const { host, section } = params;
  const canShowMore = section.visibleRowCount < section.totalRowCount;
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
              host.setVisibleSessionLimit(
                section.id,
                section.visibleLimit + SIDEBAR_SESSION_PAGE_SIZE,
              );
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

function renderSessionCatalogs(params: {
  host: SessionListHost;
  snapshot: SessionCatalogRenderSnapshot;
}) {
  const { host, snapshot } = params;
  return renderSessionCatalogGroups({
    catalogs: snapshot.catalogs,
    connected: host.connected,
    basePath: snapshot.basePath,
    routeSessionKey: snapshot.routeSessionKey,
    newSessionAgentId: snapshot.newSessionAgentId,
    collapsedSections: host.collapsedSessionSections,
    loadingMoreCatalogIds: snapshot.loadingMoreCatalogIds,
    projectGrouping: snapshot.projectGrouping,
    liveRows: snapshot.liveRows,
    creatorId: snapshot.creatorId,
    renderLiveRow: (row, display) =>
      renderRecentSession({
        host,
        session: snapshot.sidebarRowsByKey.get(row.key)!,
        display,
      }),
    onToggleSection: (sectionId) => host.toggleSection(sectionId),
    onToggleProjectGrouping: () => host.toggleCatalogProjectGrouping(),
    onLoadMore: (catalogId) => void host.sessionData.loadMoreSessionCatalog(catalogId),
    onOpenNewSession: host.onOpenNewSession,
    onNavigate: host.onNavigate,
    catalogOpenTarget: snapshot.catalogOpenTarget,
    terminalAvailable: snapshot.terminalAvailable,
    onOpenTerminal: openCatalogSessionInTerminal,
    onOpenMenu: (request, x, y, trigger) => host.openCatalogMenu(request, x, y, trigger),
  });
}

function renderSessionListBody(params: {
  host: SessionListHost;
  sections: RenderableSessionSection[];
  showDraft: boolean;
  codingTrailing?: TemplateResult | typeof nothing;
  codingTrailingPresent?: boolean;
}) {
  const { host } = params;
  return html`
    ${params.sections.map((section) => {
      const showDraft = section.id === "ungrouped" && params.showDraft;
      if (section.id === "work") {
        // Coding hosts live work/ACP rows plus the CLI catalogs; hide the
        // whole zone when both are empty.
        if (section.totalRowCount === 0 && params.codingTrailingPresent !== true) {
          return nothing;
        }
        return renderSessionSection({
          host,
          section,
          trailing: params.codingTrailing ?? nothing,
        });
      }
      // Threads hides its bare empty header unless it owns the collaborative
      // creator filter; custom categories stay visible as drop targets.
      if (
        section.id === "ungrouped" &&
        section.totalRowCount === 0 &&
        !showDraft &&
        !host.sessionOwnershipVisible &&
        host.sessionsStatusFilter === "active" &&
        host.sessionOrganizer.draggingSessionKey === null
      ) {
        return nothing;
      }
      return renderSessionSection({ host, section, showDraft });
    })}
  `;
}

export function renderSessionList(params: {
  host: SessionListHost;
  empty: boolean;
  sections: RenderableSessionSection[];
  showDraft: boolean;
  catalogs: SessionCatalogRenderSnapshot;
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
      <div class="sidebar-recent-sessions" aria-label=${titleForRoute("sessions")}>
        ${renderSessionListBody({
          host,
          sections: params.sections,
          showDraft: params.showDraft,
          codingTrailing:
            host.sessionsStatusFilter === "archived"
              ? nothing
              : html`${renderSessionCatalogs({ host, snapshot: params.catalogs })}`,
          codingTrailingPresent:
            host.sessionsStatusFilter !== "archived" && params.catalogs.catalogs.length > 0,
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
