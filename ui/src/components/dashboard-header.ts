// Control UI component implements the dashboard header element.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";

class DashboardHeader extends OpenClawLightDomElement {
  @property() routeId?: NavigationRouteId;
  @property() basePath = "";
  @property() agentLabel = "";
  @property() overviewHref = "";

  private readonly handleOverviewClick = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("navigate", { detail: "overview", bubbles: true, composed: true }),
    );
  };

  override render() {
    const label = this.routeId ? titleForRoute(this.routeId) : "";
    const rawAgentLabel = this.agentLabel.trim();
    // Skip the agent crumb when it repeats the brand crumb ("OpenClaw › OpenClaw › …").
    const agentLabel = rawAgentLabel.toLowerCase() === "openclaw" ? "" : rawAgentLabel;

    return html`
      <div class="dashboard-header">
        <div class="dashboard-header__breadcrumb">
          ${this.overviewHref
            ? html`
                <a
                  class="dashboard-header__breadcrumb-link"
                  href=${this.overviewHref}
                  @click=${this.handleOverviewClick}
                >
                  OpenClaw
                </a>
              `
            : html`<span class="dashboard-header__breadcrumb-link">OpenClaw</span>`}
          ${agentLabel
            ? html`
                <span class="dashboard-header__breadcrumb-segment">
                  <span class="dashboard-header__breadcrumb-sep">›</span>
                  <span class="dashboard-header__breadcrumb-context" title=${agentLabel}>
                    ${agentLabel}
                  </span>
                </span>
              `
            : nothing}
          <span class="dashboard-header__breadcrumb-sep">›</span>
          <span class="dashboard-header__breadcrumb-current">${label}</span>
        </div>
        <div class="dashboard-header__actions">
          <slot></slot>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("dashboard-header")) {
  customElements.define("dashboard-header", DashboardHeader);
}
