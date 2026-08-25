import { html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { formatUiExternalText } from "./format-error.ts";

type ToastVariant = "info" | "success" | "warning" | "danger";
type ToastDismissReason = "action" | "dismiss" | "disconnected" | "replaced" | "timeout";

export type ToastOptions = {
  message: string | TemplateResult;
  variant: ToastVariant;
  key?: string;
  scope?: { kind: "session"; sessionKey: string };
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: (reason: ToastDismissReason) => void;
  durationMs?: number;
};

type ToastEntry = ToastOptions & {
  id: number;
  active: boolean;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
};

const MAX_VISIBLE_TOASTS = 3;
const DEFAULT_DURATIONS: Record<ToastVariant, number> = {
  info: 6_000,
  success: 5_000,
  warning: 8_000,
  danger: 12_000,
};
const TOAST_EXIT_MS = 150;
let nextToastId = 0;

function activeModalToastLayer() {
  return [...(document.openClawModalToastLayers ?? [])].findLast(
    (candidate) => candidate.isConnected,
  );
}

function sessionToastAnchor(sessionKey: string): Element | null {
  const panes = document.querySelectorAll<HTMLElement & { sessionKey?: string }>(
    "openclaw-chat-pane.chat-pane-cache__pane--visible",
  );
  return [...panes].find((pane) => pane.sessionKey === sessionKey) ?? null;
}

// Startup outcomes can precede the shell. Preserve the same bounded admission
// policy used by a mounted host so early bursts do not collapse to one event.
let queuedToasts: ToastOptions[] = [];

class OpenClawToastHost extends OpenClawLightDomContentsElement {
  @state() private entries: ToastEntry[] = [];

  override connectedCallback() {
    super.connectedCallback();
    const pending = queuedToasts;
    queuedToasts = [];
    for (const toast of pending) {
      this.show(toast);
    }
  }

  override disconnectedCallback() {
    const target = activeModalToastLayer() ?? document.querySelector(".shell");
    if (!this.isConnected && this.parentElement?.localName === "openclaw-modal-dialog" && target) {
      target.append(this);
    } else {
      for (const entry of this.entries) {
        this.finishDismiss(entry, "disconnected");
      }
    }
    super.disconnectedCallback();
  }

  /** Keep active outcomes intact while moveBefore() crosses top-layer owners. */
  connectedMoveCallback() {}

  show(options: ToastOptions) {
    const matching = options.key
      ? this.entries.find((entry) => entry.key === options.key)
      : undefined;
    if (matching) {
      matching.onDismiss?.("replaced");
      this.clearTimer(matching);
      Object.assign(matching, options, { active: true });
      this.startTimer(matching);
      this.entries = [...this.entries];
      return;
    }

    if (this.entries.length === MAX_VISIBLE_TOASTS) {
      this.finishDismiss(this.entries[0]!, "replaced");
    }
    const entry: ToastEntry = {
      ...options,
      id: ++nextToastId,
      active: true,
      timer: null,
    };
    this.entries = [...this.entries, entry];
    this.startTimer(entry);
  }

  private startTimer(entry: ToastEntry) {
    entry.timer = globalThis.setTimeout(
      () => this.dismiss(entry, "timeout"),
      entry.durationMs ?? DEFAULT_DURATIONS[entry.variant],
    );
  }

  private clearTimer(entry: ToastEntry) {
    if (entry.timer !== null) {
      globalThis.clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  private finishDismiss(entry: ToastEntry, reason: ToastDismissReason) {
    if (!this.entries.includes(entry)) {
      return;
    }
    this.clearTimer(entry);
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    entry.onDismiss?.(reason);
  }

  private dismiss(entry: ToastEntry, reason: ToastDismissReason) {
    this.clearTimer(entry);
    if (
      reason === "action" ||
      reason === "disconnected" ||
      reason === "replaced" ||
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      this.finishDismiss(entry, reason);
      return;
    }
    entry.active = false;
    this.entries = [...this.entries];
    globalThis.setTimeout(() => this.finishDismiss(entry, reason), TOAST_EXIT_MS);
  }

  override render() {
    return html`${this.entries.map((entry, index) => this.renderEntry(entry, index))}`;
  }

  private renderEntry(entry: ToastEntry, index: number) {
    const anchor = entry.scope ? sessionToastAnchor(entry.scope.sessionKey) : null;
    const rect = anchor?.getBoundingClientRect();
    const anchored = rect !== undefined && rect.width > 0;
    const assertive = entry.variant === "warning" || entry.variant === "danger";
    const icon =
      entry.variant === "success"
        ? icons.check
        : entry.variant === "info"
          ? icons.radio
          : icons.alertTriangle;
    return html`
      <div
        class="app-toast app-toast--${entry.variant} ${anchored ? "app-toast--session" : ""}"
        data-active=${entry.active ? "true" : "false"}
        style=${styleMap(
          anchored
            ? {
                "--app-toast-anchor-center": `${rect.left + rect.width / 2}px`,
                "--app-toast-anchor-top": `${rect.top + 56 + index * 44}px`,
                "--app-toast-anchor-width": `${rect.width}px`,
              }
            : { "--app-toast-index": String(this.globalIndex(entry)) },
        )}
        role=${assertive ? "alert" : "status"}
        aria-live=${assertive ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <span class="app-toast__icon" aria-hidden="true">${icon}</span>
        <span class="app-toast__message"
          >${typeof entry.message === "string"
            ? formatUiExternalText(entry.message)
            : entry.message}</span
        >
        ${entry.actionLabel && entry.onAction
          ? html`<button
              type="button"
              class="app-toast__action"
              @click=${() => {
                this.dismiss(entry, "action");
                entry.onAction?.();
              }}
            >
              ${entry.actionLabel}
            </button>`
          : nothing}
        <button
          type="button"
          class="app-toast__dismiss"
          aria-label=${t("common.dismiss")}
          @click=${() => this.dismiss(entry, "dismiss")}
        >
          ${icons.x}
        </button>
      </div>
    `;
  }

  private globalIndex(entry: ToastEntry): number {
    return this.entries
      .filter((candidate) => !candidate.scope || !sessionToastAnchor(candidate.scope.sessionKey))
      .indexOf(entry);
  }
}

export function showToast(options: ToastOptions): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const host = document.querySelector<OpenClawToastHost>("openclaw-toast-host");
  if (!host) {
    const matching = options.key
      ? queuedToasts.findIndex((entry) => entry.key === options.key)
      : -1;
    if (matching >= 0) {
      queuedToasts[matching] = options;
    } else {
      queuedToasts = [...queuedToasts.slice(-(MAX_VISIBLE_TOASTS - 1)), options];
    }
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

if (typeof customElements !== "undefined" && !customElements.get("openclaw-toast-host")) {
  customElements.define("openclaw-toast-host", OpenClawToastHost);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-toast-host": OpenClawToastHost;
  }
}
