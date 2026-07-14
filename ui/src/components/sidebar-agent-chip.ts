import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

/** Sidebar footer identity chip: the beginner-facing entrance to the active
    agent. The body opens the agent/utility menu owned by app-sidebar; the
    trailing control creates a session. */
class SidebarAgentChip extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) agentName = "";
  @property({ attribute: false }) avatarUrl: string | null = null;
  @property({ attribute: false }) avatarText = "";
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) statusLabel = "";
  @property({ attribute: false }) subtitle = "";
  @property({ attribute: false }) menuOpen = false;
  /** Unread sessions exist on non-active agents; surfaces on the menu toggle. */
  @property({ attribute: false }) menuUnread = false;
  @property({ attribute: false }) newSessionDisabled = false;
  @property({ attribute: false }) onNewSession?: () => void;
  @property({ attribute: false }) onToggleMenu?: (trigger: HTMLElement) => void;

  override render() {
    return html`
      <div class="sidebar-agent-chip">
        <button
          type="button"
          class="sidebar-agent-chip__main ${this.menuOpen ? "sidebar-agent-chip__main--open" : ""}"
          aria-haspopup="menu"
          aria-expanded=${String(this.menuOpen)}
          aria-label="${this.agentName} · ${t("agentChip.menuLabel")}"
          @click=${(event: MouseEvent) => this.onToggleMenu?.(event.currentTarget as HTMLElement)}
        >
          <span class="sidebar-agent-chip__avatar">
            ${this.avatarUrl
              ? html`<img
                  src=${this.avatarUrl}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                  decoding="async"
                />`
              : html`<span class="sidebar-agent-chip__avatar-text" aria-hidden="true"
                  >${this.avatarText}</span
                >`}
            <span
              class="sidebar-agent-chip__presence ${this.connected
                ? "sidebar-connection-status--online"
                : "sidebar-connection-status--offline"}"
              role="img"
              aria-live="polite"
              aria-label=${this.statusLabel}
              title=${this.statusLabel}
            ></span>
          </span>
          <span class="sidebar-agent-chip__text">
            <span class="sidebar-agent-chip__name">${this.agentName}</span>
            ${this.subtitle
              ? html`<span class="sidebar-agent-chip__subtitle">${this.subtitle}</span>`
              : nothing}
          </span>
          ${this.menuUnread && !this.menuOpen
            ? html`<span
                class="session-unread-dot sidebar-agent-chip__menu-unread"
                role="img"
                aria-label=${t("sessionsView.unread")}
              ></span>`
            : nothing}
        </button>
        <openclaw-tooltip .content=${t("chat.runControls.newSession")}>
          <button
            type="button"
            class="sidebar-agent-chip__action"
            aria-label=${t("chat.runControls.newSession")}
            ?disabled=${this.newSessionDisabled}
            @click=${() => this.onNewSession?.()}
          >
            ${icons.plus}
          </button>
        </openclaw-tooltip>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-sidebar-agent-chip")) {
  customElements.define("openclaw-sidebar-agent-chip", SidebarAgentChip);
}
