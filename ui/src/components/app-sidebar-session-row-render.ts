import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import { withSidebarNavCollapseIntent } from "../app-session-route-paths.ts";
import { sessionHasPendingApproval } from "../app/approval-presentation.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import { resolveControlUiAuthCandidates } from "../app/control-ui-auth.ts";
import { t } from "../i18n/index.ts";
import { formatDurationCompact } from "../lib/format.ts";
import {
  restartHoverMarqueeIfHovered,
  startHoverMarqueeFromEvent,
  stopHoverMarqueeFromEvent,
} from "../lib/hover-marquee.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { presenceMatchesProfile, projectPresencePayload } from "../lib/presence-users.ts";
import type { CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { writeSessionDragData } from "../lib/sessions/drag.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import type {
  CatalogBackingSessionDisplay,
  CatalogSessionMenuRequest,
} from "./app-sidebar-session-catalogs.ts";
import type { SessionPullRequestIndicatorsController } from "./app-sidebar-session-pr-indicators.ts";
import type { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import {
  rowDemandsVisibility,
  sidebarSessionMetaId,
  sidebarSessionStateId,
  type SidebarRecentSession,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import {
  describeSessionTrailingState,
  renderSessionLeadingState,
} from "./session-leading-indicator.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";
import { renderSidebarSessionSubtitle } from "./session-row-subtitle.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";
import "./elapsed-time.ts";
import "./tooltip.ts";

const SIDEBAR_VISIBLE_CHILD_SESSION_LIMIT = 4;

export interface SessionListHost {
  readonly basePath: string;
  readonly sessionDataContext: Pick<ApplicationContext, "gateway"> | undefined;
  readonly sidebarLiveActivity: boolean;
  readonly sessionsShowPreview: boolean;
  readonly sidebarNarrationLines: ReadonlyMap<string, string>;
  readonly sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest>;
  readonly sessionProjection: Pick<SidebarSessionProjection, "resolveSubtitle">;
  readonly selectedSessionKeys: ReadonlySet<string>;
  readonly connected: boolean;
  readonly sessionData: Pick<
    SessionDataController,
    | "approvalBadgeSnapshot"
    | "childSessionErrorsByParent"
    | "loadMoreSessionCatalog"
    | "presenceInstanceId"
    | "presencePayload"
    | "refreshSessionCatalogs"
    | "retryChildSessions"
    | "sessionCatalogRefreshStatus"
    | "sessionMutationError"
  >;
  readonly sessionsGrouping: SidebarSessionsGrouping;
  readonly collapsedSessionSections: ReadonlySet<string>;
  readonly sessionOrganizer: Pick<
    SessionOrganizerController,
    | "draggingSidebarSection"
    | "draggingSessionKey"
    | "sessionDropTarget"
    | "sidebarSectionDropTarget"
    | "sessionListRemovalDrop"
  >;
  readonly sidebarMenus: Pick<
    SidebarMenusController,
    | "catalogMenu"
    | "catalogViewMenuPosition"
    | "openCatalogViewMenu"
    | "openSessionGroupMenu"
    | "openSessionMenu"
    | "sessionGroupMenu"
    | "sessionMenu"
    | "sessionSortMenuPosition"
    | "toggleCatalogViewMenu"
    | "toggleSessionSortMenu"
  >;
  readonly sessionsStatusFilter: SidebarSessionStatusFilter;
  readonly sessionOwnerFilterActive: boolean;
  readonly sessionOwnershipVisible: boolean;
  readonly onOpenNewSession?: (agentId: string, target?: NewSessionTarget) => void;
  readonly onNavigate?: (
    routeId: NavigationRouteId,
    options?: ApplicationNavigationOptions,
  ) => void;

  readonly sessionPullRequests: Pick<SessionPullRequestIndicatorsController, "summary">;
  mainSessionRow(): { key: string } | null;
  isSessionChildrenExpanded(session: SidebarRecentSession): boolean;
  isSessionChildrenFullyShown(sessionKey: string): boolean;
  startSessionDrag(session: SidebarRecentSession): void;
  finishSessionDrag(): void;
  handleSessionRowClick(event: MouseEvent, session: SidebarRecentSession): void;
  toggleSessionChildren(session: SidebarRecentSession): void;
  toggleSessionPin(session: SidebarRecentSession): void;
  toggleSessionMenu(session: SidebarRecentSession, trigger: HTMLElement): void;
  showMoreChildren(sessionKey: string): void;
  sectionDragOver(event: DragEvent, sectionId: string, group?: string): void;
  sectionDragLeave(event: DragEvent, sectionId: string, group?: string): void;
  sectionDrop(event: DragEvent, sectionId: string, group?: string): void;
  startSidebarSectionDrag(sectionId: string): void;
  finishSidebarSectionDrag(): void;
  toggleSection(sectionId: string): void;
  expandedAgentId(): string;
  readNewSessionAccess(): import("../lib/session-method-access.ts").SessionMethodAccess;
  readSessionMutationAccess(request: {
    method: string;
    params?: unknown;
    requiredScope?: "operator.write" | "operator.admin";
  }): import("../lib/session-method-access.ts").SessionMethodAccess;
  requestOpenNewSession(agentId: string, target?: NewSessionTarget): void;
  setVisibleSessionLimit(sectionId: string, limit: number): void;
  clearSessionSelection(): void;
  handleSessionListDragOver(event: DragEvent): void;
  handleSessionListDragLeave(event: DragEvent): void;
  handleSessionListDrop(event: DragEvent): void;
  dismissSessionMutationError(): void;
  openCatalogMenu(
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger?: HTMLElement,
  ): void;
  retargetCatalogMenuTrigger(key: CatalogSessionKey, element: Element | undefined): void;
}

export function visibleSessionChildren(params: {
  session: SidebarRecentSession;
  fullyShown: boolean;
}): readonly SidebarRecentSession[] {
  // Active, running, and attention-bearing branches must bypass the quiet-child cap.
  return params.fullyShown
    ? params.session.children
    : params.session.children.filter(
        (child, index) =>
          index < SIDEBAR_VISIBLE_CHILD_SESSION_LIMIT || rowDemandsVisibility(child),
      );
}

export function renderRecentSession(params: {
  host: SessionListHost;
  session: SidebarRecentSession;
  display?: CatalogBackingSessionDisplay;
  listItem?: boolean;
}) {
  const { host, session, display, listItem = true } = params;
  const pinAccess = host.readSessionMutationAccess({
    method: "sessions.patch",
    params: { key: session.key, pinned: !session.pinned },
  });
  const label = display?.label ?? session.label;
  const { subtitle, narration } = host.sessionProjection.resolveSubtitle({
    session,
    hasDisplay: display !== undefined,
    displaySubtitle: display?.subtitle,
    sidebarLiveActivity: host.sidebarLiveActivity,
    showPreview: host.sessionsShowPreview,
    narrationLine: host.sidebarNarrationLines.get(session.key),
    observerDigest: host.sidebarObserverDigests.get(session.key) ?? null,
  });
  const initialPullRequest = session.pullRequest ?? display?.pullRequest;
  const pullRequest = session.worktreeId
    ? host.sessionPullRequests.summary(session.key, session.worktreeId, initialPullRequest)
    : initialPullRequest;
  const ownerAttribution =
    host.sessionsStatusFilter === "archived"
      ? "archived"
      : session.owner?.assignedAt !== undefined
        ? "owned"
        : "created";
  const ownerActor = host.sessionOwnershipVisible
    ? host.sessionsStatusFilter === "archived"
      ? session.archivedBy
      : session.owner?.actor
    : undefined;
  const ownerViewing =
    ownerActor?.identity?.type === "profile"
      ? projectPresencePayload(host.sessionData.presencePayload).users.some(
          (user) =>
            presenceMatchesProfile(user, ownerActor.identity) &&
            user.watchedSessions.includes(session.key),
        )
      : undefined;
  // Person sections already own durable attribution. Restore the row avatar
  // only for live presence; pinned and archive-attribution rows have no matching header.
  const ownerRepeatedBySection =
    host.sessionsGrouping === "person" && !session.pinned && ownerAttribution !== "archived";
  const leadingOwner = ownerRepeatedBySection && ownerViewing !== true ? undefined : ownerActor;
  const gateway = host.sessionDataContext?.gateway;
  const channelAvatarAuth = {
    authTokens: gateway
      ? resolveControlUiAuthCandidates({
          hello: gateway.snapshot.hello,
          settings: { token: gateway.connection.token },
          password: gateway.connection.password,
        })
      : [],
    authReady: Boolean(
      gateway &&
      (gateway.snapshot.hello ||
        gateway.connection.token.trim() ||
        gateway.connection.password.trim()),
    ),
  };
  const { running, leadingIndicator, trailingIndicator, renderedOwnerIdentity } =
    renderSessionLeadingState(
      session,
      leadingOwner,
      ownerAttribution,
      ownerViewing,
      session.participants,
      session.participantCount,
      channelAvatarAuth,
    );
  const trailingDescription = session.isChild
    ? running && session.unread
      ? t("sessionsView.unread")
      : ""
    : describeSessionTrailingState(session);
  const hasTrail = session.isChild && (session.runtimeMs != null || session.startedAt != null);
  const metaId = hasTrail ? sidebarSessionMetaId(session.key) : undefined;
  const stateId = trailingDescription ? sidebarSessionStateId(session.key) : undefined;
  const openMenuFromEvent = (event: MouseEvent | KeyboardEvent) =>
    handleContextMenuEvent(
      event,
      (event.currentTarget as HTMLElement).querySelector("[data-session-menu]"),
      (trigger, x, y) => host.sidebarMenus.openSessionMenu(session, x, y, trigger),
    );
  const pinLabel = `${t(session.pinned ? "sessionsView.unpinSession" : "sessionsView.pinSession")}: ${label}`;
  const menuTooltip = t("chat.sidebar.openSessionMenu");
  const menuLabel = `${menuTooltip}: ${label}`;
  const menuOpen =
    host.sidebarMenus.sessionMenu?.session.key === session.key || display?.catalogMenuOpen === true;
  const rowClass = [
    "sidebar-recent-session",
    "session-row-host",
    session.isChild ? "sidebar-recent-session--child" : "",
    !subtitle ? "sidebar-recent-session--single-line" : "",
    session.archived ? "sidebar-session--archived" : "",
    session.visuallyActive ? "sidebar-recent-session--active" : "",
    host.selectedSessionKeys.has(session.key) ? "sidebar-recent-session--selected" : "",
    session.pinned ? "session-row-host--pinned" : "",
    running ? "session-row-host--running" : "",
    session.visibility === "draft" ? "session-row-host--draft" : "",
    session.visibility === "draft"
      ? session.draftOwnedBySelf
        ? "session-row-host--draft-owner"
        : "session-row-host--draft-other"
      : "",
    session.attention.kind === "error"
      ? "sidebar-recent-session--attention-danger"
      : session.attention.kind !== "none"
        ? "sidebar-recent-session--attention-amber"
        : "",
    host.sessionOrganizer.draggingSessionKey === session.key
      ? "sidebar-recent-session--dragging"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const childrenExpanded = host.isSessionChildrenExpanded(session);
  const groupWriteAccess = host.readSessionMutationAccess({
    method: "sessions.groups.put",
    requiredScope: "operator.write",
  });
  const rowDraggable = !session.isChild && groupWriteAccess.allowed;
  const marqueeLabelTemplate = html`<span
    ${display ? ref(restartHoverMarqueeIfHovered) : nothing}
    class="sidebar-recent-session__name hover-marquee"
    >${session.archived
      ? html`<span
          class="sidebar-session__archive-glyph"
          aria-label=${t("sessionsView.archived")}
          title=${t("sessionsView.archived")}
          >${icons.archive}</span
        >`
      : nothing}${session.forkSource
      ? html`<span
          class="sidebar-session-fork-indicator"
          role="img"
          aria-label=${t("sessionsView.forkedSession")}
          >${icons.gitFork}</span
        >`
      : nothing}${label}</span
  >`;
  const marqueeLabel = display
    ? keyed(
        JSON.stringify([
          label,
          session.archived === true,
          session.forkSource !== undefined,
          pullRequest,
        ]),
        marqueeLabelTemplate,
      )
    : marqueeLabelTemplate;
  // Always reserve the lead so every title shares the section-label text line.
  const row = html`
    <div
      ${display?.rowRef ? ref(display.rowRef) : nothing}
      class=${rowClass}
      data-session-key=${session.key}
      data-catalog-session-key=${display?.catalogIdentityKey ?? nothing}
      role=${ifDefined(listItem ? "listitem" : undefined)}
      draggable=${rowDraggable ? "true" : "false"}
      @dragstart=${!rowDraggable
        ? nothing
        : (event: DragEvent) => {
            if (event.dataTransfer) {
              writeSessionDragData(event.dataTransfer, session.key);
              host.startSessionDrag(session);
            }
          }}
      @dragend=${!rowDraggable
        ? nothing
        : () => {
            host.finishSessionDrag();
          }}
      @contextmenu=${openMenuFromEvent}
      @keydown=${openMenuFromEvent}
      @mouseenter=${startHoverMarqueeFromEvent}
      @mouseleave=${stopHoverMarqueeFromEvent}
    >
      <a
        href=${withSidebarNavCollapseIntent(session.href)}
        class="sidebar-recent-session__link"
        draggable="false"
        aria-current=${session.visuallyActive ? "page" : nothing}
        aria-describedby=${[stateId, metaId].filter(Boolean).join(" ") || nothing}
        @click=${(event: MouseEvent) => host.handleSessionRowClick(event, session)}
      >
        <span class="sidebar-session-indicator"
          >${leadingIndicator}
          ${session.visibility === "draft"
            ? html`<span class="session-row-draft-indicator" title=${t("chat.sessionSharing.draft")}
                >👻</span
              >`
            : nothing}</span
        >
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__title-row"> ${marqueeLabel} </span>
          <span class="sidebar-recent-session__details">
            ${renderSidebarSessionSubtitle({ subtitle, narration })}
            <span class="sidebar-recent-session__details-endcap">
              <openclaw-viewer-facepile
                .presencePayload=${host.sessionData.presencePayload}
                .selfUser=${host.sessionDataContext?.gateway.snapshot.selfUser}
                .selfInstanceId=${host.sessionData.presenceInstanceId}
                .sessionKey=${session.key}
                .excludeIdentity=${renderedOwnerIdentity}
                .maxVisible=${3}
                variant="session"
              ></openclaw-viewer-facepile>
              ${renderSessionRowBadges({
                isChild: session.isChild,
                incognito: session.incognito,
                placementState: session.placementState,
                placementProviderId: session.placementProviderId,
                placementProfileId: session.placementProfileId,
                diskSpaceStatus: session.diskSpaceStatus,
                workspaceConflictCount: session.workspaceConflictCount,
                outboxAttentionCount: session.outboxAttentionCount,
                hasComposerDraft: session.hasComposerDraft === true,
                pullRequest,
                hasApproval: sessionHasPendingApproval(
                  host.sessionData.approvalBadgeSnapshot(),
                  session.key,
                ),
              })}
              ${trailingIndicator === nothing
                ? trailingDescription
                  ? html`<span class="sr-only" id=${stateId}>${trailingDescription}</span>`
                  : nothing
                : html`<span class="session-row-aside">
                    <span
                      class="session-row-state"
                      id=${stateId}
                      role="img"
                      aria-label=${trailingDescription}
                      >${trailingIndicator}</span
                    >
                  </span>`}
              ${hasTrail
                ? html`<span class="session-row-trail" id=${metaId}
                    >${session.runtimeMs != null
                      ? session.hasActiveRun
                        ? html`<openclaw-elapsed-time
                            .startMs=${session.runtimeSampledAt! - session.runtimeMs}
                          ></openclaw-elapsed-time>`
                        : (formatDurationCompact(session.runtimeMs) ?? "0ms")
                      : html`<openclaw-elapsed-time
                          .startMs=${session.startedAt!}
                          .endMs=${session.endedAt ?? null}
                        ></openclaw-elapsed-time>`}</span
                  >`
                : nothing}
            </span>
          </span>
        </span>
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
            aria-expanded=${String(childrenExpanded)}
            aria-label=${t(
              childrenExpanded
                ? "sessionsView.hideChildSessions"
                : "sessionsView.showChildSessions",
              { count: String(session.childSessionKeys.length), session: label },
            )}
            @click=${() => host.toggleSessionChildren(session)}
          >
            <span class="sidebar-child-session-toggle__icon" aria-hidden="true"
              >${childrenExpanded ? icons.chevronDown : icons.chevronRight}</span
            >
            ${childrenExpanded
              ? nothing
              : html`<span class="sidebar-child-session-toggle__count"
                  >${session.childSessionKeys.length}</span
                >`}
          </button>`
        : nothing}
      <span class="sidebar-recent-session__aside session-row-aside">
        <span class="session-row-actions">
          ${session.isChild
            ? nothing
            : html`<button
                class="session-action session-action--pin"
                data-sidebar-session-pin="true"
                type="button"
                title=${pinAccess.allowed ? pinLabel : pinAccess.reason}
                aria-label=${pinLabel}
                ?disabled=${!pinAccess.allowed}
                @click=${() => host.toggleSessionPin(session)}
              >
                ${icons.pin}
              </button>`}
          <openclaw-tooltip .content=${menuTooltip} .describe=${false} .disabled=${menuOpen}>
            <button
              class="session-action"
              data-session-menu="true"
              type="button"
              aria-label=${menuLabel}
              aria-haspopup="menu"
              aria-expanded=${String(menuOpen)}
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                const trigger = event.currentTarget as HTMLElement;
                host.toggleSessionMenu(session, trigger);
              }}
            >
              ${icons.moreHorizontal}
            </button>
          </openclaw-tooltip>
        </span>
      </span>
    </div>
  `;
  // Marquee state mutates the row DOM; keying prevents cross-session reuse.
  return keyed(session.key, row);
}

export function renderChildSessionLoadError(host: SessionListHost, parentKey: string) {
  const error = host.sessionData.childSessionErrorsByParent.get(parentKey);
  if (!error) {
    return nothing;
  }
  return html`<div
    class="sidebar-session-error callout danger"
    data-child-session-error=${parentKey}
    role="alert"
  >
    <span>${error}</span>
    <button
      class="sidebar-session-tree__show-more"
      type="button"
      data-retry-child-sessions=${parentKey}
      @click=${() => host.sessionData.retryChildSessions(parentKey)}
    >
      ${t("common.retry")}
    </button>
  </div>`;
}

export function renderSessionTree(params: {
  host: SessionListHost;
  session: SidebarRecentSession;
  listItem?: boolean;
}): TemplateResult {
  const { host, session, listItem = true } = params;
  const expanded = host.isSessionChildrenExpanded(session);
  const visibleChildren = visibleSessionChildren({
    session,
    fullyShown: host.isSessionChildrenFullyShown(session.key),
  });
  const hiddenChildCount = session.children.length - visibleChildren.length;
  return html`<div
    class="sidebar-session-tree"
    data-session-tree=${session.key}
    role=${ifDefined(listItem ? "listitem" : undefined)}
  >
    ${renderRecentSession({ host, session, listItem: false })}
    ${expanded
      ? html`<div class="sidebar-session-tree__children">
          ${visibleChildren.length > 0
            ? html`<div
                class="sidebar-session-tree__list"
                role=${ifDefined(listItem ? "list" : undefined)}
                aria-label=${ifDefined(listItem ? t("sessionsView.childSessions") : undefined)}
              >
                ${repeat(
                  visibleChildren,
                  (child) => child.key,
                  (child) => renderSessionTree({ host, session: child, listItem }),
                )}
              </div>`
            : nothing}
          ${hiddenChildCount > 0
            ? html`<button
                class="sidebar-session-tree__show-more"
                type="button"
                data-show-more-children=${session.key}
                aria-label=${t("sessionsView.showMoreChildren", {
                  count: String(hiddenChildCount),
                })}
                @click=${() => host.showMoreChildren(session.key)}
              >
                ${t("sessionsView.showMoreChildren", { count: String(hiddenChildCount) })}
              </button>`
            : nothing}
          ${renderChildSessionLoadError(host, session.key)}
          ${session.loadingChildren && session.children.length === 0
            ? html`<span class="sidebar-session-tree__loading">${t("common.loading")}</span>`
            : nothing}
        </div>`
      : nothing}
  </div>`;
}
