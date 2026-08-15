// Control UI view renders the dreaming on/off confirmation screen content.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import "../../../components/modal-dialog.ts";

type DreamingToggleConfirmationProps = {
  open: boolean;
  // Direction of the pending write. Copy differs because turning dreaming off
  // stops the sweep for every agent, not just the one this panel is showing.
  enabling: boolean;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  hasError: boolean;
};

export function renderDreamingToggleConfirmation(props: DreamingToggleConfirmationProps) {
  if (!props.open) {
    return nothing;
  }
  const titleId = "dreaming-toggle-confirmation-title";
  const descriptionId = "dreaming-toggle-confirmation-description";
  const title = props.enabling
    ? t("dreaming.toggleConfirmation.enableTitle")
    : t("dreaming.toggleConfirmation.disableTitle");
  const description = t("dreaming.toggleConfirmation.subtitle");
  const detail = props.enabling
    ? t("dreaming.toggleConfirmation.enableDetail")
    : t("dreaming.toggleConfirmation.disableDetail");
  const confirmLabel = props.enabling
    ? t("dreaming.toggleConfirmation.enableConfirm")
    : t("dreaming.toggleConfirmation.disableConfirm");
  const handleCancel = () => {
    if (!props.loading) {
      props.onCancel();
    }
  };

  return html`
    <openclaw-modal-dialog label=${title} description=${description} @modal-cancel=${handleCancel}>
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div id=${titleId} class="exec-approval-title">${title}</div>
            <div id=${descriptionId} class="exec-approval-sub">${description}</div>
          </div>
        </div>
        <div class="callout ${props.enabling ? "info" : "warn"}" style="margin-top: 12px;">
          ${detail}
        </div>
        ${props.hasError
          ? html`<div class="exec-approval-error">${t("dreaming.toggleConfirmation.failed")}</div>`
          : nothing}
        <div class="exec-approval-actions">
          <button
            class="btn ${props.enabling ? "primary" : "danger"}"
            ?disabled=${props.loading}
            @click=${props.onConfirm}
          >
            ${props.loading ? t("dreaming.toggleConfirmation.saving") : confirmLabel}
          </button>
          <button class="btn" ?disabled=${props.loading} @click=${props.onCancel}>
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
