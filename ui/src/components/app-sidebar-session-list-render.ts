import { html, nothing } from "lit";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { CatalogOpenTarget } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import {
  projectRootLabel,
  resolveProjectRoot,
  workProjectSectionId,
  type CatalogProjectGrouping,
} from "../lib/sessions/catalog-project-grouping.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import type { SidebarSessionSection } from "../lib/sessions/grouping.ts";
import type { SessionCatalogGroupsRenderer } from "./app-sidebar-session-catalog-render.ts";
import {
  renderRecentSession,
  renderSessionTree,
  type SessionListHost,
} from "./app-sidebar-session-row-render.ts";
import {
  renderSidebarSessionSectionHeader,
  renderSidebarSessionSectionToggle,
  SIDEBAR_SECTION_NO_STATUS,
  type SidebarSectionStatus,
} from "./app-sidebar-session-section-header.ts";
import {
  rowDemandsVisibility,
  RowVisibilityReason,
  SIDEBAR_SESSION_PAGE_SIZE,
  SIDEBAR_SESSION_SEE_LESS_THRESHOLD,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { renderPanelRefreshStatus, type PanelRefreshStatus } from "./panel-refresh-status.ts";

type RenderableSessionSection = SidebarSessionSection<SidebarRecentSession> & {
  totalRowCount: number;
  visibleRowCount: number;
  visibleLimit: number;
  collapsedVisibleRowCount: number;
};

type SidebarSessionListHost = SessionListHost & {
  loadMoreSidebarSessions(): Promise<void>;
};

type SessionCatalogRenderSnapshot = {
  catalogs: readonly SessionCatalog[];
  refreshStatus: PanelRefreshStatus;
  basePath: string;
  routeSessionKey: string;
  newSessionAgentId: string;
  mainKey: string;
  loadingMoreCatalogIds: ReadonlySet<string>;
  projectGrouping: CatalogProjectGrouping;
  liveRows: readonly GatewaySessionRow[];
  toSidebarSession: (row: GatewaySessionRow) => SidebarRecentSession;
  creatorId: string | null;
  catalogOpenTarget: CatalogOpenTarget;
  terminalAvailable: boolean;
};

/** An expanded section shows its rows; collapsed, one dot has to stand in for
    them, and attention outranks a live run because only attention needs acting
    on. Coding is the one zone whose background runs are worth reporting. */
function collapsedSectionStatus(section: RenderableSessionSection): SidebarSectionStatus {
  if (section.rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.Attention))) {
    return { kind: "attention", label: t("sessionsView.attentionRequired") };
  }
  const running =
    section.work &&
    section.rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.ActiveRun));
  return running
    ? { kind: "running", label: t("sessionsView.activeRun") }
    : SIDEBAR_SECTION_NO_STATUS;
}

type WorkProjectGroup = {
  key: string;
  label: string;
  rows: SidebarRecentSession[];
};

/**
 * Coding sessions carry a real checkout or working directory; grouping by it is
 * the difference between one Coding pile and a list of the projects being worked
 * on. A session with neither fact stays in the flat tail rather than being
 * guessed into a project it may not belong to.
 */
