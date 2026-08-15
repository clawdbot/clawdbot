// Devices page renders the mobile device pairing setup dialog.
import { html, nothing } from "lit";
import { handleCopyButton, renderCopyButton } from "../../components/copy-button.ts";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import type {
  DevicePairSetupAccess,
  DevicePairSetupLifecycle,
} from "../../lib/device-pair-setup.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatCountdown } from "../../lib/format.ts";

const MOBILE_PAIRING_DOCS_URL =
  "https://docs.openclaw.ai/channels/pairing#pair-from-the-control-ui-recommended";
const NODE_PAIRING_DOCS_URL = "https://docs.openclaw.ai/gateway/pairing#one-paste-node-pairing";
const PAIRING_ACCESS_OPTIONS = [
  ["full", "devices.pairing.fullAccess", "devices.pairing.fullAccessHint"],
  ["limited", "devices.pairing.limitedAccess", "devices.pairing.limitedAccessHint"],
  ["node", "devices.pairing.nodeAccess", "devices.pairing.nodeAccessHint"],
] as const satisfies ReadonlyArray<readonly [DevicePairSetupAccess, string, string]>;

type DevicePairSetupProps = {
  open: boolean;
  lifecycle: DevicePairSetupLifecycle;
  nowMs: number;
  pendingCount: number;
  onRefresh: () => void;
  onAccessChange: (access: DevicePairSetupAccess) => void;
  onClose: () => void;
  onManageDevices: () => void;
  onGetApps: () => void;
};

function accessLabel(access: DevicePairSetupLifecycle["access"]): string {
  if (access === "limited") {
    return t("devices.pairing.limitedAccess");
  }
  if (access === "node") {
    return t("devices.pairing.nodeAccessSummary");
  }
  return t("devices.pairing.fullAccessSummary");
}

