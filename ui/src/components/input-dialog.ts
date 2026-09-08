// Control UI helper presents Promise-based text input without relying on a native prompt bridge.
import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";

type InputDialogOptions = {
  title: string;
  label?: string;
  defaultValue?: string;
  submitLabel?: string;
  cancelLabel?: string;
  signal?: AbortSignal;
  /**
   * Trims the value and blocks submission while it is empty. Callers that treat
   * an empty entry as meaningful (clearing a custom session label) leave this
   * off and keep receiving the raw value.
   */
  requireValue?: boolean;
  /**
   * Holds submission closed while the entry still equals `defaultValue`, so a
   * rename that would change nothing cannot be submitted.
   */
  requireChange?: boolean;
  /**
   * Runs the operation the dialog was opened for. `null` resolves the dialog; a
   * message keeps it open with the typed value, so a rejected attempt stays
   * visible and retryable instead of discarding what the operator wrote.
   */
  submit?: (value: string) => Promise<string | null>;
};

let inputActive = false;

function presentInputDialog(options: InputDialogOptions): Promise<string | null> {
  return withPromiseModalHost<string | null>({ signal: options.signal, value: null }, (modal) => {
    const { host, finish, render } = modal;
    let submitting = false;
    let failure: string | null = null;
    const entryValue = (raw: string) => (options.requireValue === true ? raw.trim() : raw);
    const submitBlocked = (raw: string) => {
      const value = entryValue(raw);
      return (
        (options.requireValue === true && value.length === 0) ||
        (options.requireChange === true && value === (options.defaultValue ?? ""))
      );
    };
    // Tracked so the submit button can reflect an entry the caller refuses. It
    // flips only across that boundary, never per keystroke: the value binding is
    // constant, so the input stays uncontrolled and keeps its caret and IME
    // composition across the repaints this triggers.
    let blocked = submitBlocked(options.defaultValue ?? "");

    const inputElement = () => host.querySelector<HTMLInputElement>('input[name="value"]');

    const handleInput = (event: Event) => {
      const next = submitBlocked((event.target as HTMLInputElement).value);
      if (next !== blocked) {
        blocked = next;
        paint();
      }
    };

    async function handleSubmit(event: Event) {
      event.preventDefault();
      if (submitting) {
        return;
      }
      const raw = inputElement()?.value;
      if (raw === undefined) {
        return;
      }
      if (submitBlocked(raw)) {
        return;
      }
      const value = entryValue(raw);
      if (!options.submit) {
        finish(value);
        return;
      }
      submitting = true;
      failure = null;
      paint();
      // A thrown operation still has to produce a visible outcome: without this
      // the dialog would stay disabled forever and wedge every later request.
      // The call itself is inside the try, so a callback that throws before it
      // returns a promise is caught too.
      let message: string | null;
      try {
        message = await options.submit(value);
      } catch (error) {
        message = formatUiError(error);
      }
      if (modal.settled) {
        return;
      }
      submitting = false;
      if (message === null) {
        finish(value);
        return;
      }
      failure = message;
      paint();
      inputElement()?.focus();
    }

    // A pending submit owns the dialog: dismissing it here would strand that
    // result and hide whether the operation landed.
    function handleCancel(event: Event) {
      if (submitting) {
        event.preventDefault();
        return;
      }
      finish(null);
    }

    const label = options.label ?? options.title;

    function paint() {
      render(() => {
        return html`
          <openclaw-modal-dialog
            label=${options.title}
            description=${label}
            @modal-cancel=${handleCancel}
          >
            <form class="exec-approval-card" @submit=${handleSubmit}>
              <div class="exec-approval-header">
                <div class="exec-approval-title">${options.title}</div>
              </div>
              <label class="field input-dialog__field">
                <span>${label}</span>
                <input
                  name="value"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  .value=${options.defaultValue ?? ""}
                  ?disabled=${submitting}
                  aria-invalid=${failure ? "true" : nothing}
                  @input=${handleInput}
                  autofocus
                />
              </label>
              ${
                failure
                  ? html`<div class="exec-approval-error" role="alert">${failure}</div>`
                  : nothing
              }
              <div class="exec-approval-actions">
                <button type="submit" class="btn primary" ?disabled=${submitting || blocked}>
                  ${options.submitLabel ?? t("common.save")}
                </button>
                <button
                  type="button"
                  class="btn"
                  ?disabled=${submitting}
                  @click=${() => finish(null)}
                >
                  ${options.cancelLabel ?? t("common.cancel")}
                </button>
              </div>
            </form>
          </openclaw-modal-dialog>
        `;
      });
    }

    paint();
  });
}

/** Native prompts block reentrancy; reject a second request instead of stacking it. */
export function showInputDialog(options: InputDialogOptions): Promise<string | null> {
  if (inputActive) {
    return Promise.resolve(null);
  }
  inputActive = true;
  return presentInputDialog(options).finally(() => {
    inputActive = false;
  });
}
