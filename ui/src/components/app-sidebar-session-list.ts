import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { titleForRoute } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { formatDurationCompact } from "../lib/format.ts";
import { startHoverMarquee, stopHoverMarquee } from "../lib/hover-marquee.ts";
import { channelDisplayLabel } from "../lib/session-display.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import { writeSessionDragData, writeSessionGroupDragData } from "../lib/sessions/drag.ts";
import { groupSidebarSessionRows } from "../lib/sessions/grouping.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { AppSidebarMenusElement } from "./app-sidebar-menus.ts";
import { shouldHandleNavigationClick } from "./app-sidebar-nav-menus.ts";
import {
  type CatalogBackingSessionDisplay,
  renderSessionCatalogGroups,
} from "./app-sidebar-session-catalogs.ts";
import {
  limitSidebarSessionRows,
  SIDEBAR_SESSION_PAGE_SIZE,
  SIDEBAR_SESSION_SEE_LESS_THRESHOLD,
  sidebarSessionMetaId,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";
import "./elapsed-time.ts";

/** Session-list presentation and catalog renderer wiring. */
export abstract class AppSidebarSessionListElement extends AppSidebarMenusElement {
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
    const state =
      status === "done"
        ? { icon: icons.check, label: t("sessionsView.statusDone") }
        : status === "killed"
          ? { icon: icons.stop, label: t("sessionsView.statusKilled") }
          : status === "timeout"
            ? { icon: icons.alertTriangle, label: t("sessionsView.statusTimeout") }
            : status === "failed"
              ? { icon: icons.alertTriangle, label: t("sessionsView.statusFailed") }
              : null;
    return state
      ? html`<span
          class="sidebar-child-session__status sidebar-child-session__status--${status}"
          role="img"
          aria-label=${state.label}
          title=${state.label}
          >${state.icon}</span
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
    const metaId = meta ? sidebarSessionMetaId(session.key) : undefined;
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
              this.openSessionMenuForRow(session, event.clientX, event.clientY);
            }}
        @mouseenter=${(event: MouseEvent) => startHoverMarquee(event.currentTarget as HTMLElement)}
        @mouseleave=${(event: MouseEvent) => stopHoverMarquee(event.currentTarget as HTMLElement)}
      >
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
              <span class="sidebar-child-session-toggle__count"
                >${session.childSessionKeys.length}</span
              >
            </button>`
          : nothing}
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
                : meta}</span
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
                    this.openSessionMenuForRow(session, rect.right, rect.bottom + 4, trigger);
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
      channel?: string;
      work?: boolean;
      rows: SidebarRecentSession[];
    },
    showFallback = false,
  ) {
    const group = section.category;
    const isPinned = section.id === "pinned";
    const showHeader = isPinned || this.sessionsGrouping === "category";
    const collapsed = showHeader && this.collapsedSessionSections.has(section.id);
    const label = isPinned
      ? t("sessionsView.pinned")
      : section.channel
        ? channelDisplayLabel(section.channel)
        : section.work
          ? t("chat.sidebar.workSessions")
          : group
            ? group
            : t("chat.sidebar.chats");
    const acceptsSessions =
      isPinned ||
      (this.sessionsGrouping === "category" && (section.id === "ungrouped" || Boolean(group)));
    const sectionClass = [
      "sidebar-recent-sessions__group",
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
                  <span class="sidebar-session-group-toggle__icon" aria-hidden="true"
                    >${collapsed ? icons.chevronRight : icons.chevronDown}</span
                  >
                  <span class="sidebar-recent-sessions__label-text">${label}</span>
                  <span class="sidebar-session-group-count">${section.rows.length}</span>
                </button>
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
              <div class="sidebar-recent-sessions__list" role="list" aria-label=${label}>
                ${showFallback
                  ? this.renderChatFallback()
                  : section.rows.map((session) => this.renderSessionTree(session))}
              </div>
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
    options: { showDraft: boolean; showFallback: boolean },
  ) {
    const visibleRows = limitSidebarSessionRows(rows, this.visibleSessionLimit);
    const sections = groupSidebarSessionRows(visibleRows, {
      grouping: this.sessionsGrouping,
      knownGroups: this.sessionsGrouping === "category" ? this.knownSessionGroups() : undefined,
    });
    return html`
      ${options.showDraft ? this.renderDraftSessionRow() : nothing}
      ${sections.map((section) =>
        this.renderSessionSection(
          section,
          options.showFallback && rows.length === 0 && section.id === "ungrouped",
        ),
      )}
      ${this.renderSessionPagination(rows, visibleRows.length)}
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
        <div
          class="sidebar-recent-sessions sidebar-recent-sessions--scroll-${this
            .sessionsScrollState}"
          aria-label=${titleForRoute("sessions")}
          @scroll=${(event: Event) =>
            this.updateSessionsScrollState(event.currentTarget as HTMLElement)}
        >
          <div class="sidebar-recent-sessions__head sidebar-recent-sessions__head--root">
            <span class="sidebar-recent-sessions__label-text">${t("sessionsView.title")}</span>
            <button
              type="button"
              class="sidebar-session-sort"
              title=${t("chat.sidebar.sortSessions")}
              aria-label=${t("chat.sidebar.sortSessions")}
              aria-haspopup="menu"
              aria-expanded=${String(this.sessionSortMenuPosition !== null)}
              @click=${(event: MouseEvent) =>
                this.toggleSessionSortMenu(event.currentTarget as HTMLElement)}
            >
              ${icons.listFilter}
            </button>
            <button
              type="button"
              class="sidebar-session-sort sidebar-session-new"
              title=${navigationState.newSessionTitle}
              aria-label=${t("chat.runControls.newSession")}
              ?disabled=${navigationState.newSessionDisabled}
              @click=${() => this.onOpenNewSession?.(expandedAgentId)}
            >
              ${icons.plus}
            </button>
          </div>
          ${this.renderSessionListBody(visibleSessions, {
            showDraft:
              Boolean(this.draftSessionAgentId) &&
              normalizeAgentId(this.draftSessionAgentId) === expandedAgentId,
            showFallback: true,
          })}
          ${this.renderSessionCatalogs(navigationState)}
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
      liveRows: [
        ...(this.sessionsResult?.sessions ?? []),
        ...Object.values(this.sessionRowsByAgent).flat(),
      ],
      renderLiveRow: (row, display) =>
        this.renderRecentSession(navigationState.toSidebarSession(row), display),
      onToggleSection: (sectionId) => this.toggleSessionSection(sectionId),
      onLoadMore: (catalogId) => void this.loadMoreSessionCatalog(catalogId),
      onOpenNewSession: this.onOpenNewSession,
      onNavigate: this.onNavigate,
      catalogOpenTarget: this.catalogOpenTarget,
      terminalAvailable: this.terminalAvailable,
      onOpenTerminal: (key) => openCatalogSessionInTerminal(key),
      onOpenMenu: (request, x, y, trigger) => this.catalogMenu.open(request, x, y, trigger),
    });
  }

  private renderChatFallback() {
    const active = this.activeRouteId === "chat";
    return html`
      <div
        class="sidebar-recent-session ${active ? "sidebar-recent-session--active" : ""}"
        role="listitem"
      >
        <a
          href=${pathForRoute("chat", this.basePath)}
          class="sidebar-recent-session__link"
          aria-current=${active ? "page" : nothing}
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.onNavigate?.("chat");
          }}
        >
          <span class="sidebar-recent-session__text">
            <span class="sidebar-recent-session__name">${t("nav.chat")}</span>
          </span>
        </a>
      </div>
    `;
  }
}
