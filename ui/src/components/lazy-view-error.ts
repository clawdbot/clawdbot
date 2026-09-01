import { html, nothing, type TemplateResult } from "lit";
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
  return html`
    ${render?.() ?? nothing}
    ${renderPanelErrorState({
      title: stale ? t("lazyView.staleTitle") : t("lazyView.errorTitle"),
      subtitle: subtitle ?? (stale ? t("lazyView.staleSubtitle") : t("lazyView.genericSubtitle")),
      actions: html`
        <button class="btn lazy-view-error__action" @click=${onRetry}>
          ${actionLabel ?? (stale ? t("common.reload") : t("lazyView.retry"))}
        </button>
        ${onClose
          ? html`<button class="btn" type="button" @click=${onClose}>${t("common.close")}</button>`
          : nothing}
      `,
      detail,
      inline: Boolean(render),
      stale,
    })}
  `;
}

export function renderPanelErrorState({
  actions,
  className,
  detail,
  inline = false,
  role = "alert",
  stale = false,
  subtitle,
  title,
}: {
  actions?: TemplateResult;
  className?: string;
  detail?: string;
  inline?: boolean;
  role?: "alert" | "status";
  stale?: boolean;
  subtitle: string;
  title: string;
}) {
  const errorClasses = `lazy-view-error${inline ? " lazy-view-error--inline" : ""}${stale ? " lazy-view-error--stale" : ""}${className ? ` ${className}` : ""}`;
  return html`
    <div class=${errorClasses} role=${role}>
      <div class="lazy-view-error__icon" aria-hidden="true">
        ${icon(stale ? "refresh" : "alertTriangle")}
      </div>
      <div class="lazy-view-error__title">${title}</div>
      <div class="lazy-view-error__subtitle">${subtitle}</div>
      ${actions ? html`<div class="lazy-view-error__actions">${actions}</div>` : nothing}
      ${detail ? html`<code class="lazy-view-error__detail">${detail}</code>` : nothing}
    </div>
  `;
}
