import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";

export function renderLoadingSkeleton() {
  return html`<div class="loading-skeleton" aria-hidden="true">
    <div class="loading-skeleton__header">
      <div class="skeleton loading-skeleton__avatar"></div>
      <div class="skeleton skeleton-line loading-skeleton__title"></div>
    </div>
    <div class="loading-skeleton__messages">
      <div class="loading-skeleton__message loading-skeleton__message--user">
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line skeleton-line--medium"></div>
      </div>
      <div class="loading-skeleton__message">
        <div class="skeleton loading-skeleton__avatar"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line skeleton-line--long"></div>
        <div class="skeleton skeleton-line skeleton-line--medium"></div>
      </div>
    </div>
    <div class="skeleton loading-skeleton__composer"></div>
  </div>`;
}

export function renderConnectingSplash(status?: string) {
  return html`<main
    class="connect-splash connect-splash--skeleton"
    role="status"
    aria-live="polite"
    aria-label=${status ?? t("common.loading")}
  >
    <div class="connect-splash__layout" aria-hidden="true">
      <aside class="connect-splash__sidebar">
        <div class="skeleton loading-skeleton__avatar"></div>
        <div class="skeleton connect-splash__new-session"></div>
        ${[85, 65, 75, 55, 80, 60].map(
          (width) => html`<div class="skeleton skeleton-line" style=${`width: ${width}%`}></div>`,
        )}
      </aside>
      ${renderLoadingSkeleton()}
    </div>
    ${status ? html`<span class="connect-splash__status">${status}</span>` : nothing}
  </main>`;
}
