import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";

export type ClawStage = "overview" | "personalize" | "review" | "add" | "connect" | "ready";

const CLAW_STAGES: readonly ClawStage[] = [
  "overview",
  "personalize",
  "review",
  "add",
  "connect",
  "ready",
];

export function renderClawStages(active: ClawStage) {
  return html`<ol class="claws-stages" aria-label=${t("clawsPage.stages.label")}>
    ${CLAW_STAGES.map(
      (stage, index) => html`<li
        class="claws-stages__item ${stage === active ? "claws-stages__item--active" : ""}"
        aria-current=${stage === active ? "step" : nothing}
      >
        <span>${index + 1}</span>${t(`clawsPage.stages.${stage}`)}
      </li>`,
    )}
  </ol>`;
}
