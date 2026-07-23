import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  serializeSidebarEntry,
  type NavigationRouteId,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { sessionHasPendingApproval } from "../app/approval-presentation.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { BoardAvailabilityController } from "../lib/board/availability-controller.ts";
import { sessionHasBoard } from "../lib/board/provider.ts";
import "./menu-surface.ts";
import "./session-menu.ts";
import "./sidebar-agent-card.ts";
import "./sidebar-attention.ts";
import "./sidebar-build-chip.ts";
import "./sidebar-update-card.ts";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent, normalizeAgentId } from "../lib/sessions/session-key.ts";
import { pluginTabKey } from "../pages/plugin/route.ts";
import {
  renderSidebarPluginTab,
  shouldHandleNavigationClick,
  sidebarPluginTabs,
} from "./app-sidebar-nav-menus.ts";
import { AppSidebarSessionListElement } from "./app-sidebar-session-list.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SidebarWorkboardBoard } from "./app-sidebar-workboard.ts";
import { icons } from "./icons.ts";
import {
  LOBSTER_LOGO_VISIT_EVENT,
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
  type LobsterLogoVisitDetail,
} from "./lobster-pet-contract.ts";
import { redactLoginFailureError } from "./login-gate.ts";
import { renderOfflineSidebarStatus, renderSessionRowBadges } from "./session-row-badges.ts";

const PALETTE_SHORTCUT = /Mac|iP(hone|ad|od)/i.test(globalThis.navigator?.platform ?? "")
  ? "⌘K"
  : "Ctrl K";
// The shared loader retries transient chunk failures online; a deploy-pruned
// chunk still stays off until reload when that retry fails, by design.
const sidebarChromeImport = createIdleImport(() =>
  Promise.all([
    customElements.get("openclaw-lobster-pet") ? undefined : import("./lobster-pet.ts"),
    customElements.get("openclaw-viewer-facepile") ? undefined : import("./viewer-facepile.ts"),
  ]),
);

class AppSidebar extends AppSidebarSessionListElement {
  @state() private logoVisit: LobsterLogoVisitDetail | null = null;

  constructor() {
    super();
    void new BoardAvailabilityController(
      this,
      () => {
        const mainKey = this.selectedAgentMainSessionKey(this.activeChipAgent().activeId);
        return [
          mainKey,
          ...this.visibleSessionRowsInOrder()
            .filter((session) => !session.isChild)
            .map((session) => session.key),
        ];
      },
      undefined,
      () => {
        const snapshot = this.context?.gateway.snapshot;
        const client = snapshot?.client;
        const availabilityClient =
          client &&
          typeof client.request === "function" &&
          typeof client.addEventListener === "function"
            ? client
            : null;
        return {
          client: availabilityClient,
          connected: snapshot?.connected ?? false,
          available: snapshot ? isGatewayMethodAdvertised(snapshot, "board.get") !== false : false,
          key: `${this.context?.gateway.connection?.gatewayUrl ?? ""}\u0000${
            snapshot?.hello?.server?.version ?? ""
          }`,
        };
      },
    );
    // The footer pet announces logo stand-in phases through this bubbling event.
    this.addEventListener(LOBSTER_LOGO_VISIT_EVENT, this.handleLogoVisit as EventListener);
  }

  override connectedCallback() {
    super.connectedCallback();
    // The decorative pet's large module stays out of startup and upgrades in place.
    // Its first visit is at least 15 seconds after load, so idle loading cannot miss one.
    sidebarChromeImport.schedule();
  }

  protected override firstUpdated() {
    requestAnimationFrame(() => requestAnimationFrame(() => this.classList.add("sidebar-r")));
  }

  private readonly handleLogoVisit = (event: Event) => {
    const detail = (event as CustomEvent<LobsterLogoVisitDetail>).detail;
    // A lookless visit is a logo scare: the brand mark hides (the img gets
    // the --vacated class) but no stand-in crab renders in its place.
    this.logoVisit = detail.phase === "out" ? null : detail;
  };

