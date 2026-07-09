import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./dashboard-header.ts";
import "./tooltip.ts";

class AppTopbar extends OpenClawLightDomElement {
  @property({ attribute: false }) routeId?: NavigationRouteId;
  @property({ attribute: false }) navDrawerOpen = false;
  @property({ attribute: false }) onboarding = false;
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) agentLabel = "";
  @property({ attribute: false }) overviewHref = "";
  @property({ attribute: false }) onToggleDrawer?: (trigger: HTMLElement) => void;
  @property({ attribute: false }) onOpenPalette?: () => void;
  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;
  @property({ attribute: false }) searchDisabled = false;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  private readonly handleNavigate = (event: CustomEvent<NavigationRouteId>) => {
    this.onNavigate?.(event.detail);
  };

  override render() {
    const drawerLabel = this.navDrawerOpen ? t("nav.collapse") : t("nav.expand");
    return html`
      <header
        class="topbar"
        ?inert=${this.onboarding}
        aria-hidden=${this.onboarding ? "true" : nothing}
      >
        <div class="topnav-shell">
          <openclaw-tooltip .content=${drawerLabel}>
            <button
              type="button"
              class="topbar-icon-btn topbar-nav-toggle"
              @click=${(event: MouseEvent) =>
                this.onToggleDrawer?.(event.currentTarget as HTMLElement)}
              aria-label=${drawerLabel}
              aria-expanded=${String(this.navDrawerOpen)}
            >
              <span class="nav-collapse-toggle__icon" aria-hidden="true">${icons.menu}</span>
            </button>
          </openclaw-tooltip>
          <div class="topnav-shell__content">
            <div class="topbar-brand" aria-label="OpenClaw">
              <img
                class="topbar-brand__logo"
                src=${controlUiPublicAssetPath("apple-touch-icon.png", this.basePath)}
                alt=""
                aria-hidden="true"
              />
              <span class="topbar-brand__title">OpenClaw</span>
            </div>
            <dashboard-header
              .routeId=${this.routeId}
              .basePath=${this.basePath}
              .agentLabel=${this.agentLabel}
              .overviewHref=${this.overviewHref}
              @navigate=${this.handleNavigate}
            ></dashboard-header>
          </div>
          <div class="topnav-shell__actions">
            <openclaw-tooltip .content=${t("chat.commandPaletteTitle")}>
              <button
                class="topbar-search"
                ?disabled=${this.searchDisabled || !this.onOpenPalette}
                @click=${() => this.onOpenPalette?.()}
                aria-label=${t("chat.openCommandPalette")}
              >
                ${icons.search}
              </button>
            </openclaw-tooltip>
          </div>
        </div>
      </header>
    `;
  }
}

if (!customElements.get("openclaw-app-topbar")) {
  customElements.define("openclaw-app-topbar", AppTopbar);
}
