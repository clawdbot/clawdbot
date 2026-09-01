import { html } from "lit";
import { t } from "../i18n/index.ts";

export function renderLoadingState() {
  return html`<div
    class="workboard-loading"
    role="status"
    aria-live="polite"
    aria-label=${t("common.loading")}
  >
    ${t("common.loading")}
  </div>`;
}
