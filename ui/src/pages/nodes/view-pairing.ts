// Nodes page renders the mobile device pairing setup dialog.
import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { DevicePairSetup, DevicePairSetupAccess } from "../../lib/device-pair-setup.ts";

const PAIRING_DOCS_URL =
  "https://docs.openclaw.ai/channels/pairing#pair-from-the-control-ui-recommended";

type DevicePairSetupProps = {
  open: boolean;
  loading: boolean;
  error: string | null;
  setup: DevicePairSetup | null;
  access: DevicePairSetupAccess;
  pendingCount: number;
  onRefresh: () => void;
  onAccessChange: (access: DevicePairSetupAccess) => void;
  onClose: () => void;
  onCopy: (setupCode: string) => void;
  onManageDevices: () => void;
};

export function renderDevicePairSetup(props: DevicePairSetupProps) {
  if (!props.open) {
    return nothing;
  }
  const title = t("nodes.pairing.title");
  const description = t("nodes.pairing.subtitle");
  const setup = props.setup;
  const pendingCount = props.pendingCount;
  const gatewayUrls = setup?.gatewayUrls ?? (setup ? [setup.gatewayUrl] : []);

  return html`
    <openclaw-modal-dialog label=${title} description=${description} @modal-cancel=${props.onClose}>
      <section class="device-pair-setup">
        <header class="device-pair-setup__header">
          <div class="device-pair-setup__phone" aria-hidden="true">${icons.smartphone}</div>
          <div>
            <h2>${title}</h2>
            <p>${description}</p>
          </div>
          <button
            class="btn btn--icon btn--ghost device-pair-setup__close"
            type="button"
            aria-label=${t("common.dismiss")}
            @click=${props.onClose}
          >
            ${icons.x}
          </button>
        </header>

        <div class="device-pair-setup__body">
          <fieldset class="device-pair-setup__access" ?disabled=${props.loading || setup !== null}>
            <legend>${t("nodes.pairing.accessTitle")}</legend>
            <label>
              <input
                type="radio"
                name="device-pair-access"
                .checked=${props.access === "full"}
                @change=${() => props.onAccessChange("full")}
              />
              <span>
                <strong>${t("nodes.pairing.fullAccess")}</strong>
                <small>${t("nodes.pairing.fullAccessHint")}</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="device-pair-access"
                .checked=${props.access === "limited"}
                @change=${() => props.onAccessChange("limited")}
              />
              <span>
                <strong>${t("nodes.pairing.limitedAccess")}</strong>
                <small>${t("nodes.pairing.limitedAccessHint")}</small>
              </span>
            </label>
          </fieldset>
          ${!setup && !props.loading && !props.error
            ? html`
                <button class="btn primary" type="button" @click=${props.onRefresh}>
                  ${icons.smartphone} ${t("nodes.pairing.generateCode")}
                </button>
              `
            : nothing}
          ${props.loading && !setup
            ? html`
                <div class="device-pair-setup__loading" role="status">
                  <span class="device-pair-setup__spinner" aria-hidden="true"></span>
                  <span>${t("nodes.pairing.generating")}</span>
                </div>
              `
            : nothing}
          ${props.error
            ? html`
                <div class="callout danger device-pair-setup__error" role="alert">
                  <strong>${t("nodes.pairing.failed")}</strong>
                  <span>${props.error}</span>
                </div>
                <button
                  class="btn primary"
                  type="button"
                  ?disabled=${props.loading}
                  @click=${props.onRefresh}
                >
                  ${icons.refresh} ${t("common.reload")}
                </button>
              `
            : nothing}
          ${setup
            ? html`
                <div class="device-pair-setup__qr-frame">
                  ${setup.qrDataUrl
                    ? html`<img
                        class="device-pair-setup__qr"
                        src=${setup.qrDataUrl}
                        alt=${t("nodes.pairing.qrAlt")}
                        draggable="false"
                      />`
                    : html`<div class="device-pair-setup__qr-unavailable">
                        ${t("nodes.pairing.qrUnavailable")}
                      </div>`}
                </div>

                <div class="device-pair-setup__meta">
                  ${renderSettingsStatus({ kind: "accent", label: setup.auth })}
                  <div class="device-pair-setup__gateways">
                    ${gatewayUrls.map(
                      (gatewayUrl) => html`
                        <span class="device-pair-setup__gateway" title=${gatewayUrl}
                          >${gatewayUrl}</span
                        >
                      `,
                    )}
                  </div>
                </div>

                ${setup.accessDowngraded
                  ? html`
                      <div class="callout warn device-pair-setup__access-warning" role="status">
                        <strong>${t("nodes.pairing.transportLimitedTitle")}</strong>
                        <span>${t("nodes.pairing.transportLimitedHint")}</span>
                      </div>
                    `
                  : nothing}

                <div class="device-pair-setup__actions">
                  <button
                    class="btn primary"
                    type="button"
                    @click=${() => props.onCopy(setup.setupCode)}
                  >
                    ${icons.copy} ${t("nodes.pairing.copySetupCode")}
                  </button>
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${props.loading}
                    @click=${props.onRefresh}
                  >
                    ${icons.refresh}
                    ${props.loading ? t("common.refreshing") : t("nodes.pairing.newCode")}
                  </button>
                </div>

                <details class="device-pair-setup__fallback">
                  <summary>${t("nodes.pairing.showSetupCode")}</summary>
                  <code>${setup.setupCode}</code>
                </details>

                ${pendingCount > 0
                  ? html`
                      <div class="callout warn device-pair-setup__pending">
                        <span>
                          ${t("nodes.pairing.pending", { count: String(pendingCount) })}
                        </span>
                        <button class="btn btn--sm" @click=${props.onManageDevices}>
                          ${t("nodes.pairing.review")}
                        </button>
                      </div>
                    `
                  : html`<p class="device-pair-setup__waiting">${t("nodes.pairing.waiting")}</p>`}
              `
            : nothing}
        </div>

        <footer class="device-pair-setup__footer">
          <a href=${PAIRING_DOCS_URL} target="_blank" rel="noreferrer">
            ${t("nodes.pairing.help")}
          </a>
          <button class="btn btn--ghost" type="button" @click=${props.onManageDevices}>
            ${t("nodes.pairing.manageDevices")}
          </button>
        </footer>
      </section>
    </openclaw-modal-dialog>
  `;
}
