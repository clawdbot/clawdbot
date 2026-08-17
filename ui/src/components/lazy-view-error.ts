import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { icon } from "./icons.ts";

export function renderLazyViewError({
  error,
  onRetry,
  render,
  stale = false,
}: {
  error: unknown;
  onRetry: (event: Event) => void;
  render?: () => unknown;
  stale?: boolean;
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
        ${stale ? t("lazyView.staleSubtitle") : t("lazyView.genericSubtitle")}
      </div>
      <button class="btn lazy-view-error__action" @click=${onRetry}>
        ${stale ? t("common.reload") : t("lazyView.retry")}
      </button>
      <code class="lazy-view-error__detail">${detail}</code>
    </div>
  `;
}