function groupWorkSessionsByProject(rows: readonly SidebarRecentSession[]): {
  groups: WorkProjectGroup[];
  ungrouped: SidebarRecentSession[];
} {
  const byPath = new Map<string, WorkProjectGroup>();
  const groups: WorkProjectGroup[] = [];
  const ungrouped: SidebarRecentSession[] = [];
  for (const row of rows) {
    const projectPath = resolveProjectRoot(row.worktree?.repoRoot ?? row.execCwd);
    if (!projectPath) {
      ungrouped.push(row);
      continue;
    }
    let group = byPath.get(projectPath);
    if (!group) {
      group = { key: projectPath, label: projectRootLabel(projectPath), rows: [] };
      byPath.set(projectPath, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return { groups, ungrouped };
}

/**
 * A project heading inside Coding. It shares the section grammar rather than
 * inventing a second one, and carries no row count: the rows are listed
 * directly beneath it, so counting them says nothing.
 */
function renderWorkProjectGroup(host: SidebarSessionListHost, group: WorkProjectGroup) {
  const sectionId = workProjectSectionId(group.key);
  const collapsed = host.collapsedSessionSections.has(sectionId);
  return html`<div
    class="sidebar-session-work-project"
    data-session-work-project=${group.key}
    role="listitem"
  >
    ${renderSidebarSessionSectionToggle({
      label: group.label,
      collapsed,
      status: SIDEBAR_SECTION_NO_STATUS,
      className: "sidebar-session-catalog-project__head",
      labelClassName: "sidebar-session-catalog-project__label",
      title: group.key,
      lead: html`<span class="sidebar-session-group-toggle__lead" aria-hidden="true"
        >${icons.folder}</span
      >`,
      onToggle: () => host.toggleSection(sectionId),
    })}
    ${collapsed
      ? nothing
      : html`<div class="sidebar-recent-sessions__list" role="list" aria-label=${group.label}>
          ${group.rows.map((session) => renderSessionTree({ host, session, project: group.label }))}
        </div>`}
  </div>`;
}

function renderSessionSection(params: {
  host: SidebarSessionListHost;
  section: RenderableSessionSection;
  nativeSessionsHaveMore?: boolean;
}) {
  const { host, section } = params;
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
  const status = collapsed ? collapsedSectionStatus(section) : SIDEBAR_SECTION_NO_STATUS;
  const workProjects = section.work ? groupWorkSessionsByProject(section.rows) : null;
  const newSessionAccess = host.readNewSessionAccess();
  const groupWriteAccess = host.readSessionMutationAccess({
    method: "sessions.groups.put",
    requiredScope: "operator.write",
  });
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
      @dragover=${groupWriteAccess.allowed
        ? (event: DragEvent) => host.sectionDragOver(event, section.id, group)
        : nothing}
      @dragleave=${groupWriteAccess.allowed
        ? (event: DragEvent) => host.sectionDragLeave(event, section.id, group)
        : nothing}
      @drop=${groupWriteAccess.allowed
        ? (event: DragEvent) => host.sectionDrop(event, section.id, group)
        : nothing}
    >
      ${renderSidebarSessionSectionHeader({
        sectionId: section.id,
        status,
        disabledReason: groupWriteAccess.allowed ? undefined : groupWriteAccess.reason,
        onToggle: () => host.toggleSection(section.id),
        onStartDrag: (sectionId) => host.startSidebarSectionDrag(sectionId),
        onFinishDrag: () => host.finishSidebarSectionDrag(),
        onContextMenu: group
          ? (event: MouseEvent) => {
              event.preventDefault();
              host.sidebarMenus.openSessionGroupMenu(group, event.clientX, event.clientY, null);
            }
          : undefined,
        content: html`
          ${renderSidebarSessionSectionToggle({
            label,
            collapsed,
            status,
            count: collapsed ? totalRowCount : undefined,
            onToggle: () => host.toggleSection(section.id),
          })}
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
                  title=${newSessionAccess.allowed
                    ? t("chat.runControls.newSession")
                    : newSessionAccess.reason}
                  aria-label=${t("chat.runControls.newSession")}
                  ?disabled=${!newSessionAccess.allowed}
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
                  ${icons.ellipsis}
                </button>
              `
            : nothing}
        `,
      })}
      ${collapsed
        ? nothing
        : html`
            ${group && totalRowCount === 0
              ? html`<span class="sidebar-session-empty-hint sidebar-session-empty-placeholder"
                  >${t("chat.sidebar.noSessionsForAgent")}</span
                >`
              : nothing}
            ${section.rows.length > 0
              ? html`<div class="sidebar-recent-sessions__list" role="list" aria-label=${label}>
                  ${workProjects
                    ? html`${workProjects.groups.map((project) =>
                        renderWorkProjectGroup(host, project),
                      )}
                      ${workProjects.ungrouped.map((session) =>
                        renderSessionTree({ host, session }),
                      )}`
                    : section.rows.map((session) => renderSessionTree({ host, session }))}
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
      creatorId: snapshot.creatorId,
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
      creatorFilterActive: host.sessionCreatorFilterActive,
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
  const catalogsVisible = host.sessionsStatusFilter !== "archived";
  const catalogsBySectionId = new Map(
    params.catalogs.catalogs.map((catalog) => [`catalog:${catalog.id}`, catalog]),
  );
  const firstCatalogSectionIndex = catalogsVisible
    ? params.sections.findIndex((section) => section.id.startsWith("catalog:"))
    : -1;
  const catalogStatus = catalogsVisible
    ? renderPanelRefreshStatus({
        status: params.catalogs.refreshStatus,
        onRetry: () => void host.sessionData.refreshSessionCatalogs(),
        className: "sidebar-session-error sidebar-session-catalog-error",
      })
    : nothing;
  // Categorized threads still need the global sort and new-thread actions,
  // which belong to Threads even when that section has no rows of its own.
  const hasCategorizedThreads = params.sections.some(
    (section) => Boolean(section.category) && section.totalRowCount > 0,
  );
  return html`
    ${params.sections.map((section, index) => {
      if (section.id.startsWith("catalog:")) {
        const catalog = catalogsBySectionId.get(section.id);
        return html`${index === firstCatalogSectionIndex ? catalogStatus : nothing}${catalog
          ? params.catalogRenderer
            ? renderSessionCatalog({
                host,
                snapshot: params.catalogs,
                catalog,
                renderer: params.catalogRenderer,
              })
            : nothing
          : nothing}`;
      }
      if (section.id === "work") {
        if (section.totalRowCount === 0) {
          return nothing;
        }
        return renderSessionSection({ host, section });
      }
      // Hide an empty Threads header only when it does not own reachable
      // actions for categorized threads, collaborators, or an active drag.
      if (
        section.id === "ungrouped" &&
        section.totalRowCount === 0 &&
        !params.nativeSessionsHaveMore &&
        !hasCategorizedThreads &&
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
    ${firstCatalogSectionIndex < 0 ? catalogStatus : nothing}
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
