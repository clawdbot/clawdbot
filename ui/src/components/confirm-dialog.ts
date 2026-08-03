// Control UI helper presents Promise-based confirmation without relying on a native dialog bridge.
import { html, nothing, render } from "lit";
import { t } from "../i18n/index.ts";
import "./modal-dialog.ts";

export type ConfirmDialogOptions = {
  title?: string;
  message: string;
  details?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  signal?: AbortSignal;
};

let confirmationActive = false;

function presentConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (options.signal?.aborted) {
    return Promise.resolve(false);
  }
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", handleAbort);
      render(nothing, host);
      host.remove();
      resolve(confirmed);
    };
    const handleAbort = () => finish(false);
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    const title = options.title ?? t("common.confirm");
    render(
      html`
        <openclaw-modal-dialog
          label=${title}
          description=${options.message}
          @modal-cancel=${() => finish(false)}
        >
          <div class="exec-approval-card">
            <div class="exec-approval-header">
              <div>
                <div class="exec-approval-title">${title}</div>
                <div class="exec-approval-sub" style="white-space: pre-line">
                  ${options.message}
                </div>
              </div>
            </div>
            ${options.details
              ? html`<div class="exec-approval-command mono">${options.details}</div>`
              : nothing}
            <div class="exec-approval-actions">
              <button
                type="button"
                class="btn ${options.danger ? "danger" : "primary"}"
                @click=${() => finish(true)}
              >
                ${options.confirmLabel ?? t("common.confirm")}
              </button>
              <button type="button" class="btn" autofocus @click=${() => finish(false)}>
                ${options.cancelLabel ?? t("common.cancel")}
              </button>
            </div>
          </div>
        </openclaw-modal-dialog>
      `,
      host,
    );
  });
}

/** Native confirms block reentrancy; reject a second request instead of replaying it later. */
export function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (confirmationActive) {
    return Promise.resolve(false);
  }
  confirmationActive = true;
  return presentConfirmDialog(options).finally(() => {
    confirmationActive = false;
  });
}