  private renderBrand() {
    const collapseLabel = t("nav.collapse");
    const { activeId: cardAgentId, agent: cardAgent, agents: cardAgents } = this.activeChipAgent();
    const menuUnread = cardAgents.some((entry) => {
      const agentId = normalizeAgentId(entry.id);
      return agentId !== cardAgentId && this.agentUnreadCount(agentId) > 0;
    });
    const cardName = cardAgent ? normalizeAgentLabel(cardAgent) : cardAgentId;
    const approvalCount = this.approvalBadgeSnapshot().agentCounts.get(cardAgentId) ?? 0;
    const cardAvatarText =
      (cardAgent ? resolveAgentTextAvatar(cardAgent) : null) ??
      (cardName || cardAgentId).slice(0, 1).toUpperCase();
    // The sidebar action follows gateway availability; collapsed native chrome
    // keeps its separate offline-tolerant ⌘N mirror.
    return html`
      <div class="sidebar-brand">
        <openclaw-sidebar-agent-card
          .agentName=${cardName}
          .avatarUrl=${cardAgent ? resolveAgentAvatarUrl(cardAgent) : null}
          .avatarText=${cardAvatarText}
          .subtitle=${this.agentChipSubtitle(cardAgentId)}
          .menuOpen=${this.agentMenuPosition !== null}
          .menuUnread=${menuUnread}
          .approvalCount=${approvalCount}
          .switcherAvailable=${cardAgents.length > 1}
          .onToggleMenu=${(trigger: HTMLElement) => this.toggleAgentMenu(trigger)}
        ></openclaw-sidebar-agent-card>
        <div class="sidebar-brand__actions">
          <openclaw-tooltip
            .content=${this.connected
              ? t("chat.runControls.newSession")
              : t("chat.runControls.newSessionDisconnected")}
          >
            <button
              class="sidebar-brand__icon sidebar-brand__new-thread"
              type="button"
              @click=${() => this.onOpenNewSession?.(this.expandedAgentId())}
              aria-label=${t("chat.runControls.newSession")}
              ?disabled=${!this.connected}
            >
              ${icons.plus}
            </button>
          </openclaw-tooltip>
          ${this.renderSearch()}
          <openclaw-tooltip .content=${`${collapseLabel} (⌘B)`}>
            <button
              class="sidebar-brand__icon sidebar-brand__collapse"
              type="button"
              @click=${() => this.onToggleSidebar?.()}
              aria-label=${collapseLabel}
              aria-expanded="true"
            >
              ${icons.panelLeftClose}
            </button>
          </openclaw-tooltip>
        </div>
      </div>
    `;
  }

  /** Home: the first page. Opens the rolling main session on its saved face. */
  private renderHomeRow() {
    const agentId = this.activeChipAgent().activeId;
    const mainKey = this.selectedAgentMainSessionKey(agentId);
    const mainRow = this.mainSessionRow(agentId);
    const approvalNeeded = sessionHasPendingApproval(this.approvalBadgeSnapshot(), mainKey);
    const outboxCount = this.outboxCountForSessionKey(mainKey);
    const active =
      this.activeRouteId === "chat" &&
      areUiSessionKeysEquivalent(this.getRouteSessionKey(), mainKey);
    const stateBadge = mainRow?.hasActiveRun
      ? html`<openclaw-tooltip .content=${t("sessionsView.activeRun")}>
          <span
            class="session-run-spinner"
            role="img"
            aria-label=${t("sessionsView.activeRun")}
          ></span>
        </openclaw-tooltip>`
      : mainRow?.unread === true && !active
        ? html`<span
            class="session-unread-dot"
            role="img"
            aria-label=${t("sessionsView.unread")}
          ></span>`
        : nothing;
    return html`
      <a
        href=${`${pathForRoute("chat", this.basePath)}${searchForSession(mainKey)}`}
        class="nav-item nav-item--home ${active ? "nav-item--active" : ""}"
        aria-current=${active ? "page" : nothing}
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          this.openMainSession(agentId);
        }}
      >
        <span class="nav-item__icon" aria-hidden="true">${icons.home}</span>
        <span class="nav-item__text">${t("nav.home")}</span>
        ${sessionHasBoard(mainKey)
          ? html`<openclaw-tooltip .content=${t("sessionsView.dashboardAvailable")}>
              <span
                class="sidebar-board-glyph"
                role="img"
                aria-label=${t("sessionsView.dashboardAvailable")}
                >${icons.layoutDashboard}</span
              >
            </openclaw-tooltip>`
          : nothing}
        ${stateBadge !== nothing || approvalNeeded || outboxCount > 0
          ? html`<span class="nav-item__state sidebar-home-session-states">
              ${stateBadge}
              ${approvalNeeded
                ? html`<openclaw-tooltip .content=${t("sessionsView.approvalNeeded")}>
                    <span
                      class="session-approval-badge"
                      role="img"
                      aria-label=${t("sessionsView.approvalNeeded")}
                      >${icons.alertTriangle}</span
                    >
                  </openclaw-tooltip>`
                : nothing}
              ${renderSessionRowBadges({ hasAutomation: false, outboxCount })}
            </span>`
          : nothing}
      </a>
    `;
  }

