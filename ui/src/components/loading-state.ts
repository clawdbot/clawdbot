import { html } from "lit";
import { t } from "../i18n/index.ts";
import { renderLoadingSkeleton } from "./loading-skeleton.ts";

export function renderLoadingState() {
  return html`
    <section
      class="lazy-view-state lazy-view-state--loading"
      role="status"
      aria-live="polite"
      aria-label=${t("common.loading")}
    >
      ${renderLoadingSkeleton()}
    </section>
  `;
}
