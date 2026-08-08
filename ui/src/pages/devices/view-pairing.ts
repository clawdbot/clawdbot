// Devices page renders the mobile device pairing setup dialog.
import { html, nothing } from "lit";
import { handleCopyButton } from "../../components/copy-button.ts";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import type { DevicePairSetup, DevicePairSetupAccess } from "../../lib/device-pair-setup.ts";

const PAIRING_DOCS_URL = "https://docs.openclaw.ai/gateway/pairing#one-paste-node-pairing";

function formatPairingSetupCountdown(expiresAtMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

type DevicePairSetupProps = {
  open: boolean;
  loading: boolean;
  error: string | null;
  setup: DevicePairSetup | null;
  access: DevicePairSetupAccess;
  nowMs: number;
  pendingCount: number;
  onRefresh: () => void;
  onAccessChange: (access: DevicePairSetupAccess) => void;
  onClose: () => void;
  onManageDevices: () => void;
  onGetApps: () => void;
};

export function renderDevicePairSetup(props: DevicePairSetupProps) {
  if (!props.open) {
    return nothing;
  }
  const title = t("devices.pairing.title");
  const description = t("devices.pairing.subtitle");
  const copyLabel = t("devices.pairing.copySetupCode");
  const setup = props.setup;
  const pendingCount = props.pendingCount;
  const gatewayUrls = setup?.gatewayUrls ?? (setup ? [setup.gatewayUrl] : []);
  const isNodeSetup = props.access === "node";
  const pairUrl = setup ? `oc-pair://${setup.setupCode}` : "";
  const nodeCommand = pairUrl ? `openclaw node run --pair "${pairUrl}"` : "";
  const setupExpired = typeof setup?.expiresAtMs === "number" && setup.expiresAtMs <= props.nowMs;

  return html`
    <openclaw-modal-dialog label=${title} description=${description} @modal-cancel=${props.onClose}>
      <section class="device-pair-setup">
        <header class="device-pair-setup__header">
          <div class="device-pair-setup__phone" aria-hidden="true">
            ${isNodeSetup ? icons.server : icons.smartphone}
          </div>
          <div>
            <h2>${title}</h2>
            <p>${description}</p>
            ${isNodeSetup
              ? nothing
              : html`<p class="device-pair-setup__get-apps">
                  ${t("devices.pairing.noApp")}
                  <button type="button" @click=${props.onGetApps}>
                    ${t("devices.pairing.getApps")}
                  </button>
                </p>`}
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
            <legend>${t("devices.pairing.accessTitle")}</legend>
            <label>
              <input
                type="radio"
                name="device-pair-access"
                .checked=${props.access === "full"}
                @change=${() => props.onAccessChange("full")}
              />
              <span>
                <strong>${t("devices.pairing.fullAccess")}</strong>
                <small>${t("devices.pairing.fullAccessHint")}</small>
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
                <strong>${t("devices.pairing.limitedAccess")}</strong>
                <small>${t("devices.pairing.limitedAccessHint")}</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="device-pair-access"
                .checked=${props.access === "node"}
                @change=${() => props.onAccessChange("node")}
              />
              <span>
                <strong>${t("devices.pairing.nodeAccess")}</strong>
                <small>${t("devices.pairing.nodeAccessHint")}</small>
              </span>
            </label>
          </fieldset>
          ${!setup && !props.loading && !props.error
            ? html`
                <button class="btn primary" type="button" @click=${props.onRefresh}>
                  ${icons.smartphone} ${t("devices.pairing.generateCode")}
                </button>
              `
            : nothing}
          ${props.loading && !setup
            ? html`
                <div class="device-pair-setup__loading" role="status">
                  <span class="device-pair-setup__spinner" aria-hidden="true"></span>
                  <span>${t("devices.pairing.generating")}</span>
                </div>
              `
            : nothing}
          ${props.error
            ? html`
                <div class="callout danger device-pair-setup__error" role="alert">
                  <strong>${t("devices.pairing.failed")}</strong>
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
                ${isNodeSetup
                  ? html`<div class="device-pair-setup__command">
                      <code>${nodeCommand}</code>
                      ${setup.expiresAtMs
                        ? html`<p role="timer" aria-live="off">
                            ${setupExpired
                              ? t("devices.pairing.nodeExpired")
                              : t("devices.pairing.nodeExpiresIn", {
                                  time: formatPairingSetupCountdown(setup.expiresAtMs, props.nowMs),
                                })}
                          </p>`
                        : nothing}
                    </div>`
                  : html`<div class="device-pair-setup__qr-frame">
                      ${setup.qrDataUrl
                        ? html`<img
                            class="device-pair-setup__qr"
                            src=${setup.qrDataUrl}
                            alt=${t("devices.pairing.qrAlt")}
                            draggable="false"
                          />`
                        : html`<div class="device-pair-setup__qr-unavailable">
                            ${t("devices.pairing.qrUnavailable")}
                          </div>`}
                    </div>`}

                <div class="device-pair-setup__meta">
                  <span class="settings-status settings-status--accent">
                    <span class="settings-status__dot"></span>
                    ${setup.auth}
                  </span>
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
                        <strong>${t("devices.pairing.transportLimitedTitle")}</strong>
                        <span>${t("devices.pairing.transportLimitedHint")}</span>
                      </div>
                    `
                  : nothing}

                <div class="device-pair-setup__actions">
                  <button
                    class="btn primary"
                    type="button"
                    @click=${(event: Event) =>
                      void handleCopyButton(
                        event,
                        isNodeSetup ? nodeCommand : setup.setupCode,
                        isNodeSetup ? t("devices.pairing.copyNodeCommand") : copyLabel,
                      )}
                    ?disabled=${setupExpired}
                  >
                    ${icons.copy}
                    <span data-copy-label
                      >${isNodeSetup ? t("devices.pairing.copyNodeCommand") : copyLabel}</span
                    >
                  </button>
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${props.loading}
                    @click=${props.onRefresh}
                  >
                    ${icons.refresh}
                    ${props.loading ? t("common.refreshing") : t("devices.pairing.newCode")}
                  </button>
                </div>

                <details class="device-pair-setup__fallback">
                  <summary>${t("devices.pairing.showSetupCode")}</summary>
                  <code>${setup.setupCode}</code>
                </details>

                ${pendingCount > 0
                  ? html`
                      <div class="callout warn device-pair-setup__pending">
                        <span>
                          ${t("devices.pairing.pending", { count: String(pendingCount) })}
                        </span>
                        <button class="btn btn--sm" @click=${props.onManageDevices}>
                          ${t("devices.pairing.review")}
                        </button>
                      </div>
                    `
                  : html`<p class="device-pair-setup__waiting">
                      ${t(isNodeSetup ? "devices.pairing.nodeWaiting" : "devices.pairing.waiting")}
                    </p>`}
              `
            : nothing}
        </div>

        <footer class="device-pair-setup__footer">
          <a href=${PAIRING_DOCS_URL} target="_blank" rel="noreferrer">
            ${t("devices.pairing.help")}
          </a>
          <button class="btn btn--ghost" type="button" @click=${props.onManageDevices}>
            ${t("devices.pairing.manageDevices")}
          </button>
        </footer>
      </section>
    </openclaw-modal-dialog>
  `;
}
