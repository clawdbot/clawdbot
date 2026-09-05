import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { NearViewportObserver } from "../../components/near-viewport-observer.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

class OpenClawDashboardPreview extends OpenClawLightDomElement {
  @property({ attribute: false }) gatewaySnapshot?: ApplicationGatewaySnapshot;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId?: string;
  @property({ attribute: false }) error: string | null = null;

  private readonly visibility = new NearViewportObserver(200, () => this.requestUpdate());
  private observationFrame = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    window.cancelAnimationFrame(this.observationFrame);
    // Measure after the first paint; connected elements report zero-sized bounds
    // before layout and would otherwise activate every gallery preview at once.
    this.observationFrame = window.requestAnimationFrame(() => this.visibility.observe(this));
  }

  override disconnectedCallback(): void {
    window.cancelAnimationFrame(this.observationFrame);
    this.visibility.disconnect();
    super.disconnectedCallback();
  }

  override render() {
    if (!this.visibility.nearVisible) {
      return nothing;
    }
    return this.error
      ? html`<div class="dashboard-preview__error">
          ${t("dashboardDocument.loadFailed", { error: this.error })}
        </div>`
      : html`<openclaw-board-document
          .passive=${true}
          .gatewaySnapshot=${this.gatewaySnapshot}
          .preparedSession=${{ sessionKey: this.sessionKey, agentId: this.agentId }}
        ></openclaw-board-document>`;
  }
}

if (!customElements.get("openclaw-dashboard-preview")) {
  customElements.define("openclaw-dashboard-preview", OpenClawDashboardPreview);
}
