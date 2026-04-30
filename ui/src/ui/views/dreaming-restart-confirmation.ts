import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import "../components/modal-dialog.ts";

type DreamingRestartConfirmationProps = {
  open: boolean;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  hasError: boolean;
};

export function renderDreamingRestartConfirmation(props: DreamingRestartConfirmationProps) {
  if (!props.open) {
    return nothing;
  }
  const titleId = "dreaming-restart-confirmation-title";
  const descriptionId = "dreaming-restart-confirmation-description";
  const title = t("dreaming.restartConfirmation.title");
  const description = t("dreaming.restartConfirmation.subtitle");
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
        <div class="callout danger" style="margin-top: 12px;">
          ${t("dreaming.restartConfirmation.warning")}
        </div>
        ${props.hasError
          ? html`<div class="exec-approval-error">${t("dreaming.restartConfirmation.failed")}</div>`
          : nothing}
        <div class="exec-approval-actions">
          <button class="btn danger" ?disabled=${props.loading} @click=${props.onConfirm}>
            ${props.loading
              ? t("dreaming.restartConfirmation.restarting")
              : t("dreaming.restartConfirmation.confirm")}
          </button>
          <button class="btn" ?disabled=${props.loading} @click=${props.onCancel}>
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
