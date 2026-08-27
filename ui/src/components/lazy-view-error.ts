import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { icon } from "./icons.ts";
import { renderLoadingState } from "./loading-state.ts";

type LazyElementState =
  | { status: "loading"; element: { label: string } }
  | { status: "error"; element: { label: string }; error: unknown; stale: boolean };

export function renderLazyElementState(
  state: LazyElementState,
  onRetry: () => void,
  onClose: () => void,
) {
  return state.status === "loading"
    ? renderLoadingState()
    : renderLazyViewError({
        actionLabel: t("common.retry"),
        error: state.error,
        stale: state.stale,
        subtitle: state.element.label,
        onRetry,
        onClose,
      });
}

export function renderLazyElementModal(controller: {
  visibleState: LazyElementState | undefined;
  retry(): void;
  close(): void;
}) {
  const state = controller.visibleState;
  if (!state) {
    return nothing;
  }
  const close = () => controller.close();
  return html`<openclaw-modal-dialog label=${state.element.label} @modal-cancel=${close}>
    ${renderLazyElementState(state, () => controller.retry(), close)}
  </openclaw-modal-dialog>`;
}

export function renderLazyViewError({
  actionLabel,
  error,
  onClose,
  onRetry,
  render,
  stale = false,
  subtitle,
}: {
  actionLabel?: string;
  error: unknown;
  onClose?: (event: Event) => void;
  onRetry: (event: Event) => void;
  render?: () => unknown;
  stale?: boolean;
  subtitle?: string;
}) {
  const detail = formatUiError(error);
  const errorClasses = `lazy-view-error${render ? " lazy-view-error--inline" : ""}${stale ? " lazy-view-error--stale" : ""}`;
  return html`
    ${render?.() ?? nothing}
    <div class=${errorClasses} role="alert">
      <div class="lazy-view-error__icon" aria-hidden="true">
        ${icon(stale ? "refresh" : "alertTriangle")}
      </div>
      <div class="lazy-view-error__title">
        ${stale ? t("lazyView.staleTitle") : t("lazyView.errorTitle")}
      </div>
      <div class="lazy-view-error__subtitle">
        ${subtitle ?? (stale ? t("lazyView.staleSubtitle") : t("lazyView.genericSubtitle"))}
      </div>
      <div class="lazy-view-error__actions">
        <button class="btn lazy-view-error__action" @click=${onRetry}>
          ${actionLabel ?? (stale ? t("common.reload") : t("lazyView.retry"))}
        </button>
        ${onClose
          ? html`<button class="btn" type="button" @click=${onClose}>${t("common.close")}</button>`
          : nothing}
      </div>
      <code class="lazy-view-error__detail">${detail}</code>
    </div>
  `;
}
