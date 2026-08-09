// Guided mobile pairing wizard. Registered lazily: the dialog only renders
// after an operator opens it, so it stays out of the Control UI startup graph.
import { html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import type { DevicePairConnectivityPlanResult } from "../../../../packages/gateway-protocol/src/index.js";
import { handleCopyButton } from "../../components/copy-button.ts";
import "../../components/modal-dialog.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { canProvePairingEndpoint } from "../../lib/pairing/endpoint-probe.ts";
import type {
  PairingWizardAccess,
  PairingWizardActions,
  PairingWizardRecovery,
  PairingWizardSnapshot,
  PairingWizardStep,
} from "../../lib/pairing/wizard.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";

const PAIRING_DOCS_URL =
  "https://docs.openclaw.ai/channels/pairing#pair-from-the-control-ui-recommended";

type PairingBlocker = Extract<DevicePairConnectivityPlanResult, { status: "blocked" }>["blocker"];

const BLOCKER_COPY: Record<PairingBlocker, string> = {
  "gateway-auth-required": "devices.pairing.blockedAuthRequired",
  "gateway-auth-unavailable": "devices.pairing.blockedAuthUnavailable",
  "gateway-auth-invalid": "devices.pairing.blockedAuthInvalid",
  "route-unavailable": "devices.pairing.blockedRouteUnavailable",
  "route-insecure": "devices.pairing.blockedRouteInsecure",
  "lan-unavailable": "devices.pairing.blockedLanUnavailable",
  "gateway-change-requires-applied-config": "devices.pairing.blockedPendingConfig",
  "public-url-required": "devices.pairing.blockedPublicRequired",
  "public-url-invalid": "devices.pairing.blockedPublicInvalid",
  "public-url-insecure": "devices.pairing.blockedPublicInsecure",
  "tailscale-unavailable": "devices.pairing.blockedTailscaleUnavailable",
  "tailscale-login-required": "devices.pairing.blockedTailscaleLoginRequired",
  "tailscale-not-running": "devices.pairing.blockedTailscaleNotRunning",
  "tailscale-starting": "devices.pairing.blockedTailscaleStarting",
  "tailscale-status-error": "devices.pairing.blockedTailscaleStatusError",
  "tailscale-serve-required": "devices.pairing.blockedTailscaleServeRequired",
  "tailscale-serve-conflict": "devices.pairing.blockedTailscaleServeConflict",
  "tailscale-service-approval-required": "devices.pairing.blockedTailscaleApprovalRequired",
  "tailscale-service-approval-unknown": "devices.pairing.blockedTailscaleApprovalUnknown",
};

const RECOVERY_COPY: Record<PairingWizardRecovery, string> = {
  "restart-pending": "devices.pairing.recoveryRestartPending",
  "endpoint-unproven": "devices.pairing.recoveryUnproven",
  "endpoint-unprovable": "devices.pairing.recoveryUnprovable",
  "endpoint-mismatch": "devices.pairing.recoveryEndpointMismatch",
  "revert-conflict": "devices.pairing.recoveryRevertConflict",
  "revert-manual": "devices.pairing.recoveryRevertManual",
  "revert-failed": "devices.pairing.recoveryRevertFailed",
};

export type DevicePairSetupProps = {
  wizard: PairingWizardSnapshot;
  pendingCount: number;
  actions: PairingWizardActions;
  onClose: () => void;
  onManageDevices: () => void;
  onGetApps: () => void;
};

function renderPending(props: DevicePairSetupProps) {
  if (props.pendingCount === 0) {
    return nothing;
  }
  return html`
    <div class="callout warn device-pair-setup__pending">
      <span>${t("devices.pairing.pending", { count: String(props.pendingCount) })}</span>
      <button class="btn btn--sm" @click=${props.onManageDevices}>
        ${t("devices.pairing.review")}
      </button>
    </div>
  `;
}

function renderStatus(label: string) {
  return html`
    <div class="device-pair-setup__loading" role="status">
      <span class="device-pair-setup__spinner" aria-hidden="true"></span>
      <span>${label}</span>
    </div>
  `;
}

function renderBack(actions: PairingWizardActions) {
  return html`
    <button class="btn" type="button" @click=${() => void actions.back()}>
      ${t("common.back")}
    </button>
  `;
}

function renderAccess(props: DevicePairSetupProps, disabled: boolean) {
  const choose = (access: PairingWizardAccess) => () => props.actions.setAccess(access);
  return html`
    <fieldset class="device-pair-setup__access" ?disabled=${disabled}>
      <legend>${t("devices.pairing.accessTitle")}</legend>
      <label>
        <input
          type="radio"
          name="device-pair-access"
          .checked=${props.wizard.access === "full"}
          @change=${choose("full")}
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
          .checked=${props.wizard.access === "limited"}
          @change=${choose("limited")}
        />
        <span>
          <strong>${t("devices.pairing.limitedAccess")}</strong>
          <small>${t("devices.pairing.limitedAccessHint")}</small>
        </span>
      </label>
    </fieldset>
  `;
}

function renderRoute(params: {
  label: string;
  hint: string;
  detail?: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return html`
    <button
      class="device-pair-setup__route"
      type="button"
      ?disabled=${params.disabled === true}
      @click=${params.onSelect}
    >
      <span class="device-pair-setup__route-label">${params.label}</span>
      <span class="device-pair-setup__route-hint">${params.hint}</span>
      ${params.detail
        ? html`<span class="device-pair-setup__route-detail">${params.detail}</span>`
        : nothing}
    </button>
  `;
}

function renderChooser(
  props: DevicePairSetupProps,
  step: Extract<PairingWizardStep, { kind: "chooser" }>,
) {
  const { inspection } = step;
  const current = inspection.current;
  // Loopback already fails the phone; only offer a route a phone can dial.
  const reusableCurrent = current.status === "ready" && current.exposure !== "same-host";
  // A secure page cannot open the plaintext LAN candidate, so it cannot verify it.
  const lanProvable =
    inspection.lan.status === "available" && canProvePairingEndpoint(inspection.lan.url);
  // Tailscale ignores `inspection.tailscale` and stays selectable: every unhealthy
  // state is a Gateway-host step the operator can finish and retry, so only the
  // branch it leads to says what is missing.
  return html`
    ${renderAccess(props, false)}
    ${props.wizard.notice === "route-reverted"
      ? html`<div class="callout device-pair-setup__notice" role="status">
          ${t("devices.pairing.noticeReverted")}
        </div>`
      : nothing}
    ${current.status === "blocked"
      ? html`<div class="callout warn" role="status">
          <span>${t(BLOCKER_COPY[current.blocker])}</span>
        </div>`
      : nothing}
    <p class="device-pair-setup__prompt">${t("devices.pairing.chooserTitle")}</p>
    <div class="device-pair-setup__routes">
      ${reusableCurrent && current.status === "ready"
        ? renderRoute({
            label: t("devices.pairing.routeCurrent"),
            hint: t("devices.pairing.routeCurrentHint"),
            detail: current.urls[0],
            onSelect: () => void props.actions.chooseRoute("current"),
          })
        : nothing}
      ${renderRoute({
        label: t("devices.pairing.routeLan"),
        hint: lanProvable
          ? t("devices.pairing.routeLanHint")
          : t("devices.pairing.routeLanInsecurePage"),
        ...(inspection.lan.status === "available" ? { detail: inspection.lan.url } : {}),
        disabled: inspection.lan.status !== "available" || !lanProvable,
        onSelect: () => void props.actions.chooseRoute("lan"),
      })}
      ${renderRoute({
        label: t("devices.pairing.routeTailscale"),
        hint: t("devices.pairing.routeTailscaleHint"),
        onSelect: () => void props.actions.chooseRoute("tailscale"),
      })}
      ${renderRoute({
        label: t("devices.pairing.routePublic"),
        hint: t("devices.pairing.routePublicHint"),
        onSelect: () => void props.actions.chooseRoute("public"),
      })}
    </div>
  `;
}

function renderPublicUrl(
  props: DevicePairSetupProps,
  params: { value: string; checking: boolean; error?: string },
) {
  const submit = (event: Event) => {
    event.preventDefault();
    void props.actions.submitPublicUrl();
  };
  return html`
    <form class="device-pair-setup__form" @submit=${submit}>
      <label class="device-pair-setup__field">
        <span>${t("devices.pairing.publicTitle")}</span>
        <input
          type="url"
          name="device-pair-public-url"
          .value=${params.value}
          placeholder=${t("devices.pairing.publicPlaceholder")}
          ?disabled=${params.checking}
          @input=${(event: Event) =>
            props.actions.setPublicUrl((event.target as HTMLInputElement).value)}
        />
      </label>
      <p class="device-pair-setup__hint">${t("devices.pairing.publicHint")}</p>
      <p class="device-pair-setup__hint">${t("devices.pairing.publicTrust")}</p>
      ${params.error
        ? html`<div class="callout danger" role="alert"><span>${params.error}</span></div>`
        : nothing}
      <div class="device-pair-setup__actions">
        <button class="btn primary" type="submit" ?disabled=${params.checking || !params.value}>
          ${params.checking
            ? t("devices.pairing.publicChecking")
            : t("devices.pairing.publicCheck")}
        </button>
        ${renderBack(props.actions)}
      </div>
    </form>
  `;
}

function renderLanReview(
  props: DevicePairSetupProps,
  step: Extract<PairingWizardStep, { kind: "lan-review" }>,
) {
  const { plan } = step;
  return html`
    <p class="device-pair-setup__prompt">${t("devices.pairing.lanTitle")}</p>
    <ul class="device-pair-setup__consequences">
      <li>${t("devices.pairing.lanReach")}</li>
      <li>${t("devices.pairing.lanAuth")}</li>
      ${plan.accessDowngraded ? html`<li>${t("devices.pairing.lanLimited")}</li>` : nothing}
      <li>${t("devices.pairing.lanScope")}</li>
      ${plan.restartRequired ? html`<li>${t("devices.pairing.lanRestart")}</li>` : nothing}
    </ul>
    <div class="device-pair-setup__gateways">
      ${plan.urls.map(
        (url) => html`<span class="device-pair-setup__gateway" title=${url}>${url}</span>`,
      )}
    </div>
    <div class="device-pair-setup__actions">
      <button class="btn primary" type="button" @click=${() => void props.actions.confirmLan()}>
        ${t("devices.pairing.lanConfirm")}
      </button>
      ${renderBack(props.actions)}
    </div>
  `;
}

function renderMessage(
  props: DevicePairSetupProps,
  params: { title?: string; body: string; onRetry?: () => void },
) {
  return html`
    <div class="callout warn device-pair-setup__error" role="alert">
      ${params.title ? html`<strong>${params.title}</strong>` : nothing}
      <span>${params.body}</span>
    </div>
    <div class="device-pair-setup__actions">
      ${params.onRetry
        ? html`<button class="btn primary" type="button" @click=${params.onRetry}>
            ${icons.refresh} ${t("common.retry")}
          </button>`
        : nothing}
      ${renderBack(props.actions)}
    </div>
  `;
}

function renderCode(
  props: DevicePairSetupProps,
  step: Extract<PairingWizardStep, { kind: "code" }>,
) {
  const { setup } = step;
  const copyLabel = t("devices.pairing.copySetupCode");
  const gatewayUrls = setup.gatewayUrls ?? [setup.gatewayUrl];
  return html`
    <div class="device-pair-setup__qr-frame">
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
    </div>

    <div class="device-pair-setup__meta">
      <span class="settings-status settings-status--accent">
        <span class="settings-status__dot"></span>
        ${setup.auth}
      </span>
      <div class="device-pair-setup__gateways">
        ${gatewayUrls.map(
          (gatewayUrl) =>
            html`<span class="device-pair-setup__gateway" title=${gatewayUrl}>${gatewayUrl}</span>`,
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
        @click=${(event: Event) => void handleCopyButton(event, setup.setupCode, copyLabel)}
      >
        ${icons.copy} <span data-copy-label>${copyLabel}</span>
      </button>
      <button class="btn" type="button" @click=${() => void props.actions.back()}>
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
            <span> ${t("devices.pairing.pending", { count: String(props.pendingCount) })} </span>
            <button class="btn btn--sm" @click=${props.onManageDevices}>
              ${t("devices.pairing.review")}
            </button>
          </div>
        `
      : html`<p class="device-pair-setup__waiting">${t("devices.pairing.waiting")}</p>`}
  `;
}

function renderStep(props: DevicePairSetupProps): TemplateResult {
  const step = props.wizard.step;
  switch (step.kind) {
    case "admin-required":
      return html`
        <div class="callout warn device-pair-setup__error" role="status">
          <span>${t("devices.pairing.adminRequired")}</span>
        </div>
        ${renderPending(props)}
      `;
    case "inspecting":
      return renderStatus(t("devices.pairing.inspecting"));
    case "chooser":
      return renderChooser(props, step);
    case "public-url":
      return renderPublicUrl(props, { value: step.value, checking: step.phase === "checking" });
    case "public-url-rejected":
      return renderPublicUrl(props, {
        value: step.value,
        checking: false,
        error: t(BLOCKER_COPY[step.plan.blocker]),
      });
    case "public-url-unreachable":
      return renderPublicUrl(props, {
        value: step.value,
        checking: false,
        error:
          step.probe.status === "not-a-gateway"
            ? t("devices.pairing.notAGatewayHint")
            : t("devices.pairing.unreachableHint"),
      });
    case "lan-review":
      return renderLanReview(props, step);
    case "blocked":
      return renderMessage(props, {
        body: t(BLOCKER_COPY[step.plan.blocker]),
        // Retry re-plans from authoritative Gateway state. It is offered only
        // when the plan itself declares a resumable manual step, so the UI never
        // invents recovery the connectivity owner did not report.
        ...(step.plan.action
          ? { onRetry: () => void props.actions.chooseRoute(step.plan.mode) }
          : {}),
      });
    case "applying":
      return renderStatus(t("devices.pairing.applying"));
    case "awaiting-restart":
      return renderStatus(t("devices.pairing.awaitingRestart"));
    case "verifying":
      return renderStatus(t("devices.pairing.verifying"));
    case "reverting":
      return renderStatus(t("devices.pairing.reverting"));
    case "conflict":
      return html`
        <div class="callout warn device-pair-setup__error" role="alert">
          <strong>${t("devices.pairing.conflictTitle")}</strong>
          <span>${t("devices.pairing.conflictHint")}</span>
        </div>
        <div class="device-pair-setup__actions">
          <button class="btn primary" type="button" @click=${() => void props.actions.back()}>
            ${t("devices.pairing.reviewAgain")}
          </button>
        </div>
      `;
    case "recovery":
      return renderMessage(props, {
        title: t("devices.pairing.unreachableTitle"),
        body: t(RECOVERY_COPY[step.reason]),
      });
    case "issuing":
      return renderStatus(t("devices.pairing.generating"));
    case "code":
      return renderCode(props, step);
    case "failed":
      return renderMessage(props, { title: t("devices.pairing.failed"), body: step.message });
    default: {
      // Every step renders; a new one must add its own case, not fall through.
      const unrendered: never = step;
      return unrendered;
    }
  }
}

function renderDevicePairSetup(props: DevicePairSetupProps) {
  if (!props.wizard.open) {
    return nothing;
  }
  const title = t("devices.pairing.title");
  const description = t("devices.pairing.subtitle");

  return html`
    <openclaw-modal-dialog label=${title} description=${description} @modal-cancel=${props.onClose}>
      <section class="device-pair-setup">
        <header class="device-pair-setup__header">
          <div class="device-pair-setup__phone" aria-hidden="true">${icons.smartphone}</div>
          <div>
            <h2>${title}</h2>
            <p>${description}</p>
            <p class="device-pair-setup__get-apps">
              ${t("devices.pairing.noApp")}
              <button type="button" @click=${props.onGetApps}>
                ${t("devices.pairing.getApps")}
              </button>
            </p>
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

        <div class="device-pair-setup__body">${renderStep(props)}</div>

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

export class DevicePairSetupDialog extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: DevicePairSetupProps;

  override render() {
    return this.props ? renderDevicePairSetup(this.props) : nothing;
  }
}

if (!customElements.get("openclaw-device-pair-setup")) {
  customElements.define("openclaw-device-pair-setup", DevicePairSetupDialog);
}
