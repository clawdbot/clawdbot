import { html } from "lit";
import { t } from "../../i18n/index.ts";
import type { SkillWorkshopAppliedSkill } from "../../lib/skill-workshop/index.ts";
import type { SkillWorkshopProps } from "./view-types.ts";

export function renderAppliedHistory(props: SkillWorkshopProps, skill: SkillWorkshopAppliedSkill) {
  return html`
    <section class="sw-section sw-applied-history">
      <h3 class="sw-section__label">${t("skillWorkshop.applied.history")}</h3>
      <div class="sw-applied-history__list">
        ${skill.revisions.map(({ proposal, operation, version }) => {
          const selected = proposal.key === props.selectedKey;
          return html`
            <button
              class="sw-applied-history__item ${selected ? "is-selected" : ""}"
              aria-current=${selected ? "true" : "false"}
              @click=${() => props.onSelect(proposal.key)}
            >
              <span class="sw-applied-history__operation">
                ${t(`skillWorkshop.applied.${operation}`)}
              </span>
              <span class="sw-applied-history__age">${proposal.ageLabel}</span>
              <span class="sw-applied-history__version">
                ${t("skillWorkshop.applied.version", { version: String(version) })}
              </span>
            </button>
          `;
        })}
      </div>
    </section>
  `;
}
