import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { pathForRoute } from "../app-route-paths.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import "../styles/sidebar-footer-update.css";
import {
  formatBuildChipText,
  formatSettingsBuildLabel,
  formatSidebarBuildSubtitle,
  renderSidebarServerDetails,
} from "./sidebar-build-chip-format.ts";
import "./tooltip.ts";

class SidebarBuildChip extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) gatewayVersion: string | null = null;
  @property({ attribute: false }) updateAttentionDismissed = false;
  @property({ attribute: false }) onNavigate?: (routeId: "about") => void;
  @property({ attribute: false }) variant: "compact" | "identity" | "settings" = "compact";

  override render() {
    const text =
      this.variant === "settings"
        ? formatSettingsBuildLabel(CONTROL_UI_BUILD_INFO, this.gatewayVersion)
        : this.variant === "identity"
          ? this.updateAttentionDismissed
            ? formatSettingsBuildLabel(CONTROL_UI_BUILD_INFO, this.gatewayVersion)
            : formatSidebarBuildSubtitle(CONTROL_UI_BUILD_INFO)
          : formatBuildChipText(CONTROL_UI_BUILD_INFO);
    if (!text && !this.updateAttentionDismissed) {
      return nothing;
    }
    return html`
      <openclaw-tooltip class="sidebar-hover-tooltip" .delay=${600} .closeDelay=${300}>
        <a
          class="sidebar-footer-build"
          href=${pathForRoute("about", this.basePath)}
          aria-label=${this.updateAttentionDismissed
            ? `${t("aboutPage.artifactDetails")}. ${t("updates.sidebar.availableTitle")}`
            : t("aboutPage.artifactDetails")}
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.onNavigate?.("about");
          }}
          >${text ? html`<span class="sidebar-footer-build__text">${text}</span>` : nothing}
          ${this.updateAttentionDismissed
            ? html`<span class="agent-select__badge sidebar-footer-build__update"
                >${t("updates.sidebar.availableTitle")}</span
              >`
            : nothing}</a
        >
        <div slot="content" class="sidebar-hover-card sidebar-build-hover-card">
          ${renderSidebarServerDetails(CONTROL_UI_BUILD_INFO, this.gatewayVersion)}
        </div>
      </openclaw-tooltip>
    `;
  }
}

if (globalThis.customElements && !customElements.get("openclaw-sidebar-build-chip")) {
  customElements.define("openclaw-sidebar-build-chip", SidebarBuildChip);
}
