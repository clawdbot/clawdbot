// Control UI helper presents Promise-based text entry without relying on a native dialog bridge.
import { html, nothing, render } from "lit";
import { t } from "../i18n/index.ts";
import "./modal-dialog.ts";

export type PromptDialogOptions = {
  title: string;
  fieldLabel: string;
  confirmLabel: string;
  /**
   * Runs the operation the prompt was opened for. `null` closes the dialog; a
   * message keeps it open with the typed value, so a rejected attempt stays
   * visible and retryable instead of discarding what the operator wrote.
   */
  submit: (value: string) => Promise<string | null>;
};

let promptActive = false;

function presentPromptDialog(options: PromptDialogOptions): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise<void>((resolve) => {
    let value = "";
    let failure: string | null = null;
    let submitting = false;
    let settled = false;

    function close() {
      if (settled) {
        return;
      }
      settled = true;
      render(nothing, host);
      host.remove();
      resolve();
    }

    // A pending submit owns the dialog: dismissing it here would strand that
    // result and hide whether the operation landed.
    function handleCancel(event: Event) {
      if (submitting) {
        event.preventDefault();
        return;
      }
      close();
    }

    async function submit() {
      const entered = value.trim();
      if (!entered || submitting) {
        return;
      }
      submitting = true;
      failure = null;
      paint();
      const message = await options.submit(entered);
      if (settled) {
        return;
      }
      submitting = false;
      if (message === null) {
        close();
        return;
      }
      failure = message;
      paint();
      host.querySelector("input")?.focus();
    }

    function paint() {
      render(
        html`
          <openclaw-modal-dialog label=${options.title} @modal-cancel=${handleCancel}>
            <form
              class="exec-approval-card"
              @submit=${(event: Event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <div class="exec-approval-header">
                <div class="exec-approval-title">${options.title}</div>
              </div>
              <label class="field prompt-dialog__field">
                <span>${options.fieldLabel}</span>
                <input
                  type="text"
                  autofocus
                  autocomplete="off"
                  spellcheck="false"
                  .value=${value}
                  ?disabled=${submitting}
                  aria-invalid=${failure ? "true" : nothing}
                  @input=${(event: Event) => {
                    value = (event.target as HTMLInputElement).value;
                    paint();
                  }}
                />
              </label>
              ${failure
                ? html`<div class="exec-approval-error" role="alert">${failure}</div>`
                : nothing}
              <div class="exec-approval-actions">
                <button
                  type="submit"
                  class="btn primary"
                  ?disabled=${submitting || value.trim().length === 0}
                >
                  ${options.confirmLabel}
                </button>
                <button type="button" class="btn" ?disabled=${submitting} @click=${close}>
                  ${t("common.cancel")}
                </button>
              </div>
            </form>
          </openclaw-modal-dialog>
        `,
        host,
      );
    }

    paint();
  });
}

/** Native prompts block reentrancy; drop a second request instead of stacking dialogs. */
export function showPromptDialog(options: PromptDialogOptions): Promise<void> {
  if (promptActive) {
    return Promise.resolve();
  }
  promptActive = true;
  return presentPromptDialog(options).finally(() => {
    promptActive = false;
  });
}
