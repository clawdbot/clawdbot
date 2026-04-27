import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";

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

  return html`
    <div class="exec-approval-overlay" role="dialog" aria-modal="true" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${t("dreaming.restartConfirmation.title")}</div>
            <div class="exec-approval-sub">${t("dreaming.restartConfirmation.subtitle")}</div>
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
    </div>
  `;
}
