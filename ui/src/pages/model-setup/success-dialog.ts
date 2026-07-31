import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import {
  hasProviderBrandIcon,
  providerIdFromModelRef,
  renderProviderBrandIcon,
} from "../../components/provider-icon.ts";
import { t } from "../../i18n/index.ts";
import type { ModelSetupActivationState } from "./state.ts";

export function renderModelSetupSuccessDialog(
  activation: Extract<ModelSetupActivationState, { phase: "success" }>,
  onOpenChat: () => void,
  onClose: () => void,
  firstRun: boolean,
) {
  const providerId = providerIdFromModelRef(activation.modelRef);
  const providerIconId = providerId && hasProviderBrandIcon(providerId) ? providerId : null;
  return html`
    <openclaw-modal-dialog
      label=${t("modelSetup.success.title")}
      description=${t("modelSetup.success.body", { modelRef: activation.modelRef })}
      @modal-cancel=${onClose}
    >
      <section class="model-setup-success" role="status">
        <div
          class=${`model-setup-success__icon${providerIconId ? " model-setup-success__icon--provider" : ""}`}
          aria-hidden="true"
        >
          ${providerIconId
            ? html`
                ${renderProviderBrandIcon(providerIconId, {
                  className: "model-setup-success__provider-icon",
                })}
                <span class="model-setup-success__status-badge">${icons.check}</span>
              `
            : icons.shieldCheck}
        </div>
        <div class="model-setup-success__copy">
          <h2>${t("modelSetup.success.title")}</h2>
          <p>${t("modelSetup.success.body", { modelRef: activation.modelRef })}</p>
        </div>
        ${activation.warning
          ? html`<div class="model-setup-success__warning">${activation.warning}</div>`
          : nothing}
        <div class="model-setup-success__summary">
          <span>${t("modelSetup.success.activeModel")}</span>
          <strong>${activation.modelRef}</strong>
          ${activation.latencyMs === undefined
            ? nothing
            : html`<span>
                ${t("modelSetup.success.latency", {
                  latencyMs: String(activation.latencyMs),
                })}
              </span>`}
        </div>
        <footer class="model-setup-success__actions">
          <button type="button" class="btn" @click=${onClose}>
            ${t("modelSetup.success.stayHere")}
          </button>
          <button type="button" class="btn primary" autofocus @click=${onOpenChat}>
            ${icons.messageSquare}
            ${t(firstRun ? "modelSetup.success.continueSetup" : "modelSetup.success.openChat")}
          </button>
        </footer>
      </section>
    </openclaw-modal-dialog>
  `;
}
