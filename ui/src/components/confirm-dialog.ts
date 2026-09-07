// Control UI helper presents Promise-based confirmation without relying on a native dialog bridge.
import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";

/**
 * Opt-out for confirms whose action is repeatable and recoverable. Callers own
 * the storage; passing this is what makes the checkbox exist at all, so serious
 * confirms stay unskippable by simply not offering one.
 */
export type ConfirmDialogSkipPreference = {
  /** True when the operator already chose to stop being asked. */
  skipped: boolean;
  /** Persists that choice; runs only when they confirm with the box ticked. */
  remember: () => void;
};

export type ConfirmDialogOptions = {
  title?: string;
  message: string;
  details?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  signal?: AbortSignal;
  skipPreference?: ConfirmDialogSkipPreference;
};

let confirmationActive = false;

function presentConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return withPromiseModalHost({ signal: options.signal, value: false }, ({ render, finish }) => {
    let skipRequested = false;
    const title = options.title ?? t("common.confirm");
    render(() => {
      return html`
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
            ${
              options.details
                ? html`<div class="exec-approval-command mono">${options.details}</div>`
                : nothing
            }
            ${
              options.skipPreference
                ? html`<label class="field checkbox exec-approval-skip">
                    <input
                      type="checkbox"
                      @change=${(event: Event) => {
                        skipRequested = (event.target as HTMLInputElement).checked;
                      }}
                    />
                    <span>${t("common.dontAskAgain")}</span>
                  </label>`
                : nothing
            }
            <div class="exec-approval-actions">
              <button
                type="button"
                class="btn ${options.danger ? "danger" : "primary"}"
                @click=${() => {
                  if (skipRequested) {
                    options.skipPreference?.remember();
                  }
                  finish(true);
                }}
              >
                ${options.confirmLabel ?? t("common.confirm")}
              </button>
              <button type="button" class="btn" autofocus @click=${() => finish(false)}>
                ${options.cancelLabel ?? t("common.cancel")}
              </button>
            </div>
          </div>
        </openclaw-modal-dialog>
      `;
    });
  });
}

/** Native confirms block reentrancy; reject a second request instead of replaying it later. */
export function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  // An operator who opted out gets the action itself, not a modal they already
  // answered. Only callers that opted into a skip preference can reach this.
  if (options.skipPreference?.skipped) {
    return Promise.resolve(true);
  }
  if (confirmationActive) {
    return Promise.resolve(false);
  }
  confirmationActive = true;
  return presentConfirmDialog(options).finally(() => {
    confirmationActive = false;
  });
}
