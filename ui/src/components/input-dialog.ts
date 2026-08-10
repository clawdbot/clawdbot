// Control UI helper presents Promise-based text input without relying on a native prompt bridge.
import { html, nothing, render } from "lit";
import { t } from "../i18n/index.ts";
import "./modal-dialog.ts";

type InputDialogOptions = {
  title: string;
  label?: string;
  defaultValue?: string;
  submitLabel?: string;
  cancelLabel?: string;
  signal?: AbortSignal;
};

let inputActive = false;

function presentInputDialog(options: InputDialogOptions): Promise<string | null> {
  if (options.signal?.aborted) {
    return Promise.resolve(null);
  }
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", handleAbort);
      render(nothing, host);
      host.remove();
      resolve(value);
    };
    const handleAbort = () => finish(null);
    const submit = (event: SubmitEvent) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!(form instanceof HTMLFormElement)) {
        return;
      }
      const input = form.elements.namedItem("value");
      if (input instanceof HTMLInputElement) {
        finish(input.value);
      }
    };
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    const label = options.label ?? options.title;
    render(
      html`
        <openclaw-modal-dialog
          label=${options.title}
          description=${label}
          @modal-cancel=${() => finish(null)}
        >
          <form class="exec-approval-card" @submit=${submit}>
            <div class="exec-approval-header">
              <div class="exec-approval-title">${options.title}</div>
            </div>
            <label class="field">
              <span>${label}</span>
              <input
                name="value"
                type="text"
                autocomplete="off"
                .value=${options.defaultValue ?? ""}
                autofocus
              />
            </label>
            <div class="exec-approval-actions">
              <button type="submit" class="btn primary">
                ${options.submitLabel ?? t("common.save")}
              </button>
              <button type="button" class="btn" @click=${() => finish(null)}>
                ${options.cancelLabel ?? t("common.cancel")}
              </button>
            </div>
          </form>
        </openclaw-modal-dialog>
      `,
      host,
    );
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
