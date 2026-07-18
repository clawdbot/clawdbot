import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import "./menu-surface.ts";
import "./session-menu.ts";
import "./sidebar-agent-card.ts";
import "./sidebar-attention.ts";
import "./sidebar-build-chip.ts";
import "./sidebar-update-card.ts";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent, normalizeAgentId } from "../lib/sessions/session-key.ts";
import { shouldHandleNavigationClick } from "./app-sidebar-nav-menus.ts";
import { AppSidebarSessionListElement } from "./app-sidebar-session-list.ts";
import { icons } from "./icons.ts";
import {
  LOBSTER_LOGO_VISIT_EVENT,
  LOBSTER_PET_BUILD_MULS,
  LOBSTER_PET_CLAW_MULS,
  lobsterPetSeed,
  renderLobsterSvg,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
  type LobsterLogoVisitDetail,
} from "./lobster-pet.ts";

const PALETTE_SHORTCUT = /Mac|iP(hone|ad|od)/i.test(globalThis.navigator?.platform ?? "")
  ? "⌘K"
  : "Ctrl K";

class AppSidebar extends AppSidebarSessionListElement {
  @state() private logoVisit: LobsterLogoVisitDetail | null = null;

  constructor() {
    super();
    // The footer pet announces logo stand-in phases through this bubbling event.
    this.addEventListener(LOBSTER_LOGO_VISIT_EVENT, this.handleLogoVisit as EventListener);
  }

  private readonly handleLogoVisit = (event: Event) => {
    const detail = (event as CustomEvent<LobsterLogoVisitDetail>).detail;
    this.logoVisit = detail.phase === "out" || !detail.look ? null : detail;
  };

  private renderLogoStandIn() {
    const visit = this.logoVisit;
    if (!visit?.look) {
      return nothing;
    }
    const look = visit.look;
    const classes = [
      "sidebar-brand__pet",
      `lobster-pet--palette-${look.palette.id}`,
      visit.phase === "leaving" ? "sidebar-brand__pet--leaving" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const style = [
      `--lob-shell:${look.palette.shell}`,
      `--lob-claw:${look.palette.claw}`,
      `--lob-blink-delay:${look.blinkDelayS}s`,
      `--lob-w:${LOBSTER_PET_BUILD_MULS[look.build].w}`,
      `--lob-h:${LOBSTER_PET_BUILD_MULS[look.build].h}`,
      `--lob-claw-scale:${LOBSTER_PET_CLAW_MULS[look.clawSize]}`,
    ].join(";");
    return html`
      <span class=${classes} style=${style} title=${`${visit.name} · filling in for the logo`}
        >${renderLobsterSvg(look)}</span
      >
    `;
  }

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
    return html`
      <div class="sidebar-brand">
        <openclaw-sidebar-agent-card
          .agentName=${cardName}
          .avatarUrl=${cardAgent ? resolveAgentAvatarUrl(cardAgent) : null}
          .avatarText=${cardAvatarText}
          .connected=${this.connected}
          .statusLabel=${gatewayStatus}
          .subtitle=${this.agentChipSubtitle(cardAgentId)}
          .menuOpen=${this.agentMenuPosition !== null}
          .menuUnread=${menuUnread}
          .switcherAvailable=${cardAgents.length > 1}
          .onToggleMenu=${(trigger: HTMLElement) => this.toggleAgentMenu(trigger)}
        ></openclaw-sidebar-agent-card>
        <div class="sidebar-brand__actions">
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

  /** Home: the first page. Opens the agent's rolling main session and carries
      its unread/running state; later grows into the docked dashboard surface. */
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
          ${this.renderLogoStandIn()}
        </span>
        <openclaw-sidebar-build-chip
          .basePath=${this.basePath}
          .gatewayVersion=${this.gatewayVersion}
          .onNavigate=${(routeId: "about") => this.onNavigate?.(routeId)}
        ></openclaw-sidebar-build-chip>
        <span
          class="sidebar-footer-bar__status ${this.connected
            ? "sidebar-connection-status--online"
            : "sidebar-connection-status--offline"}"
          role="img"
          aria-live="polite"
          aria-label=${gatewayStatus}
          title=${gatewayStatus}
        ></span>
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

  override render() {
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
              <div class="nav-section__items">
                ${this.renderHomeRow()}
                ${this.sidebarPinnedRoutes.map((routeId) => this.renderRoute(routeId))}
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