  /** "Pages" header: the customize affordance opens the pages menu (all
      routes navigable, pin editor behind it) that used to hide behind More. */
  private renderPagesHead() {
    return html`
      <div class="sidebar-nav__head">
        <span class="sidebar-recent-sessions__label-text">${t("nav.pages")}</span>
        <button
          type="button"
          class="sidebar-nav__head-action"
          aria-haspopup="menu"
          aria-expanded=${String(this.moreMenuPosition !== null)}
          aria-label=${t("nav.customize")}
          @click=${(event: MouseEvent) => this.toggleMoreMenu(event.currentTarget as HTMLElement)}
        >
          ${icons.penLine}
        </button>
      </div>
    `;
  }

  /** Zone 5: product chrome recedes to one slim footer bar. */
  private renderFooterBar() {
    const reconnecting = t("connection.reconnecting");
    const selfUser = this.connected
      ? resolveCurrentSelfUser({
          snapshotUser: this.context?.gateway.snapshot.selfUser,
          presenceEntries: readPresenceEntries(this.presencePayload),
          presenceInstanceId: this.presenceInstanceId,
        })
      : null;
    const selfLabel = selfUser?.name ?? selfUser?.email ?? selfUser?.id;
    return html`
      <div class="sidebar-footer-bar">
        <span class="sidebar-brand__logo-slot sidebar-footer-bar__logo">
          <img
            class="sidebar-brand__logo ${this.logoVisit ? "sidebar-brand__logo--vacated" : ""}"
            src=${controlUiPublicAssetPath("apple-touch-icon.png", this.basePath)}
            alt=""
            aria-hidden="true"
          />
          <openclaw-lobster-logo-standin .visit=${this.logoVisit}></openclaw-lobster-logo-standin>
        </span>
        ${selfUser && selfLabel
          ? html`<openclaw-tooltip .content=${selfLabel}>
              <button
                type="button"
                class="sidebar-footer-bar__identity"
                aria-label=${t("profilePage.identity.openSettings", { name: selfLabel })}
                @click=${() => this.onNavigate?.("profile", { hash: "#settings-profile-identity" })}
              >
                <openclaw-viewer-avatar
                  .user=${{ ...selfUser, watchedSessions: [] }}
                  variant="footer"
                ></openclaw-viewer-avatar>
                <span class="sidebar-footer-bar__identity-name">${selfLabel}</span>
              </button>
            </openclaw-tooltip>`
          : nothing}
        <openclaw-viewer-facepile
          .presencePayload=${this.presencePayload}
          .selfInstanceId=${this.presenceInstanceId}
          .buildInfo=${CONTROL_UI_BUILD_INFO}
          .gatewayVersion=${this.gatewayVersion}
          .maxVisible=${5}
          variant="footer"
        ></openclaw-viewer-facepile>
        <openclaw-sidebar-build-chip
          .basePath=${this.basePath}
          .gatewayVersion=${this.gatewayVersion}
          .onNavigate=${(routeId: "about") => this.onNavigate?.(routeId)}
        ></openclaw-sidebar-build-chip>
        ${this.offline
          ? renderOfflineSidebarStatus({
              queuedOutboxCount: this.queuedOutboxCount,
              reconnecting,
              title: this.lastError ? redactLoginFailureError(this.lastError) : reconnecting,
              onRetry: () => this.onRetryConnect?.(),
            })
          : nothing}
        <openclaw-tooltip .content=${t("nav.settings")}>
          <button
            type="button"
            class="sidebar-footer-bar__settings"
            aria-label=${t("nav.settings")}
            @click=${() => this.onNavigate?.("config")}
          >
            ${icons.settings}
          </button>
        </openclaw-tooltip>
      </div>
    `;
  }

