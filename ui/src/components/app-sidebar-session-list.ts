import { html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { titleForRoute } from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import { formatDurationCompact } from "../lib/format.ts";
import { startHoverMarquee, stopHoverMarquee } from "../lib/hover-marquee.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import { writeSessionDragData, writeSessionGroupDragData } from "../lib/sessions/drag.ts";
import { sidebarSectionHasHeader } from "../lib/sessions/grouping.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { AppSidebarMenusElement } from "./app-sidebar-menus.ts";
import {
  type CatalogBackingSessionDisplay,
  renderSessionCatalogGroups,
} from "./app-sidebar-session-catalogs.ts";
import {
  limitSidebarSessionRows,
  loadStoredSidebarCatalogGrouping,
  SIDEBAR_SESSION_PAGE_SIZE,
  SIDEBAR_SESSION_SEE_LESS_THRESHOLD,
  sidebarSessionMetaId,
  storeSidebarCatalogGrouping,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";
import "./elapsed-time.ts";

/** Session-list presentation and catalog renderer wiring. */
export abstract class AppSidebarSessionListElement extends AppSidebarMenusElement {
  @state() protected catalogProjectGrouping = loadStoredSidebarCatalogGrouping();

  private renderSessionState(session: SidebarRecentSession) {
    if (session.hasActiveRun || (session.isChild && session.status === "running")) {
      return html`<span
        class="session-run-spinner sidebar-recent-session__state"
        role="img"
        aria-label=${t("sessionsView.activeRun")}
        title=${t("sessionsView.activeRun")}
      ></span>`;
    }
    if (!session.isChild) {
      return session.unread
        ? html`<span
            class="session-unread-dot sidebar-recent-session__unread"
            role="img"
            aria-label=${t("sessionsView.unread")}
          ></span>`
        : nothing;
    }
    const status = session.status;
    if (!status) {
      return nothing;
    }
    const statusBadge =
      status === "done"
        ? { icon: icons.check, label: t("sessionsView.statusDone") }
        : status === "killed"
          ? { icon: icons.stop, label: t("sessionsView.statusKilled") }
          : status === "timeout"
            ? { icon: icons.alertTriangle, label: t("sessionsView.statusTimeout") }
            : status === "failed"
              ? { icon: icons.alertTriangle, label: t("sessionsView.statusFailed") }
              : null;
    return statusBadge
      ? html`<span
          class="sidebar-child-session__status sidebar-child-session__status--${status}"
          role="img"
          aria-label=${statusBadge.label}
          title=${statusBadge.label}
          >${statusBadge.icon}</span
        >`
      : nothing;
  }

  private renderRecentSession(
    session: SidebarRecentSession,
    display?: CatalogBackingSessionDisplay,
  ) {
    const label = display?.label ?? session.label;
    const subtitle = display
      ? display.subtitle
      : session.subtitle && session.workSession && session.subtitle !== session.label
        ? session.subtitle
        : undefined;
    const meta = display?.meta ?? session.meta;
    const hasTrail = session.isChild && (session.runtimeMs != null || session.startedAt != null);
    const metaId = hasTrail ? sidebarSessionMetaId(session.key) : undefined;
    const menuSession = display ? { ...session, meta } : session;
    const title = display?.title ?? [label, meta].filter(Boolean).join(" · ");
    const rowClass = [
      "sidebar-recent-session",
      "session-row-host",
      session.isChild ? "sidebar-recent-session--child" : "",
      session.visuallyActive ? "sidebar-recent-session--active" : "",
      this.selectedSessionKeys.has(session.key) ? "sidebar-recent-session--selected" : "",
      session.pinned ? "session-row-host--pinned" : "",
      session.hasActiveRun ? "session-row-host--running" : "",
      this.draggingSessionKey === session.key ? "sidebar-recent-session--dragging" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const row = html`
      <div
        class=${rowClass}
        data-session-key=${session.key}
        role="listitem"
        draggable=${session.isChild ? "false" : "true"}
        @dragstart=${session.isChild
          ? nothing
          : (event: DragEvent) => {
              if (event.dataTransfer) {
                writeSessionDragData(event.dataTransfer, session.key);
                this.draggingSessionKey = session.key;
              }
            }}
        @dragend=${session.isChild
          ? nothing
          : () => {
              this.draggingSessionKey = null;
              this.sessionDropTarget = null;
            }}
        @contextmenu=${session.isChild
          ? nothing
          : (event: MouseEvent) => {
              event.preventDefault();
              this.openSessionMenuForRow(menuSession, event.clientX, event.clientY);
            }}
        @mouseenter=${(event: MouseEvent) => startHoverMarquee(event.currentTarget as HTMLElement)}
        @mouseleave=${(event: MouseEvent) => stopHoverMarquee(event.currentTarget as HTMLElement)}
      >
        <a
          href=${session.href}
          class="sidebar-recent-session__link"
          draggable="false"
          title=${title}
          aria-current=${session.visuallyActive ? "page" : nothing}
          aria-describedby=${metaId ?? nothing}
          @click=${(event: MouseEvent) => this.handleSessionRowClick(event, session)}
        >
          <span class="sidebar-recent-session__text">
            <span class="sidebar-recent-session__name hover-marquee">${label}</span>
            ${subtitle
              ? html`<span class="sidebar-recent-session__subtitle">${subtitle}</span>`
              : nothing}
          </span>
          ${this.renderSessionState(session)}
          ${session.isChild ? nothing : renderSessionRowBadges(session)}
        </a>
        ${session.childSessionKeys.length > 0
          ? html`<button
              class="sidebar-child-session-toggle ${session.runningChildCount > 0
                ? "sidebar-child-session-toggle--running"
                : session.failedChildCount > 0
                  ? "sidebar-child-session-toggle--failed"
                  : ""}"
              type="button"
              data-child-session-toggle=${session.key}
              aria-expanded=${String(this.isSessionChildrenExpanded(session))}
              aria-label=${t(
                this.isSessionChildrenExpanded(session)
                  ? "sessionsView.hideChildSessions"
                  : "sessionsView.showChildSessions",
                { count: String(session.childSessionKeys.length), session: label },
              )}
              @click=${() => this.toggleSessionChildren(session)}
            >
              <span class="sidebar-child-session-toggle__icon" aria-hidden="true"
                >${this.isSessionChildrenExpanded(session)
                  ? icons.chevronDown
                  : icons.chevronRight}</span
              >
              ${this.isSessionChildrenExpanded(session)
                ? nothing
                : html`<span class="sidebar-child-session-toggle__count"
                    >${session.childSessionKeys.length}</span
                  >`}
            </button>`
          : nothing}
        <span class="sidebar-recent-session__aside session-row-aside">
          <span class="session-row-trail" id=${metaId ?? nothing}
            >${session.isChild && session.runtimeMs != null
              ? session.hasActiveRun || session.status === "running"
                ? html`<openclaw-elapsed-time
                    .startMs=${session.runtimeSampledAt! - session.runtimeMs}
                  ></openclaw-elapsed-time>`
                : (formatDurationCompact(session.runtimeMs, { spaced: true }) ?? "0ms")
              : session.isChild && session.startedAt != null
                ? html`<openclaw-elapsed-time
                    .startMs=${session.startedAt}
                    .endMs=${session.endedAt ?? null}
                  ></openclaw-elapsed-time>`
                : nothing}</span
          >
          ${session.isChild
            ? nothing
            : html`<span class="session-row-actions">
                <button
                  class="session-action session-action--pin"
                  data-sidebar-session-pin="true"
                  type="button"
                  title=${session.pinned
                    ? t("sessionsView.unpinSession")
                    : t("sessionsView.pinSession")}
                  aria-label=${session.pinned
                    ? t("sessionsView.unpinSession")
                    : t("sessionsView.pinSession")}
                  ?disabled=${!this.connected}
                  @click=${() => void this.patchSession(session, { pinned: !session.pinned })}
                >
                  ${icons.pin}
                </button>
                <button
                  class="session-action"
                  data-session-menu="true"
                  type="button"
                  title=${t("chat.sidebar.openSessionMenu")}
                  aria-label=${t("chat.sidebar.openSessionMenu")}
                  aria-haspopup="menu"
                  aria-expanded=${String(this.sessionMenu?.session.key === session.key)}
                  @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    if (this.sessionMenu?.session.key === session.key) {
                      this.closeSessionMenu();
                      return;
                    }
                    const trigger = event.currentTarget as HTMLElement;
                    const rect = trigger.getBoundingClientRect();
                    this.openSessionMenuForRow(menuSession, rect.right, rect.bottom + 4, trigger);
                  }}
                >
                  ${icons.moreHorizontal}
                </button>
              </span>`}
        </span>
      </div>
    `;
    // Marquee state mutates the row DOM; keying prevents cross-session reuse.
    return keyed(session.key, row);
  }

  private renderSessionTree(session: SidebarRecentSession): TemplateResult {
    const expanded = this.isSessionChildrenExpanded(session);
    return html`<div class="sidebar-session-tree" data-session-tree=${session.key}>
      ${this.renderRecentSession(session)}
      ${expanded
        ? html`<div
            class="sidebar-session-tree__children"
            aria-label=${t("sessionsView.childSessions")}
          >
            ${session.children.map((child) => this.renderSessionTree(child))}
            ${session.loadingChildren && session.children.length === 0
              ? html`<span class="sidebar-session-tree__loading">${t("common.loading")}</span>`
              : nothing}
          </div>`
        : nothing}
    </div>`;
  }

  private renderSessionSection(
    section: {
      id: string;
      category?: string;
      groups?: boolean;
      work?: boolean;
      rows: SidebarRecentSession[];
      /** Pre-pagination size; rows may be page-filtered for rendering. */
      totalRowCount?: number;
    },
    trailing: TemplateResult | typeof nothing = nothing,
  ) {
    const totalRowCount = section.totalRowCount ?? section.rows.length;
    const group = section.category;
    const isPinned = section.id === "pinned";
    const showHeader = sidebarSectionHasHeader(section.id, this.sessionsGrouping);
    const collapsed = showHeader && this.collapsedSessionSections.has(section.id);
    const label = isPinned
      ? t("sessionsView.pinned")
      : section.groups
        ? t("chat.sidebar.groups")
        : section.work
          ? t("chat.sidebar.coding")
          : group
            ? group
            : t("chat.sidebar.threads");
    const zone = isPinned
      ? "pinned"
      : section.groups
        ? "groups"
        : section.work
          ? "coding"
          : group
            ? "category"
            : "threads";
    // Collapsed Coding still signals live runs so background work stays visible.
    const collapsedRunningDot =
      collapsed && section.work && section.rows.some((row) => row.hasActiveRun);
    const acceptsSessions =
      isPinned ||
      (this.sessionsGrouping === "category" && (section.id === "ungrouped" || Boolean(group)));
    const sectionClass = [
      "sidebar-recent-sessions__group",
      `sidebar-recent-sessions__group--zone-${zone}`,
      collapsed ? "sidebar-recent-sessions__group--collapsed" : "",
      group && this.draggingSessionGroup === group
        ? "sidebar-recent-sessions__group--dragging"
        : "",
      this.sessionDropTarget === section.id ? "sidebar-recent-sessions__group--session-drop" : "",
      group && this.sessionGroupDropTarget?.group === group
        ? `sidebar-recent-sessions__group--group-drop-${this.sessionGroupDropTarget.position}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`
      <div
        class=${sectionClass}
        data-session-section=${section.id}
        @dragover=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDragOver(event, section.id, group)
          : nothing}
        @dragleave=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDragLeave(event, section.id, group)
          : nothing}
        @drop=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDrop(event, section.id, group)
          : nothing}
      >
        ${showHeader
          ? html`
              <div
                class="sidebar-recent-sessions__head ${group
                  ? "sidebar-recent-sessions__head--draggable"
                  : ""}"
                draggable=${group ? "true" : "false"}
                @dragstart=${group
                  ? (event: DragEvent) => {
                      if (event.dataTransfer) {
                        writeSessionGroupDragData(event.dataTransfer, group);
                        this.draggingSessionGroup = group;
                      }
                    }
                  : nothing}
                @dragend=${group
                  ? () => {
                      this.draggingSessionGroup = null;
                      this.sessionGroupDropTarget = null;
                    }
                  : nothing}
                @contextmenu=${group
                  ? (event: MouseEvent) => {
                      event.preventDefault();
                      this.openSessionGroupMenu(group, event.clientX, event.clientY, null);
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
                  @click=${() => this.toggleSessionSection(section.id)}
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
                </button>
                ${section.id === "ungrouped"
                  ? html`
                      <button
                        type="button"
                        class="sidebar-session-group-actions sidebar-session-sort"
                        title=${t("chat.sidebar.sortSessions")}
                        aria-label=${t("chat.sidebar.sortSessions")}
                        aria-haspopup="menu"
                        aria-expanded=${String(this.sessionSortMenuPosition !== null)}
                        @click=${(event: MouseEvent) => {
                          event.stopPropagation();
                          this.toggleSessionSortMenu(event.currentTarget as HTMLElement);
                        }}
                      >
                        ${icons.listFilter}
                      </button>
                      <button
                        type="button"
                        class="sidebar-session-group-actions sidebar-new-session"
                        title=${this.connected
                          ? t("chat.runControls.newSession")
                          : t("chat.runControls.newSessionDisconnected")}
                        aria-label=${t("chat.runControls.newSession")}
                        ?disabled=${!this.connected}
                        @click=${(event: MouseEvent) => {
                          event.stopPropagation();
                          this.onOpenNewSession?.(this.expandedAgentId());
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
                        aria-expanded=${String(this.sessionGroupMenu?.group === group)}
                        @click=${(event: MouseEvent) => {
                          event.stopPropagation();
                          const trigger = event.currentTarget as HTMLElement;
                          const rect = trigger.getBoundingClientRect();
                          this.openSessionGroupMenu(group, rect.right, rect.bottom + 4, trigger);
                        }}
                      >
                        ${icons.moreHorizontal}
                      </button>
                    `
                  : nothing}
              </div>
            `
          : nothing}
        ${collapsed
          ? nothing
          : html`
              ${section.rows.length > 0
                ? html`<div class="sidebar-recent-sessions__list" role="list" aria-label=${label}>
                    ${section.rows.map((session) => this.renderSessionTree(session))}
                  </div>`
                : nothing}
              ${trailing}
            `}
      </div>
    `;
  }

  private renderDraftSessionRow() {
    return html`
      <div class="sidebar-recent-session sidebar-recent-session--draft">
        <span class="sidebar-recent-session__link">
          <span class="sidebar-recent-session__text">
            <span class="sidebar-recent-session__name">${t("newSession.draftRow")}</span>
          </span>
        </span>
      </div>
    `;
  }

  private renderSessionListBody(
    rows: SidebarRecentSession[],
    options: {
      showDraft: boolean;
      codingTrailing?: TemplateResult | typeof nothing;
      codingTrailingPresent?: boolean;
    },
  ) {
    const { sections, expandedRows, visibleRows } = this.zonedVisibleSections(rows);
    return html`
      ${options.showDraft ? this.renderDraftSessionRow() : nothing}
      ${sections.map((section) => {
        if (section.id === "work") {
          // Coding hosts live work/ACP rows plus the CLI catalogs; hide the
          // whole zone when both are empty.
          if (section.totalRowCount === 0 && options.codingTrailingPresent !== true) {
            return nothing;
          }
          return this.renderSessionSection(section, options.codingTrailing ?? nothing);
        }
        return this.renderSessionSection(section);
      })}
      ${this.renderSessionPagination(expandedRows, visibleRows.length)}
    `;
  }

  private renderSessionPagination(rows: SidebarRecentSession[], visible: number) {
    const canShowMore = visible < rows.length;
    const collapsedVisible = limitSidebarSessionRows(rows, SIDEBAR_SESSION_PAGE_SIZE).length;
    const canShowLess = visible > SIDEBAR_SESSION_SEE_LESS_THRESHOLD && visible > collapsedVisible;
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
                this.visibleSessionLimit = visible + SIDEBAR_SESSION_PAGE_SIZE;
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
                this.clearSessionSelection();
                this.visibleSessionLimit = SIDEBAR_SESSION_PAGE_SIZE;
              }}
            >
              ${t("usage.details.collapse")}
            </button>`
          : nothing}
      </div>
    `;
  }

  protected renderSessions() {
    const navigationState = this.getSessionNavigationState();
    const visibleSessions = this.selectedAgentSessionRows(navigationState);
    const expandedAgentId = this.expandedAgentId();
    return html`
      <section class="sidebar-sessions">
        ${this.sessionMutationError
          ? html`
              <div
                class="sidebar-session-error callout danger callout--dismissible"
                role="alert"
                data-sidebar-session-error
              >
                <span class="callout__content">${this.sessionMutationError}</span>
                <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
                  <button
                    class="callout__dismiss"
                    type="button"
                    @click=${() => {
                      this.sessionMutationError = null;
                    }}
                    aria-label=${t("chat.actions.dismissError")}
                  >
                    ${icons.x}
                  </button>
                </openclaw-tooltip>
              </div>
            `
          : nothing}
        <div class="sidebar-recent-sessions" aria-label=${titleForRoute("sessions")}>
          ${this.renderSessionListBody(visibleSessions, {
            showDraft:
              Boolean(this.draftSessionAgentId) &&
              normalizeAgentId(this.draftSessionAgentId) === expandedAgentId,
            codingTrailing: html`${this.renderSessionCatalogs(navigationState)}`,
            codingTrailingPresent: this.sessionCatalogs.length > 0,
          })}
        </div>
      </section>
    `;
  }

  private renderSessionCatalogs(
    navigationState: ReturnType<AppSidebarSessionListElement["getSessionNavigationState"]>,
  ) {
    return renderSessionCatalogGroups({
      catalogs: this.sessionCatalogs,
      connected: this.connected,
      basePath: this.basePath,
      routeSessionKey: this.activeRouteId === "chat" ? this.getRouteSessionKey() : "",
      newSessionAgentId: this.expandedAgentId(),
      collapsedSections: this.collapsedSessionSections,
      loadingMoreCatalogIds: this.loadingMoreSessionCatalogIds,
      projectGrouping: this.catalogProjectGrouping,
      liveRows: [
        ...(this.sessionsResult?.sessions ?? []),
        ...Object.values(this.sessionRowsByAgent).flat(),
      ],
      renderLiveRow: (row, display) =>
        this.renderRecentSession(navigationState.toSidebarSession(row), display),
      onToggleSection: (sectionId) => this.toggleSessionSection(sectionId),
      onToggleProjectGrouping: () => {
        const next = this.catalogProjectGrouping === "project" ? "none" : "project";
        storeSidebarCatalogGrouping(next);
        this.catalogProjectGrouping = next;
      },
      onLoadMore: (catalogId) => void this.loadMoreSessionCatalog(catalogId),
      onOpenNewSession: this.onOpenNewSession,
      onNavigate: this.onNavigate,
      catalogOpenTarget: this.catalogOpenTarget,
      terminalAvailable: this.terminalAvailable,
      onOpenTerminal: (key) => openCatalogSessionInTerminal(key),
      onOpenMenu: (request, x, y, trigger) => this.catalogMenu.open(request, x, y, trigger),
    });
  }
}
