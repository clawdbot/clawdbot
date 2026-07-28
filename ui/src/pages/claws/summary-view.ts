import { html } from "lit";
import type { ClawsStatusResult } from "../../../../packages/gateway-protocol/src/index.js";
import { icon, type IconName } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";

export function renderClawSummary(status: ClawsStatusResult) {
  const stats: Array<{ key: string; label: string; value: number; iconName: IconName }> = [
    {
      key: "healthy",
      label: t("clawsPage.healthy"),
      value: status.summary.healthy,
      iconName: "check",
    },
    {
      key: "attention",
      label: t("clawsPage.attention"),
      value: status.summary.attention,
      iconName: "alertTriangle",
    },
    {
      key: "managed",
      label: t("clawsPage.managed"),
      value: status.summary.managed,
      iconName: "lock",
    },
    {
      key: "referenced",
      label: t("clawsPage.referenced"),
      value: status.summary.referenced,
      iconName: "link",
    },
  ];
  return html`
    <section class="claws-summary" aria-label=${t("clawsPage.summaryLabel")}>
      ${stats.map(
        (stat) => html`
          <div class="claws-summary__item" data-stat=${stat.key}>
            <span class="claws-summary__icon" aria-hidden="true">${icon(stat.iconName)}</span>
            <div>
              <div class="claws-summary__value">${stat.value}</div>
              <div class="claws-summary__label">${stat.label}</div>
            </div>
          </div>
        `,
      )}
    </section>
  `;
}