  private renderSearch() {
    const tooltip = `${t("chat.openCommandPalette")} (${PALETTE_SHORTCUT})`;
    return html`
      <openclaw-tooltip .content=${tooltip}>
        <button
          type="button"
          class="sidebar-brand__icon sidebar-search"
          ?disabled=${!this.onOpenPalette}
          aria-label=${t("chat.openCommandPalette")}
          @click=${() => this.onOpenPalette?.()}
        >
          ${icons.search}
        </button>
      </openclaw-tooltip>
    `;
  }

  private renderSidebarZoneEntry(
    entry: SidebarZoneEntry,
    sessionRows: ReadonlyMap<string, SidebarRecentSession>,
    workboardRows: ReadonlyMap<string, SidebarWorkboardBoard>,
  ) {
    if (
      (entry.type === "route" && !this.isRouteEnabled(entry.route)) ||
      (entry.type === "workboard" && !this.isRouteEnabled("workboard"))
    ) {
      return nothing;
    }
    const serialized = serializeSidebarEntry(entry);
    const dropPosition =
      this.sidebarZoneDropTarget?.entry === serialized ? this.sidebarZoneDropTarget.position : null;
    const content =
      entry.type === "route"
        ? this.renderRoute(entry.route)
        : entry.type === "workboard"
          ? workboardRows.has(entry.boardId)
            ? this.renderWorkboardBoard(workboardRows.get(entry.boardId)!)
            : nothing
          : sessionRows.has(entry.key)
            ? this.renderPinnedSidebarSession(sessionRows.get(entry.key)!)
            : nothing;
    const draggable = entry.type === "route" || entry.type === "workboard";
    return html`
      <div
        class="sidebar-zone-entry ${dropPosition
          ? `sidebar-zone-entry--drop-${dropPosition}`
          : ""} ${this.draggingSidebarEntry === serialized ? "sidebar-zone-entry--dragging" : ""}"
        data-sidebar-entry=${serialized}
        draggable=${draggable ? "true" : "false"}
        @dragstart=${entry.type === "route"
          ? (event: DragEvent) => this.startSidebarRouteDrag(event, entry.route)
          : entry.type === "workboard"
            ? (event: DragEvent) => this.startSidebarWorkboardDrag(event, entry.boardId)
            : nothing}
        @dragend=${draggable ? () => this.finishSidebarEntryDrag() : nothing}
        @dragover=${(event: DragEvent) => this.handleSidebarZoneDragOver(event, serialized)}
        @drop=${(event: DragEvent) => this.handleSidebarZoneDrop(event, serialized)}
      >
        ${content}
      </div>
    `;
  }

  private renderPluginTabEntry(tab: GatewayControlUiPluginTab) {
    const ref = { pluginId: tab.pluginId, id: tab.id };
    const key = pluginTabKey(ref);
    return html`
      <div class="sidebar-zone-entry" data-sidebar-entry=${`plugin:${key}`}>
        ${renderSidebarPluginTab({
          tab,
          basePath: this.basePath,
          active: this.activeRouteId === "plugin" && this.activePluginTabId === key,
          onNavigate: (search) => this.onNavigate?.("plugin", { search }),
        })}
      </div>
    `;
  }

