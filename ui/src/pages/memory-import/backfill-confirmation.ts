import { html, nothing } from "lit";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";

export function renderBackfillConfirmation(props: {
  backfillRollbackPending: boolean;
  backfillBusy: "preview" | "apply" | "rollback" | null;
  applyingProviderId: string | null;
  onBackfillRollbackConfirm: () => void;
  onBackfillRollbackCancel: () => void;
}) {
  if (!props.backfillRollbackPending) {
    return nothing;
  }
  return html`
    <openclaw-modal-dialog
      label=${t("memoryImport.backfill.rollbackConfirmTitle")}
      description=${t("memoryImport.backfill.rollbackConfirmDescription")}
      @modal-cancel=${props.onBackfillRollbackCancel}
    >
      <div class="exec-approval-card memory-import__confirm">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">
              ${t("memoryImport.backfill.rollbackConfirmTitle")}
            </div>
            <div class="exec-approval-sub">
              ${t("memoryImport.backfill.rollbackConfirmDescription")}
            </div>
          </div>
        </div>
        <div class="callout warn">${t("memoryImport.backfill.rollbackWarning")}</div>
        <div class="exec-approval-actions">
          <button
            class="btn danger"
            data-test-id="memory-backfill-rollback-confirm"
            ?disabled=${props.backfillBusy !== null || props.applyingProviderId !== null}
            @click=${props.onBackfillRollbackConfirm}
          >
            ${t("memoryImport.backfill.rollback")}
          </button>
          <button
            class="btn"
            ?disabled=${props.backfillBusy !== null || props.applyingProviderId !== null}
            @click=${props.onBackfillRollbackCancel}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