export function renderDevicePairSetup(props: DevicePairSetupProps) {
  if (!props.open) {
    return nothing;
  }
  const lifecycle = props.lifecycle;
  const title = t("devices.pairing.title");
  // Terminal states reuse their own headline as the dialog description so the
  // accessible name tracks the visible state without a parallel string set.
  const description =
    lifecycle.phase === "success"
      ? t("devices.pairing.pairedTitle")
      : lifecycle.phase === "delivery-uncertain"
        ? t("devices.pairing.deliveryUncertainTitle")
        : lifecycle.phase === "expired"
          ? t("devices.pairing.expiredTitle")
          : t("devices.pairing.subtitle");
  const copyLabel = t("devices.pairing.copySetupCode");
  const setup = lifecycle.phase === "waiting" ? lifecycle.setup : null;
  const gatewayUrls = setup?.gatewayUrls ?? (setup ? [setup.gatewayUrl] : []);
  const isNodeSetup = lifecycle.access === "node";
  const pairingDocsUrl = isNodeSetup ? NODE_PAIRING_DOCS_URL : MOBILE_PAIRING_DOCS_URL;
  const nodeCommand = setup ? `openclaw node run --pair "oc-pair://${setup.setupCode}"` : "";
  const setupExpired = Boolean(setup && setup.expiresAtMs <= props.nowMs);
  const showAccessChoices =
    lifecycle.phase !== "success" &&
    lifecycle.phase !== "delivery-uncertain" &&
    lifecycle.phase !== "reconciling" &&
    !(lifecycle.phase === "error" && lifecycle.source === "status");
  const canSelectAccess =
    lifecycle.phase === "selection" ||
    (lifecycle.phase === "error" && lifecycle.source === "create");

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
            ${lifecycle.phase !== "success" && !isNodeSetup
              ? html`<p class="device-pair-setup__get-apps">
                  ${t("devices.pairing.noApp")}
                  <button type="button" @click=${props.onGetApps}>
                    ${t("devices.pairing.getApps")}
                  </button>
                </p>`
              : nothing}
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
          ${showAccessChoices
            ? html`<fieldset class="device-pair-setup__access" ?disabled=${!canSelectAccess}>
                <legend>${t("devices.pairing.accessTitle")}</legend>
                ${PAIRING_ACCESS_OPTIONS.map(
                  ([access, label, hint]) => html`<label>
                    <input
                      type="radio"
                      name="device-pair-access"
                      .checked=${lifecycle.access === access}
                      @change=${() => props.onAccessChange(access)}
                    />
                    <span>
                      <strong>${t(label)}</strong>
                      <small>${t(hint)}</small>
                    </span>
                  </label>`,
                )}
              </fieldset>`
            : nothing}
          ${lifecycle.phase === "selection"
            ? html`
                <button class="btn primary" type="button" @click=${props.onRefresh}>
                  ${isNodeSetup ? icons.server : icons.smartphone}
                  ${t("devices.pairing.generateCode")}
                </button>
              `
            : nothing}
          ${lifecycle.phase === "loading"
            ? html`
                <div class="device-pair-setup__loading" role="status" aria-live="polite">
                  <span class="device-pair-setup__spinner" aria-hidden="true"></span>
                  <span>${t("devices.pairing.generating")}</span>
                </div>
              `
            : nothing}
          ${lifecycle.phase === "reconciling"
            ? html`
                <div class="device-pair-setup__loading" role="status" aria-live="polite">
                  <span class="device-pair-setup__spinner" aria-hidden="true"></span>
                  <span>${t("common.loading")}</span>
                </div>
              `
            : nothing}
          ${lifecycle.phase === "error"
            ? html`
                <div class="callout danger device-pair-setup__error" role="alert">
                  <strong
                    >${t(
                      lifecycle.source === "status"
                        ? "devices.pairing.statusFailed"
                        : "devices.pairing.failed",
                    )}</strong
                  >
                  <span>${lifecycle.message}</span>
                </div>
                <button class="btn primary" type="button" @click=${props.onRefresh}>
                  ${icons.refresh} ${t("common.reload")}
                </button>
              `
            : nothing}
          ${setup
            ? html`
                ${isNodeSetup
                  ? html`<div class="device-pair-setup__command">
                      ${setupExpired
                        ? nothing
                        : html`<div class="login-gate__command">
                            <code>${nodeCommand}</code>
                            ${renderCopyButton(nodeCommand, t("connection.help.copyCommand"))}
                          </div>`}
                      <p class="device-pair-setup__waiting" role="timer" aria-live="off">
                        ${setupExpired
                          ? t("devices.pairing.nodeExpired")
                          : t("devices.pairing.nodeExpiresIn", {
                              time: formatCountdown(setup.expiresAtMs, props.nowMs),
                            })}
                      </p>
                    </div>`
                  : html`<div class="device-pair-setup__qr-frame">
                      ${setup.qrDataUrl
                        ? html`<img
                            class="device-pair-setup__qr"
                            src=${setup.qrDataUrl}
                            alt=${t("devices.pairing.qrAlt")}
                            width="360"
                            height="360"
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
                  ${isNodeSetup
                    ? nothing
                    : html`<button
                        class="btn primary"
                        type="button"
                        @click=${(event: Event) =>
                          void handleCopyButton(event, setup.setupCode, copyLabel)}
                      >
                        ${icons.copy} <span data-copy-label>${copyLabel}</span>
                      </button>`}
                  <button class="btn" type="button" @click=${props.onRefresh}>
                    ${icons.refresh} ${t("devices.pairing.newCode")}
                  </button>
                </div>

                <details class="device-pair-setup__fallback">
                  <summary>${t("devices.pairing.showSetupCode")}</summary>
                  <code>${setup.setupCode}</code>
                </details>

                ${props.pendingCount > 0
                  ? html`
                      <div class="callout warn device-pair-setup__pending">
                        <span>
                          ${t("devices.pairing.pending", { count: String(props.pendingCount) })}
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
          ${lifecycle.phase === "success"
            ? html`<div class="device-pair-setup__state" role="status" aria-live="polite">
                <div
                  class="device-pair-setup__state-icon device-pair-setup__state-icon--success"
                  aria-hidden="true"
                >
                  ${icons.badgeCheck}
                </div>
                <h3>${lifecycle.deviceName ?? t("devices.pairing.pairedTitle")}</h3>
                <p>
                  ${lifecycle.deviceName
                    ? html`${t("devices.pairing.pairedTitle")} <span aria-hidden="true">·</span> `
                    : nothing}${accessLabel(lifecycle.access)}
                </p>
                <button class="btn primary" type="button" @click=${props.onClose}>
                  ${t("devices.pairing.done")}
                </button>
              </div>`
            : nothing}
          ${lifecycle.phase === "delivery-uncertain"
            ? html`<div class="device-pair-setup__state" role="alert">
                <div class="device-pair-setup__state-icon" aria-hidden="true">
                  ${icons.alertTriangle}
                </div>
                <h3>${t("devices.pairing.deliveryUncertainTitle")}</h3>
                <p>${t("devices.pairing.deliveryUncertainHint")}</p>
                <div class="device-pair-setup__actions">
                  <button class="btn primary" type="button" @click=${props.onRefresh}>
                    ${icons.refresh} ${t("devices.pairing.generateNewCode")}
                  </button>
                </div>
              </div>`
            : nothing}
          ${lifecycle.phase === "expired"
            ? html`<div class="device-pair-setup__state" role="status" aria-live="polite">
                <div class="device-pair-setup__state-icon" aria-hidden="true">${icons.refresh}</div>
                <h3>${t("devices.pairing.expiredTitle")}</h3>
                <button class="btn primary" type="button" @click=${props.onRefresh}>
                  ${icons.refresh} ${t("devices.pairing.generateNewCode")}
                </button>
              </div>`
            : nothing}
        </div>

        <footer class="device-pair-setup__footer">
          <a
            href=${pairingDocsUrl}
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            aria-label=${t("devices.pairing.helpNewTab")}
          >
            <span>${t("devices.pairing.help")}</span>
            <span class="device-pair-setup__external-icon" aria-hidden="true"
              >${icons.externalLink}</span
            >
          </a>
          <button class="btn btn--ghost" type="button" @click=${props.onManageDevices}>
            ${t("devices.pairing.manageDevices")}
          </button>
        </footer>
      </section>
    </openclaw-modal-dialog>
  `;
}
