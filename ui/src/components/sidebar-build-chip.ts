import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { pathForRoute } from "../app-route-paths.ts";
import { CONTROL_UI_BUILD_INFO, type ControlUiBuildInfo } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { formatTimeAgo } from "../lib/format.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import "./tooltip.ts";

const BRANCH_DISPLAY_LENGTH = 14;

export function formatBuildChipText(info: ControlUiBuildInfo, nowMs: number): string | null {
  if (!info.commit) {
    return null;
  }
  const branch =
    info.branch && info.branch !== "main"
      ? `${info.branch.length > BRANCH_DISPLAY_LENGTH ? `${info.branch.slice(0, BRANCH_DISPLAY_LENGTH)}…` : info.branch}@`
      : "";
  const commit = `${info.commit.slice(0, 7)}${info.dirty === true ? "*" : ""}`;
  if (!info.builtAt) {
    return `${branch}${commit}`;
  }
  const builtAtMs = Date.parse(info.builtAt);
  if (Number.isNaN(builtAtMs)) {
    return `${branch}${commit}`;
  }
  const age = formatTimeAgo(Math.max(0, nowMs - builtAtMs), { suffix: false });
  return `${branch}${commit} · ${age}`;
}

function shouldHandleNavigationClick(event: MouseEvent): boolean {
  // Preserve browser behavior for modified clicks and non-primary buttons.
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

class SidebarBuildChip extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) gatewayVersion: string | null = null;
  @property({ attribute: false }) onNavigate?: (routeId: "about") => void;

  private ageTimer: ReturnType<typeof setInterval> | undefined;

  override connectedCallback() {
    super.connectedCallback();
    // Relative age must advance without sidebar renders; teardown keeps tests and reconnects clean.
    this.ageTimer = setInterval(() => this.requestUpdate(), 60_000);
  }

  override disconnectedCallback() {
    if (this.ageTimer !== undefined) {
      clearInterval(this.ageTimer);
      this.ageTimer = undefined;
    }
    super.disconnectedCallback();
  }

  override render() {
    const text = formatBuildChipText(CONTROL_UI_BUILD_INFO, Date.now());
    if (!text) {
      return nothing;
    }
    const summary = [
      CONTROL_UI_BUILD_INFO.version ? `v${CONTROL_UI_BUILD_INFO.version}` : null,
      CONTROL_UI_BUILD_INFO.branch,
      CONTROL_UI_BUILD_INFO.dirty === true ? "dirty" : null,
    ]
      .filter((line): line is string => line !== null)
      .join(" · ");
    const tooltip = [
      summary,
      CONTROL_UI_BUILD_INFO.commit,
      CONTROL_UI_BUILD_INFO.builtAt
        ? `${t("aboutPage.built")}: ${CONTROL_UI_BUILD_INFO.builtAt}`
        : null,
      this.gatewayVersion ? `${t("aboutPage.gatewayVersion")}: ${this.gatewayVersion}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    return html`
      <openclaw-tooltip .content=${tooltip}>
        <a
          class="sidebar-footer-build"
          href=${pathForRoute("about", this.basePath)}
          aria-label=${t("aboutPage.artifactDetails")}
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.onNavigate?.("about");
          }}
          >${text}</a
        >
      </openclaw-tooltip>
    `;
  }
}

if (globalThis.customElements && !customElements.get("openclaw-sidebar-build-chip")) {
  customElements.define("openclaw-sidebar-build-chip", SidebarBuildChip);
}
