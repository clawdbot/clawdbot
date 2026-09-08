import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type { ControlUiEnvironment } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { t } from "../i18n/index.ts";
import { IdentityAvatarController } from "../lib/identity-avatar-loader.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";

/** Sidebar identity row: who you're talking to. The whole body opens the
    agent menu (switcher + utilities) — the conversation itself lives on the
    Home page row, so this row carries profile semantics only. */
class SidebarAgentCard extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) agentName = "";
  @property({ attribute: false }) avatarUrl: string | null = null;
  @property({ attribute: false }) avatarAuthReady = false;
  @property({ attribute: false }) avatarText = "";
  @property({ attribute: false }) environment: ControlUiEnvironment | null = null;
  @property({ attribute: false }) menuOpen = false;
  /** Unread sessions exist on non-active agents; surfaces on the avatar. */
  @property({ attribute: false }) menuUnread = false;
  /** More than one agent is configured; labels the menu as a switcher. */
  @property({ attribute: false }) switcherAvailable = false;
  @property({ attribute: false }) onToggleMenu?: (trigger: HTMLElement) => void;
  @property({ attribute: false })
  onMenuPointerEnter?: (trigger: HTMLElement, event: PointerEvent) => void;
  @property({ attribute: false }) onMenuPointerLeave?: () => void;

  private readonly avatarLoader = new IdentityAvatarController(this);

  override render() {
    return this.avatarLoader.withActiveRoutes(() => this.renderContent());
  }

  private renderContent() {
    const sourceUrl = this.avatarUrl;
    const avatarUrl =
      sourceUrl && (!sourceUrl.startsWith("/") || this.avatarAuthReady)
        ? this.avatarLoader.resolve(sourceUrl)
        : null;
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
            class="sidebar-agent-card__avatar ${
              this.environment ? "sidebar-agent-card__avatar--environment" : ""
            }"
          >
            ${
              avatarUrl && sourceUrl
                ? keyed(
                    avatarUrl,
                    html`<img
                      src=${avatarUrl}
                      alt=""
                      aria-hidden="true"
                      loading="lazy"
                      decoding="async"
                      @error=${this.avatarLoader.imageErrorHandler(sourceUrl)}
                    />`,
                  )
                : html`<span class="sidebar-agent-card__avatar-text" aria-hidden="true"
                    >${this.avatarText}</span
                  >`
            }
            ${
              this.menuUnread && !this.menuOpen
                ? html`<span
                    class="session-unread-dot sidebar-agent-card__menu-unread"
                    role="img"
                    aria-label=${t("sessionsView.unread")}
                  ></span>`
                : nothing
            }
          </span>
          <span class="sidebar-agent-card__text">
            <span class="sidebar-agent-card__name">
              <span class="sidebar-agent-card__name-text">${this.agentName}</span>
              <span class="sidebar-agent-card__chevron" aria-hidden="true"
                >${icons.chevronsUpDown}</span
              >
            </span>
            ${
              this.environment
                ? html`<span class="sidebar-agent-card__subtitle-row">
                    <span class="control-ui-environment-pill">${this.environment.label}</span>
                  </span>`
                : nothing
            }
          </span>
        </button>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-sidebar-agent-card")) {
  customElements.define("openclaw-sidebar-agent-card", SidebarAgentCard);
}
