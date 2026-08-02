import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

/** Sidebar identity row: who you're talking to. The whole body opens the
    agent menu (switcher + utilities) — the conversation itself lives on the
    Home page row, so this row carries profile semantics only. */
class SidebarAgentCard extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) agentName = "";
  @property({ attribute: false }) avatarUrl: string | null = null;
  @property({ attribute: false }) avatarText = "";
  @property({ attribute: false }) subtitle = "";
  @property({ attribute: false }) menuOpen = false;
  /** Unread sessions exist on non-active agents; surfaces next to the name. */
  @property({ attribute: false }) menuUnread = false;
  @property({ attribute: false }) approvalCount = 0;
  /** More than one agent is configured; labels the menu as a switcher. */
  @property({ attribute: false }) switcherAvailable = false;
  @property({ attribute: false }) onToggleMenu?: (trigger: HTMLElement) => void;

  override render() {
    const menuLabel = this.switcherAvailable
      ? t("agentChip.switchAgent")
      : t("agentChip.menuLabel");
    const approvalLabel = t(
      this.approvalCount === 1 ? "execApproval.agentPendingOne" : "execApproval.agentPending",
      { count: String(this.approvalCount) },
    );
    return html`
      <div class="sidebar-agent-card ${this.menuOpen ? "sidebar-agent-card--open" : ""}">
        <button
          type="button"
          class="sidebar-agent-card__main"
          aria-haspopup="menu"
          aria-expanded=${String(this.menuOpen)}
          aria-label="${this.agentName} · ${menuLabel}${this.approvalCount > 0
            ? ` · ${approvalLabel}`
            : ""}"
          @click=${(event: MouseEvent) => this.onToggleMenu?.(event.currentTarget as HTMLElement)}
        >
          <span class="sidebar-agent-card__avatar">
            ${this.avatarUrl
              ? html`<img
                  src=${this.avatarUrl}
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
            ${this.subtitle
              ? html`<span class="sidebar-agent-card__subtitle">${this.subtitle}</span>`
              : nothing}
          </span>
          ${this.approvalCount > 0
            ? html`<openclaw-tooltip .content=${approvalLabel}>
                <span
                  class="sidebar-agent-approval-count sidebar-agent-card__approval-count"
                  aria-label=${approvalLabel}
                  >${this.approvalCount}</span
                >
              </openclaw-tooltip>`
            : nothing}
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
