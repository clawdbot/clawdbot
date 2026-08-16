import { html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";

type ToastDismissReason = "action" | "dismiss" | "disconnected" | "replaced" | "timeout";

export type ToastOptions = {
  /** A template lets a message name a destination the operator can actually open,
   * instead of spelling out a settings path the toast then makes them find. */
  message: string | TemplateResult;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: (reason: ToastDismissReason) => void;
  durationMs?: number;
};

const DEFAULT_TOAST_DURATION_MS = 6_000;

function activeModalToastLayer() {
  return [...(document.openClawModalToastLayers ?? [])].findLast(
    (candidate) => candidate.isConnected,
  );
}

// Outcomes reported during startup (a restored post-update result, for example)
// race the shell that owns the host element. Hold the latest one instead of
// dropping it, so no caller's message disappears because it arrived too early.
let queuedToast: ToastOptions | null = null;

class OpenClawToastHost extends OpenClawLightDomContentsElement {
  @state() private toast: ToastOptions | null = null;
  private dismissTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    const pending = queuedToast;
    queuedToast = null;
    if (pending) {
      this.show(pending);
    }
  }

  override disconnectedCallback() {
    const target = activeModalToastLayer() ?? document.querySelector(".shell");
    if (!this.isConnected && this.parentElement?.localName === "openclaw-modal-dialog" && target) {
      target.append(this);
    } else {
      this.dismiss("disconnected");
    }
    super.disconnectedCallback();
  }

  /** Keep the active outcome intact while moveBefore() crosses top-layer owners. */
  connectedMoveCallback() {}

  show(options: ToastOptions) {
    this.dismiss("replaced");
    this.toast = options;
    this.dismissTimer = globalThis.setTimeout(
      () => this.dismiss("timeout"),
      options.durationMs ?? DEFAULT_TOAST_DURATION_MS,
    );
  }

  private clearDismissTimer() {
    if (this.dismissTimer !== null) {
      globalThis.clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  private dismiss(reason: ToastDismissReason) {
    const toast = this.toast;
    this.clearDismissTimer();
    this.toast = null;
    toast?.onDismiss?.(reason);
  }

  override render() {
    const toast = this.toast;
    if (!toast) {
      return nothing;
    }
    return html`
      <div class="app-toast" role="status" aria-live="polite" aria-atomic="true">
        <span class="app-toast__message">${toast.message}</span>
        ${toast.actionLabel && toast.onAction
          ? html`
              <button
                type="button"
                class="app-toast__action"
                @click=${() => {
                  this.dismiss("action");
                  toast.onAction?.();
                }}
              >
                ${toast.actionLabel}
              </button>
            `
          : nothing}
        <button
          type="button"
          class="app-toast__dismiss"
          aria-label=${t("common.dismiss")}
          @click=${() => this.dismiss("dismiss")}
        >
          ×
        </button>
      </div>
    `;
  }
}

export function showToast(options: ToastOptions): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const host = document.querySelector<OpenClawToastHost>("openclaw-toast-host");
  if (!host) {
    queuedToast = options;
    return false;
  }
  const modal = activeModalToastLayer();
  if (modal && host.parentElement !== modal) {
    modal.moveBefore(host, null);
    const handoff = (event: Event) => {
      if (event.target !== modal) {
        return;
      }
      modal.removeEventListener("wa-after-hide", handoff);
      queueMicrotask(() =>
        (activeModalToastLayer() ?? document.querySelector(".shell"))?.moveBefore(host, null),
      );
    };
    modal.addEventListener("wa-after-hide", handoff);
  }
  host.show(options);
  return true;
}

// Guarded so DOM-free (node) consumers of send-failure surfacing can load this module.
if (typeof customElements !== "undefined" && !customElements.get("openclaw-toast-host")) {
  customElements.define("openclaw-toast-host", OpenClawToastHost);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-toast-host": OpenClawToastHost;
  }
}
