// Control UI component renders the offline/reconnecting banner shown while
// the gateway connection is interrupted but the dashboard stays mounted.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { redactLoginFailureError } from "./login-gate.ts";

type ConnectionBannerProps = {
  lastError: string | null;
  onRetry: () => void;
};

function renderConnectionBanner(props: ConnectionBannerProps) {
  const detail = props.lastError ? redactLoginFailureError(props.lastError) : null;
  const hint = t("connection.offlineHint");
  return html`
    <div class="connection-banner" role="status" aria-live="polite">
      <div class="connection-banner__pill" title=${detail ? `${hint}\n${detail}` : hint}>
        <span class="connection-banner__dot" aria-hidden="true"></span>
        <span class="connection-banner__title">${t("connection.lostTitle")}</span>
        <span class="connection-banner__state">${t("connection.reconnecting")}</span>
        <span class="connection-banner__sr-hint">${hint}</span>
        <button class="connection-banner__retry" type="button" @click=${props.onRetry}>
          ${t("connection.retryNow")}
        </button>
      </div>
    </div>
  `;
}

class ConnectionBanner extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: ConnectionBannerProps;

  override render() {
    return this.props ? renderConnectionBanner(this.props) : nothing;
  }
}

if (!customElements.get("openclaw-connection-banner")) {
  customElements.define("openclaw-connection-banner", ConnectionBanner);
}
