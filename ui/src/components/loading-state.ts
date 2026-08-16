import { html } from "lit";
import { t } from "../i18n/index.ts";
import "./openclaw-mascot.ts";

export function renderLoadingState() {
  return html`
    <section
      class="lazy-view-state lazy-view-state--loading"
      role="status"
      aria-live="polite"
      aria-label=${t("common.loading")}
    >
      <openclaw-mascot mood="thinking" .size=${120}></openclaw-mascot>
    </section>
  `;
}
