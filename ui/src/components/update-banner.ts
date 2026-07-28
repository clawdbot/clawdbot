// Control UI component renders update status and available-update actions.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";

type UpdateBannerProps = {
  statusBanner: { tone: "danger" | "warn" | "info"; text: string } | null;
  action?: { label: string; onClick: () => void };
};

class UpdateBanner extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: UpdateBannerProps;

  override render() {
    const props = this.props;
    if (!props) {
      return nothing;
    }
    return html`
      ${props.statusBanner
        ? html`<div
            class="callout ${props.statusBanner.tone} ${props.action ? "callout--action" : ""}"
            role=${props.action ? "status" : "alert"}
          >
            <span class="callout__content">${props.statusBanner.text}</span>
            ${props.action
              ? html`<button class="btn btn--sm" type="button" @click=${props.action.onClick}>
                  ${props.action.label}
                </button>`
              : nothing}
          </div>`
        : nothing}
    `;
  }
}

if (!customElements.get("openclaw-update-banner")) {
  customElements.define("openclaw-update-banner", UpdateBanner);
}
