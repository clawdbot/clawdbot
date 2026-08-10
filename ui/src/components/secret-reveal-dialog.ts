// Control UI helper reveals a one-time secret in-app. window.prompt cannot do this job:
// it is unstyled, unlabeled, uncopyable on touch, and never renders at all in a webview
// without a dialog bridge, which drops the only copy of a freshly issued credential.
import { html, nothing, render } from "lit";
import { t } from "../i18n/index.ts";
import { renderCopyButton } from "./copy-button.ts";
import "./modal-dialog.ts";

type SecretRevealDialogOptions = {
  title: string;
  message: string;
  secret: string;
  acknowledgeLabel: string;
  dismissHint: string;
};

/** Resolves only on the explicit acknowledgement; Escape and backdrop cannot settle it. */
export function showSecretRevealDialog(options: SecretRevealDialogOptions): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise((resolve) => {
    let dismissRefused = false;
    const acknowledge = () => {
      render(nothing, host);
      host.remove();
      resolve();
    };
    // The secret is shown once, so a stray Escape or backdrop click must not be the last
    // thing that happens to it. Web Awesome pulses the refused dialog; the hint is the
    // accessible half of that answer, because a silent no-op reads as a broken control.
    const refuseDismiss = (event: Event) => {
      event.preventDefault();
      if (dismissRefused) {
        return;
      }
      dismissRefused = true;
      paint();
    };
    const paint = () => {
      render(
        html`
          <openclaw-modal-dialog
            label=${options.title}
            description=${options.message}
            @modal-cancel=${refuseDismiss}
          >
            <div class="exec-approval-card">
              <div class="exec-approval-header">
                <div>
                  <div class="exec-approval-title">${options.title}</div>
                  <div class="exec-approval-sub">${options.message}</div>
                </div>
              </div>
              <div class="secret-reveal__value">
                <code class="secret-reveal__code">${options.secret}</code>
                ${renderCopyButton(options.secret, t("common.copy"))}
              </div>
              ${dismissRefused
                ? html`<p class="secret-reveal__hint" role="status">${options.dismissHint}</p>`
                : nothing}
              <div class="exec-approval-actions">
                <button type="button" class="btn primary" autofocus @click=${acknowledge}>
                  ${options.acknowledgeLabel}
                </button>
              </div>
            </div>
          </openclaw-modal-dialog>
        `,
        host,
      );
    };
    paint();
  });
}
