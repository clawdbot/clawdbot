import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { computeLineDiff, type DiffLine, diffStat } from "../../lib/chat/tool-call-diff.ts";
import type { SkillWorkshopAppliedSkill } from "../../lib/skill-workshop/index.ts";
import type { SkillWorkshopProps } from "./view-types.ts";

const DIFF_SIGN: Record<DiffLine["kind"], string> = {
  add: "+",
  del: "-",
  ctx: " ",
  file: " ",
  skip: "\u22ef",
};

function renderDiffRow(line: DiffLine) {
  return html`
    <div class="sw-diff__row sw-diff__row--${line.kind}">
      <span class="sw-diff__sign" aria-hidden="true">${DIFF_SIGN[line.kind]}</span>
      <span class="sw-diff__text">${line.kind === "skip" ? "" : line.text}</span>
    </div>
  `;
}

export function renderAppliedRevisionDiff(previousBody: string, body: string) {
  const lines = computeLineDiff(previousBody, body, { compactUnchanged: true });
  if (lines.length === 0) {
    return html`<p class="sw-muted">${t("skillWorkshop.diff.unchanged")}</p>`;
  }
  const { added, removed } = diffStat(lines);
  return html`
    <div class="sw-diff">
      <p class="sw-diff__stat">
        <span class="sw-diff__stat-add">+${added}</span>
        <span class="sw-diff__stat-del">-${removed}</span>
      </p>
      <div class="sw-diff__rows">${lines.map(renderDiffRow)}</div>
    </div>
  `;
}

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
