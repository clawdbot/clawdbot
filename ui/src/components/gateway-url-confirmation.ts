// Control UI component asks before a link moves this browser to another Gateway.
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { formatGatewayHost } from "../lib/gateway-host.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";

type GatewayUrlConfirmationProps = {
  pendingGatewayUrl: string | null;
  /** The Gateway this browser is connected to (or was last configured for). */
  currentGatewayUrl: string;
  /** True when the link itself carries a token for the new Gateway. */
  linkCarriesToken: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

function renderGatewayUrlConfirmation(props: GatewayUrlConfirmationProps) {
  if (!props.pendingGatewayUrl) {
    return nothing;
  }
  const title = t("connection.switchGateway.title");
  const summary = t("connection.switchGateway.summary");
  const currentHost = formatGatewayHost(props.currentGatewayUrl);
  const nextHost = formatGatewayHost(props.pendingGatewayUrl);
  // Tokens are origin-scoped: a different origin never receives the saved one.
  const credentialStaysHome =
    Boolean(props.currentGatewayUrl.trim()) &&
    gatewayOriginScope(props.currentGatewayUrl) !== gatewayOriginScope(props.pendingGatewayUrl);
  const notes = [
    t("connection.switchGateway.note"),
    props.linkCarriesToken ? t("connection.switchGateway.noteToken") : null,
    credentialStaysHome ? t("connection.switchGateway.noteScoped", { host: currentHost }) : null,
  ].filter(Boolean);

  return html`
    <openclaw-modal-dialog label=${title} description=${summary} @modal-cancel=${props.onCancel}>
      <div class="gateway-switch">
        <div class="gateway-switch__head">
          <span class="gateway-switch__icon" aria-hidden="true">${icons.shieldAlert}</span>
          <div class="gateway-switch__text">
            <h2 class="gateway-switch__title">${title}</h2>
            <p class="gateway-switch__summary">${summary}</p>
          </div>
        </div>
        <div class="gateway-switch__hosts">
          <div class="gateway-switch__host">
            <span class="gateway-switch__label">${t("connection.switchGateway.current")}</span>
            <code translate="no">${props.currentGatewayUrl.trim() || t("common.na")}</code>
          </div>
          <span class="gateway-switch__arrow" aria-hidden="true">${icons.arrowRight}</span>
          <div class="gateway-switch__host gateway-switch__host--next">
            <span class="gateway-switch__label">${t("connection.switchGateway.next")}</span>
            <code translate="no">${props.pendingGatewayUrl}</code>
          </div>
        </div>
        <p class="gateway-switch__note">${notes.join(" ")}</p>
        <div class="gateway-switch__actions">
          <button type="button" class="btn primary" @click=${props.onConfirm}>
            ${t("connection.switchGateway.confirm", { host: nextHost })}
          </button>
          <button type="button" class="btn" @click=${props.onCancel}>
            ${t("connection.switchGateway.cancel")}
          </button>
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
