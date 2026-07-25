// Control UI component renders gateway URL confirmation.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import "./modal-dialog.ts";

type GatewayUrlConfirmationProps = {
  pendingGatewayUrl: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

function renderGatewayUrlConfirmation(props: GatewayUrlConfirmationProps) {
  if (!props.pendingGatewayUrl) {
    return nothing;
  }
  const titleId = "gateway-url-confirmation-title";
  const descriptionId = "gateway-url-confirmation-description";
  const title = t("channels.gatewayUrlConfirmation.title");
  const description = t("channels.gatewayUrlConfirmation.subtitle");

  return html`
    <openclaw-modal-dialog
      label=${title}
      description=${description}
      @modal-cancel=${props.onCancel}
    >
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div id=${titleId} class="exec-approval-title">${title}</div>
            <div id=${descriptionId} class="exec-approval-sub">${description}</div>
          </div>
        </div>
        <div class="exec-approval-command mono">${props.pendingGatewayUrl}</div>
        <div class="callout danger" style="margin-top: 12px;">
          ${t("channels.gatewayUrlConfirmation.warning")}
        </div>
        <div class="exec-approval-actions">
          <button class="btn primary" @click=${props.onConfirm}>${t("common.confirm")}</button>
          <button class="btn" @click=${props.onCancel}>${t("common.cancel")}</button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

class GatewayUrlConfirmation extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: GatewayUrlConfirmationProps;

  override render() {
    return this.props ? renderGatewayUrlConfirmation(this.props) : nothing;
  }
}

if (!customElements.get("openclaw-gateway-url-confirmation")) {
  customElements.define("openclaw-gateway-url-confirmation", GatewayUrlConfirmation);
}
