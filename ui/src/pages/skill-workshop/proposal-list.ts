import { html } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  SkillWorkshopAppliedSkill,
  SkillWorkshopProposal,
} from "../../lib/skill-workshop/index.ts";
import type { SkillWorkshopProps } from "./view-types.ts";

export function renderSkillWorkshopProposalList(
  props: SkillWorkshopProps,
  groups: Array<{ label: string; items: SkillWorkshopProposal[] }>,
  selected: SkillWorkshopProposal | undefined,
  appliedSkills: SkillWorkshopAppliedSkill[],
  emptyText: string,
) {
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const appliedSkillsBySlug = new Map(appliedSkills.map((skill) => [skill.slug, skill]));
  return html`
    <aside class="sw-queue">
      <div class="sw-queue__search">
        <input
          placeholder=${t("skillWorkshop.queue.search")}
          .value=${props.query}
          @input=${(event: Event) =>
            // SAFETY: handler is bound on the <input> itself, so currentTarget is that element.
            props.onQueryChange((event.currentTarget as HTMLInputElement).value ?? "")}
        />
      </div>
      <div class="sw-queue__body">
        ${total === 0
          ? html`<div class="sw-queue__empty">${emptyText}</div>`
          : groups.map(
              (group) => html`
                <div class="sw-queue__group">
                  ${t(group.label)}
                  <span class="settings-count">${group.items.length}</span>
                </div>
                ${group.items.map((proposal) =>
                  renderProposalRow(
                    props,
                    proposal,
                    selected,
                    appliedSkillsBySlug.get(proposal.slug),
                  ),
                )}
              `,
            )}
      </div>
    </aside>
  `;
}

function renderProposalRow(
  props: SkillWorkshopProps,
  proposal: SkillWorkshopProposal,
  selected: SkillWorkshopProposal | undefined,
  appliedSkill: SkillWorkshopAppliedSkill | undefined,
) {
  const latest = appliedSkill?.latest ?? proposal;
  const isSelected = appliedSkill
    ? appliedSkill.revisions.some(
        ({ proposal: revisionProposal }) => revisionProposal.key === props.selectedKey,
      )
    : selected?.key === proposal.key;
  const revisionCountKey =
    appliedSkill?.revisions.length === 1
      ? "skillWorkshop.applied.revision"
      : "skillWorkshop.applied.revisions";
  return html`
    <button
      class="sw-row ${latest.isNew ? "is-new" : "is-seen"} ${isSelected ? "is-selected" : ""}"
      @click=${() => props.onSelect(latest.key)}
    >
      <span class="sw-row__dot"></span>
      <span>
        <span class="sw-row__title">${appliedSkill?.slug ?? proposal.name}</span>
        <span class="sw-row__desc">${latest.oneLine}</span>
      </span>
      ${appliedSkill
        ? html`
            <span class="sw-row__meta sw-row__meta--applied">
              <span class="sw-row__revision-count">
                ${t(revisionCountKey, { count: String(appliedSkill.revisions.length) })}
              </span>
              <span>${latest.ageLabel}</span>
            </span>
          `
        : html`<span class="sw-row__meta">${proposal.ageLabel}</span>`}
    </button>
  `;
}
