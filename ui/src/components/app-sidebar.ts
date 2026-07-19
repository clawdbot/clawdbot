import { html, nothing, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import {
  serializeSidebarEntry,
  type NavigationRouteId,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { BoardAvailabilityController } from "../lib/board/availability-controller.ts";
import "./menu-surface.ts";
import "./session-menu.ts";
import "./sidebar-agent-card.ts";
import "./sidebar-attention.ts";
import "./sidebar-build-chip.ts";
import "./sidebar-update-card.ts";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";
import { sessionHasBoard } from "../lib/board/provider.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent, normalizeAgentId } from "../lib/sessions/session-key.ts";
import { shouldHandleNavigationClick } from "./app-sidebar-nav-menus.ts";
import { AppSidebarSessionListElement } from "./app-sidebar-session-list.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  LOBSTER_LOGO_VISIT_EVENT,
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
  type LobsterLogoVisitDetail,
} from "./lobster-pet-contract.ts";

const PALETTE_SHORTCUT = /Mac|iP(hone|ad|od)/i.test(globalThis.navigator?.platform ?? "")
  ? "⌘K"
  : "Ctrl K";
const OFFLINE_INDICATOR_DELAY_MS = 2_000;

let lobsterPetModuleLoad: Promise<unknown> | null = null;

function scheduleLobsterPetLoad() {
  if (lobsterPetModuleLoad || customElements.get("openclaw-lobster-pet")) {
    return;
  }
  const start = () => {
    // A failed chunk fetch must not pin a rejected promise forever: clear the
    // cache and retry when connectivity returns. The sidebar mounts once per
    // page, so without this a transient failure would disable the pet for the
    // whole session; a deploy-pruned chunk stays off until reload, by design.
    lobsterPetModuleLoad ??= import("./lobster-pet.ts").catch(() => {
      lobsterPetModuleLoad = null;
      window.addEventListener("online", () => start(), { once: true });
    });
  };
  if ("requestIdleCallback" in window) {
    requestIdleCallback(() => start(), { timeout: 3000 });
  } else {
    setTimeout(start, 1500);
  }
}

class AppSidebar extends AppSidebarSessionListElement {
  @state() private logoVisit: LobsterLogoVisitDetail | null = null;
  @state() private debouncedDisconnected = false;

  private offlineIndicatorTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor() {
    super();
    void new BoardAvailabilityController(this, () => {
      const mainKey = this.selectedAgentMainSessionKey(this.activeChipAgent().activeId);
      return [
        mainKey,
        ...this.visibleSessionRowsInOrder()
          .filter((session) => !session.isChild)
          .map((session) => session.key),
      ];
    });
    // The footer pet announces logo stand-in phases through this bubbling event.
    this.addEventListener(LOBSTER_LOGO_VISIT_EVENT, this.handleLogoVisit as EventListener);
  }

  override connectedCallback() {
    super.connectedCallback();
    this.syncOfflineIndicator();
    // The decorative pet's large module stays out of startup and upgrades in place.
    // Its first visit is at least 15 seconds after load, so idle loading cannot miss one.
    scheduleLobsterPetLoad();
  }

  override disconnectedCallback() {
    this.syncOfflineIndicator(false);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    super.willUpdate(changed);
    if (changed.has("connected")) {
      this.syncOfflineIndicator();
    }
  }

  private syncOfflineIndicator(schedule = !this.connected) {
    if (this.offlineIndicatorTimer !== null) {
      globalThis.clearTimeout(this.offlineIndicatorTimer);
      this.offlineIndicatorTimer = null;
    }
    this.debouncedDisconnected = false;
    if (!schedule) {
      return;
    }
    // Both sidebar signals share one grace window so brief transport blips stay quiet.
    this.offlineIndicatorTimer = globalThis.setTimeout(() => {
      this.offlineIndicatorTimer = null;
      this.debouncedDisconnected = true;
    }, OFFLINE_INDICATOR_DELAY_MS);
  }

  private readonly handleLogoVisit = (event: Event) => {
    const detail = (event as CustomEvent<LobsterLogoVisitDetail>).detail;
    // A lookless visit is a logo scare: the brand mark hides (the img gets
    // the --vacated class) but no stand-in crab renders in its place.
    this.logoVisit = detail.phase === "out" ? null : detail;
  };

  private renderBrand() {
    const collapseLabel = t("nav.collapse");
    const gatewayStatus = t("chat.gatewayStatus", {
      status: this.connected ? t("common.online") : t("common.offline"),
    });
    const { activeId: cardAgentId, agent: cardAgent, agents: cardAgents } = this.activeChipAgent();
    const menuUnread = cardAgents.some((entry) => {
      const agentId = normalizeAgentId(entry.id);
      return agentId !== cardAgentId && this.agentUnreadCount(agentId) > 0;
    });
    const cardName = cardAgent ? normalizeAgentLabel(cardAgent) : cardAgentId;
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
          .offline=${this.debouncedDisconnected}
          .statusLabel=${gatewayStatus}
          .subtitle=${this.agentChipSubtitle(cardAgentId)}
          .menuOpen=${this.agentMenuPosition !== null}
          .menuUnread=${menuUnread}
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
    const active =
      this.activeRouteId === "chat" &&
      areUiSessionKeysEquivalent(this.getRouteSessionKey(), mainKey);
    const stateBadge = mainRow?.hasActiveRun
      ? html`<span
          class="session-run-spinner nav-item__state"
          role="img"
          aria-label=${t("sessionsView.activeRun")}
          title=${t("sessionsView.activeRun")}
        ></span>`
      : mainRow?.unread === true && !active
        ? html`<span
            class="session-unread-dot nav-item__state"
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
          ? html`<span
              class="sidebar-board-glyph"
              role="img"
              aria-label=${t("sessionsView.dashboardAvailable")}
              title=${t("sessionsView.dashboardAvailable")}
              >${icons.barChart}</span
            >`
          : nothing}
        ${stateBadge}
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
    const gatewayStatus = t("chat.gatewayStatus", {
      status: this.connected ? t("common.online") : t("common.offline"),
    });
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
        <openclaw-sidebar-build-chip
          .basePath=${this.basePath}
          .gatewayVersion=${this.gatewayVersion}
          .onNavigate=${(routeId: "about") => this.onNavigate?.(routeId)}
        ></openclaw-sidebar-build-chip>
        ${this.debouncedDisconnected
          ? html`<span
              class="sidebar-footer-bar__status"
              role="status"
              aria-live="polite"
              title=${gatewayStatus}
              ><span class="sidebar-footer-bar__status-dot" aria-hidden="true"></span>${t(
                "common.offline",
              )}</span
            >`
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
  ) {
    if (entry.type === "route" && !this.isRouteEnabled(entry.route)) {
      return nothing;
    }
    const serialized = serializeSidebarEntry(entry);
    const dropPosition =
      this.sidebarZoneDropTarget?.entry === serialized ? this.sidebarZoneDropTarget.position : null;
    const content =
      entry.type === "route"
        ? this.renderRoute(entry.route)
        : sessionRows.has(entry.key)
          ? this.renderPinnedSidebarSession(sessionRows.get(entry.key)!)
          : nothing;
    return html`
      <div
        class="sidebar-zone-entry ${dropPosition
          ? `sidebar-zone-entry--drop-${dropPosition}`
          : ""} ${this.draggingSidebarEntry === serialized ? "sidebar-zone-entry--dragging" : ""}"
        data-sidebar-entry=${serialized}
        draggable=${entry.type === "route" ? "true" : "false"}
        @dragstart=${entry.type === "route"
          ? (event: DragEvent) => this.startSidebarRouteDrag(event, entry.route)
          : nothing}
        @dragend=${entry.type === "route" ? () => this.finishSidebarEntryDrag() : nothing}
        @dragover=${(event: DragEvent) => this.handleSidebarZoneDragOver(event, serialized)}
        @drop=${(event: DragEvent) => this.handleSidebarZoneDrop(event, serialized)}
      >
        ${content}
      </div>
    `;
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
                  this.renderSidebarZoneEntry(entry, sidebarZone.sessionRows),
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
              .mode=${resolveLobsterPetMode(this.connected, this.sessionsResult?.sessions)}
              .runOutcome=${resolveLobsterRunOutcome(this.sessionsResult?.sessions)}
              .visitsEnabled=${this.lobsterPetVisits}
              .soundsEnabled=${this.lobsterPetSounds}
              .gatewayVersion=${this.gatewayVersion}
            ></openclaw-lobster-pet>
            ${this.devGitBranch
              ? html`<div class="sidebar-footer-branch" title=${this.devGitBranch}>
                  <span class="sidebar-footer-branch__icon" aria-hidden="true"
                    >${icons.gitBranch}</span
                  >
                  <span class="sidebar-footer-branch__name">${this.devGitBranch}</span>
                </div>`
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
