import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { ControlUiEnvironment } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { t } from "../i18n/index.ts";
import { AuthenticatedAvatarRouteLoader } from "../lib/authenticated-avatar-route.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";

/** Sidebar identity row: who you're talking to. The whole body opens the
    agent menu (switcher + utilities) — the conversation itself lives on the
    Home page row, so this row carries profile semantics only. */
class SidebarAgentCard extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) agentName = "";
  @property({ attribute: false }) avatarUrl: string | null = null;
  @property({ attribute: false }) authToken: string | null = null;
  @property({ attribute: false }) avatarAuthReady = false;
  @property({ attribute: false }) avatarText = "";
  @property({ attribute: false }) subtitle = "";
  @property({ attribute: false }) environment: ControlUiEnvironment | null = null;
  @property({ attribute: false }) menuOpen = false;
  /** Unread sessions exist on non-active agents; surfaces next to the name. */
  @property({ attribute: false }) menuUnread = false;
  /** More than one agent is configured; labels the menu as a switcher. */
  @property({ attribute: false }) switcherAvailable = false;
  @property({ attribute: false }) onToggleMenu?: (trigger: HTMLElement) => void;
  @property({ attribute: false })
  onMenuPointerEnter?: (trigger: HTMLElement, event: PointerEvent) => void;
  @property({ attribute: false }) onMenuPointerLeave?: () => void;

  private readonly avatarLoader = new AuthenticatedAvatarRouteLoader(this);

  override render() {
    return this.avatarLoader.withActiveRoutes(() => this.renderContent());
  }

  private renderContent() {
    const avatarUrl = this.avatarUrl?.startsWith("/")
      ? this.avatarAuthReady
        ? this.avatarLoader.resolve(this.avatarUrl, this.authToken ? [this.authToken] : [])
        : null
      : this.avatarUrl;
    const menuLabel = this.switcherAvailable
      ? t("agentChip.switchAgent")
      : t("agentChip.menuLabel");
    return html`
      <div class="sidebar-agent-card ${this.menuOpen ? "sidebar-agent-card--open" : ""}">
        <button
          type="button"
          class="sidebar-agent-card__main"
          aria-haspopup="menu"
          aria-expanded=${String(this.menuOpen)}
          aria-label="${this.agentName} · ${menuLabel}"
          @pointerenter=${(event: PointerEvent) => {
            if (this.switcherAvailable && event.currentTarget instanceof HTMLElement) {
              this.onMenuPointerEnter?.(event.currentTarget, event);
            }
          }}
          @pointerleave=${() => this.onMenuPointerLeave?.()}
          @pointerdown=${(event: PointerEvent) => {
            // The portaled menu has a hidden trigger; keep its outside-click
            // handler from dismissing hover-open state before click can pin it.
            event.stopPropagation();
          }}
          @click=${(event: MouseEvent) => {
            event.stopPropagation();
            if (event.currentTarget instanceof HTMLElement) {
              this.onToggleMenu?.(event.currentTarget);
            }
          }}
        >
          <span
            class="sidebar-agent-card__avatar ${this.environment
              ? "sidebar-agent-card__avatar--environment"
              : ""}"
          >
            ${avatarUrl
              ? html`<img
                  src=${avatarUrl}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                  decoding="async"
                />`
              : html`<span class="sidebar-agent-card__avatar-text" aria-hidden="true"
                  >${this.avatarText}</span
                >`}
          </span>
          <span class="sidebar-agent-card__text">
            <span class="sidebar-agent-card__name">
              ${this.agentName}
              <span class="sidebar-agent-card__chevron" aria-hidden="true"
                >${icons.chevronDown}</span
              >
            </span>
            ${this.subtitle || this.environment
              ? html`<span class="sidebar-agent-card__subtitle-row">
                  ${this.subtitle
                    ? html`<span class="sidebar-agent-card__subtitle">${this.subtitle}</span>`
                    : nothing}
                  ${this.environment
                    ? html`<span class="control-ui-environment-pill"
                        >${this.environment.label}</span
                      >`
                    : nothing}
                </span>`
              : nothing}
          </span>
          ${this.menuUnread && !this.menuOpen
            ? html`<span
                class="session-unread-dot sidebar-agent-card__menu-unread"
                role="img"
                aria-label=${t("sessionsView.unread")}
              ></span>`
            : nothing}
        </button>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-sidebar-agent-card")) {
  customElements.define("openclaw-sidebar-agent-card", SidebarAgentCard);
}