  private renderWorkboardBoard(board: SidebarWorkboardBoard) {
    const active = this.activeRouteId === "workboard" && this.activeWorkboardBoardId === board.id;
    return (
      this.workboardRenderers?.renderEntry({
        board,
        basePath: this.basePath,
        active,
        onNavigate: (pathname) => this.onNavigate?.("workboard", { pathname }),
      }) ?? nothing
    );
  }

  override render() {
    const sidebarZone = this.reconciledSidebarZone();
    return html`
      <aside class="sidebar">
        <div class="sidebar-shell" @mousedown=${beginNativeWindowDragFromTopInset}>
          ${this.renderBrand()}
          <div
            class="sidebar-shell__body sidebar-shell__body--scroll-${this.sessionsScrollState}"
            @scroll=${(event: Event) =>
              this.updateSessionsScrollState(event.currentTarget as HTMLElement)}
          >
            <nav class="sidebar-nav" @contextmenu=${this.openCustomizeMenuFromContext}>
              ${this.renderPagesHead()}
              <div
                class="nav-section__items"
                @dragover=${(event: DragEvent) => this.handleSidebarZoneDragOver(event)}
                @dragleave=${(event: DragEvent) => this.handleSidebarZoneDragLeave(event)}
                @drop=${(event: DragEvent) => this.handleSidebarZoneDrop(event)}
              >
                ${this.renderHomeRow()}
                ${sidebarZone.entries.map((entry) =>
                  this.renderSidebarZoneEntry(
                    entry,
                    sidebarZone.sessionRows,
                    sidebarZone.workboardRows,
                  ),
                )}
                ${sidebarPluginTabs(this.context?.gateway.snapshot.hello?.controlUiTabs).map(
                  (tab) => this.renderPluginTabEntry(tab),
                )}
              </div>
            </nav>
            ${this.renderSessions()}
          </div>
          <div class="sidebar-shell__footer">
            <openclaw-sidebar-attention
              .onNavigate=${(routeId: NavigationRouteId) => this.onNavigate?.(routeId)}
              .onOpenApprovals=${() => this.onOpenApprovals?.()}
            ></openclaw-sidebar-attention>
            <openclaw-sidebar-update-card
              .updateAvailable=${this.updateAvailable}
              .updateRunning=${this.updateRunning}
              .onUpdate=${this.onUpdate}
            ></openclaw-sidebar-update-card>
            <openclaw-lobster-pet
              .seed=${lobsterPetSeed(this.sessionKey)}
              .mode=${resolveLobsterPetMode(!this.offline, this.sessionsResult?.sessions)}
              .runOutcome=${resolveLobsterRunOutcome(this.sessionsResult?.sessions)}
              .visitsEnabled=${this.lobsterPetVisits}
              .soundsEnabled=${this.lobsterPetSounds}
              .gatewayVersion=${this.gatewayVersion}
            ></openclaw-lobster-pet>
            ${this.devGitBranch
              ? html`<openclaw-tooltip .content=${this.devGitBranch}>
                  <div class="sidebar-footer-branch">
                    <span class="sidebar-footer-branch__icon" aria-hidden="true"
                      >${icons.gitBranch}</span
                    >
                    <span class="sidebar-footer-branch__name">${this.devGitBranch}</span>
                  </div>
                </openclaw-tooltip>`
              : nothing}
            ${this.renderFooterBar()}
          </div>
        </div>
        ${this.renderCustomizeMenu()} ${this.renderMoreMenu()} ${this.renderAgentMenu()}
        ${this.renderSessionMenu()} ${this.catalogMenu.render()} ${this.renderSessionGroupMenu()}
        ${this.renderSessionSortMenu()}
      </aside>
    `;
  }
}

if (!customElements.get("openclaw-app-sidebar")) {
  customElements.define("openclaw-app-sidebar", AppSidebar);
}
