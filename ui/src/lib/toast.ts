import { html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { formatUiExternalText } from "./format-error.ts";

type ToastDismissReason = "action" | "dismiss" | "disconnected" | "replaced" | "timeout";

export type ToastOptions = {
  /** A template lets a message name a destination the operator can actually open,
   * instead of spelling out a settings path the toast then makes them find. */
  message: string | TemplateResult;
  /** Positions a compact toast at the top center of the owning surface. */
  anchor?: Element;
  anchorTopOffset?: number;
  icon?: TemplateResult;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: (reason: ToastDismissReason) => void;
  durationMs?: number;
  /** Wait behind the active toast instead of replacing it. */
  fifo?: boolean;
};

const DEFAULT_TOAST_DURATION_MS = 6_000;
const TOAST_EXIT_FALLBACK_MS = 450;

function activeModalToastLayer() {
  return [...(document.openClawModalLayers ?? [])].findLast((candidate) => candidate.isConnected);
}

function restingToastLayer() {
  return (
    document.querySelector(".shell-nav[aria-modal='true']") ?? document.querySelector(".shell")
  );
}

// Outcomes reported during startup (a restored post-update result, for example)
// race the shell that owns the host element. Hold the latest one instead of
// dropping it, so no caller's message disappears because it arrived too early.
let queuedToast: ToastOptions | null = null;

class OpenClawToastHost extends OpenClawLightDomContentsElement {
  @state() private toast: ToastOptions | null = null;
  @state() private active = false;
  private readonly toastQueue: ToastOptions[] = [];
  private dismissTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private exitTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private exitReason: ToastDismissReason | null = null;

  private syncPlacement() {
    this.dataset.toastPlacement = this.parentElement?.matches(".shell") ? "shell" : "overlay";
  }

  override connectedCallback() {
    super.connectedCallback();
    this.syncPlacement();
    const pending = queuedToast;
    queuedToast = null;
    if (pending) {
      this.show(pending);
    }
  }

  override disconnectedCallback() {
    const target = activeModalToastLayer() ?? restingToastLayer();
    if (!this.isConnected && this.parentElement?.localName === "openclaw-modal-dialog" && target) {
      target.append(this);
    } else {
      this.dismiss("disconnected");
    }
    super.disconnectedCallback();
  }

  /** Keep the outcome intact and refresh ancestor-owned placement across moveBefore() handoffs. */
  connectedMoveCallback() {
    this.syncPlacement();
  }

  show(options: ToastOptions) {
    if (options.fifo && this.toast) {
      this.toastQueue.push(options);
      return;
    }
    this.finishDismiss(this.exitReason ?? "replaced");
    this.toast = options;
    this.active = true;
    this.exitReason = null;
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
    if (this.exitTimer !== null) {
      globalThis.clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
  }

  private finishDismiss(reason: ToastDismissReason) {
    const toast = this.toast;
    this.clearDismissTimer();
    this.active = false;
    this.exitReason = null;
    this.toast = null;
    toast?.onDismiss?.(reason);
    if (reason !== "replaced") {
      const next = this.toastQueue.shift();
      if (next) {
        this.show(next);
      }
    }
  }

  private dismiss(reason: ToastDismissReason) {
    const toast = this.toast;
    if (!toast) {
      return;
    }
    this.clearDismissTimer();
    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const anchorRect = toast.anchor?.isConnected ? toast.anchor.getBoundingClientRect() : null;
    const anchored = anchorRect !== null && anchorRect.width > 0;
    if (
      (reason !== "dismiss" && reason !== "timeout") ||
      reducedMotion ||
      !this.isConnected ||
      !anchored
    ) {
      this.finishDismiss(reason);
      return;
    }
    this.active = false;
    this.exitReason = reason;
    this.exitTimer = globalThis.setTimeout(() => {
      if (this.toast === toast) {
        this.finishDismiss(reason);
      }
    }, TOAST_EXIT_FALLBACK_MS);
  }

  override render() {
    const toast = this.toast;
    if (!toast) {
      return nothing;
    }
    const anchorRect = toast.anchor?.isConnected ? toast.anchor.getBoundingClientRect() : null;
    const anchored = anchorRect !== null && anchorRect.width > 0;
    return html`
      <div
        class="app-toast ${anchored ? "app-toast--anchored" : ""}"
        data-active=${this.active ? "true" : "false"}
        style=${styleMap(
          anchored
            ? {
                "--app-toast-anchor-center": `${anchorRect.left + anchorRect.width / 2}px`,
                "--app-toast-anchor-top": `${anchorRect.top + (toast.anchorTopOffset ?? 0)}px`,
                "--app-toast-anchor-width": `${anchorRect.width}px`,
              }
            : {},
        )}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        @transitionend=${(event: TransitionEvent) => {
          if (
            event.target === event.currentTarget &&
            event.propertyName === "opacity" &&
            !this.active &&
            this.exitReason
          ) {
            this.finishDismiss(this.exitReason);
          }
        }}
      >
        ${toast.icon
          ? html`<span class="app-toast__icon" aria-hidden="true">${toast.icon}</span>`
          : nothing}
        <span class="app-toast__message"
          >${typeof toast.message === "string"
            ? formatUiExternalText(toast.message)
            : toast.message}</span
        >
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
          ${icons.x}
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
        (activeModalToastLayer() ?? restingToastLayer())?.moveBefore(host, null),
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
