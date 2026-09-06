// Control UI helper reveals a one-time secret in-app. window.prompt cannot do this job:
// it is unstyled, unlabeled, uncopyable on touch, and never renders at all in a webview
// without a dialog bridge, which drops the only copy of a freshly issued credential.
import { html, nothing, render } from "lit";
import { t } from "../i18n/index.ts";
import { renderCopyButton } from "./copy-button.ts";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";

type SecretRevealDialogOptions = {
  title: string;
  message: string;
  /** Omitted when the operation issued no secret to this operator; the dialog then
   *  reports the outcome only, and dismissal gestures behave normally. */
  secret?: string;
  acknowledgeLabel: string;
  /** Only reachable with a secret, because only then is dismissal refused. */
  dismissHint?: string;
  /** Success mark beside the title. Set only where the dialog reports a settled outcome;
   *  a reveal that still needs the operator to act should not look finished. */
  status?: "success";
  /** The one conditional branch, lifted out of the calm text so it cannot be skimmed
   *  past. Info tone: this is guidance the reader may not need, not an error. */
  callout?: string;
  /** Muted trailing rationale. Never the answer to "what do I do now?"; that leads. */
  note?: string;
};

/**
 * Resolves on the explicit acknowledgement. With a secret, Escape and backdrop cannot
 * settle it; without one there is nothing to lose, so they close it like any dialog.
 */
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
    // An outcome-only dialog holds nothing recoverable, so it dismisses normally.
    const handleCancel = (event: Event) => {
      if (!options.secret) {
        acknowledge();
        return;
      }
      event.preventDefault();
      if (dismissRefused) {
        return;
      }
      dismissRefused = true;
      paint();
    };
    // Sibling convention (confirm-dialog): the accent button is the action that commits
    // something. Acknowledging a secret is that gate; closing a report of work already
    // done is not, so it stays neutral -- with a raised border, because .btn's resting
    // border sits within ~4/255 of --card in dark and vanishes on this surface.
    const acknowledgeClass = options.secret ? "btn primary" : "btn secret-reveal__dismiss";
    const paint = () => {
      render(
        html`
          <openclaw-modal-dialog
            label=${options.title}
            description=${options.message}
            @modal-cancel=${handleCancel}
          >
            <div class="exec-approval-card">
              <div class="secret-reveal__header">
                ${
                  options.status === "success"
                    ? html`<span class="secret-reveal__status" aria-hidden="true"
                        >${icons.check}</span
                      >`
                    : nothing
                }
                <div class="exec-approval-title">${options.title}</div>
              </div>
              <div class="secret-reveal__body"><p>${options.message}</p></div>
              ${
                options.callout
                  ? html`<div class="callout info secret-reveal__callout">${options.callout}</div>`
                  : nothing
              }
              ${
                options.secret
                  ? html`
                      <div class="secret-reveal__value">
                        <code class="secret-reveal__code">${options.secret}</code>
                        ${renderCopyButton(options.secret, t("common.copy"))}
                      </div>
                    `
                  : nothing
              }
              ${
                dismissRefused
                  ? html`<p class="secret-reveal__hint" role="status">${options.dismissHint}</p>`
                  : nothing
              }
              ${options.note ? html`<p class="secret-reveal__note">${options.note}</p>` : nothing}
              <div class="exec-approval-actions">
                <button type="button" class=${acknowledgeClass} autofocus @click=${acknowledge}>
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
