import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import "./menu-surface.ts";
import "./session-menu.ts";
import "./sidebar-agent-chip.ts";
import "./sidebar-attention.ts";
import "./sidebar-build-chip.ts";
import "./sidebar-update-card.ts";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
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
    return html`
      <div class="sidebar-brand">
        <a
          class="sidebar-brand__identity"
          href=${pathForRoute("new-session", this.basePath)}
          aria-label=${titleForRoute("new-session")}
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.onNavigate?.("new-session");
          }}
        >
          <span class="sidebar-brand__logo-slot">
            <img
              class="sidebar-brand__logo ${this.logoVisit ? "sidebar-brand__logo--vacated" : ""}"
              src=${controlUiPublicAssetPath("apple-touch-icon.png", this.basePath)}
              alt=""
              aria-hidden="true"
            />
            ${this.renderLogoStandIn()}
          </span>
          <span class="sidebar-brand__title">OpenClaw</span>
        </a>
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
    const gatewayStatus = t("chat.gatewayStatus", {
      status: this.connected ? t("common.online") : t("common.offline"),
    });
    const { activeId: chipAgentId, agent: chipAgent, agents: chipAgents } = this.activeChipAgent();
    const chipMenuUnread = chipAgents.some((entry) => {
      const agentId = normalizeAgentId(entry.id);
      return agentId !== chipAgentId && this.agentUnreadCount(agentId) > 0;
    });
    const chipName = chipAgent ? normalizeAgentLabel(chipAgent) : chipAgentId;
    const chipAvatarText =
      (chipAgent ? resolveAgentTextAvatar(chipAgent) : null) ??
      (chipName || chipAgentId).slice(0, 1).toUpperCase();
    return html`
      <aside class="sidebar">
        <div class="sidebar-shell" @mousedown=${beginNativeWindowDragFromTopInset}>
          ${this.renderBrand()}
          <div class="sidebar-shell__body">
            <nav class="sidebar-nav" @contextmenu=${this.openCustomizeMenuFromContext}>
              <div class="nav-section__items">
                ${this.sidebarPinnedRoutes.map((routeId) => this.renderRoute(routeId))}
                ${this.renderMoreRow()}
              </div>
            </nav>
            ${this.renderSessions()}
          </div>
          <div class="sidebar-shell__footer">
            <openclaw-sidebar-attention
              .onNavigate=${(routeId: NavigationRouteId) => this.onNavigate?.(routeId)}
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
            <openclaw-sidebar-agent-chip
              .agentName=${chipName}
              .avatarUrl=${chipAgent ? resolveAgentAvatarUrl(chipAgent) : null}
              .avatarText=${chipAvatarText}
              .connected=${this.connected}
              .statusLabel=${gatewayStatus}
              .subtitle=${this.agentChipSubtitle(chipAgentId)}
              .menuOpen=${this.agentMenuPosition !== null}
              .menuUnread=${chipMenuUnread}
              .newSessionDisabled=${!this.connected}
              .onNewSession=${() => this.onOpenNewSession?.(chipAgentId)}
              .onToggleMenu=${(trigger: HTMLElement) => this.toggleAgentMenu(trigger)}
            ></openclaw-sidebar-agent-chip>
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
