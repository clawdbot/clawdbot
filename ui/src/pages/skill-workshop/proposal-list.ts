import { html } from "lit";
import { t } from "../../i18n/index.ts";
import type { SkillWorkshopProposal } from "../../lib/skill-workshop/index.ts";
import type { SkillWorkshopProps } from "./view-types.ts";

export function renderSkillWorkshopProposalList(params: {
  props: SkillWorkshopProps;
  groups: Array<{ label: string; items: SkillWorkshopProposal[] }>;
  selected: SkillWorkshopProposal | undefined;
  emptyText: string;
  searchLabel: string;
  searchPlaceholder: string;
}) {
  const { props, groups, selected } = params;
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  return html`
    <aside class="sw-queue" aria-label=${params.searchLabel}>
      <div class="sw-queue__search">
        <input
          type="search"
          aria-label=${params.searchLabel}
          placeholder=${params.searchPlaceholder}
          .value=${props.query}
          @input=${(event: Event) =>
            // SAFETY: handler is bound on the <input> itself, so currentTarget is that element.
            props.onQueryChange((event.currentTarget as HTMLInputElement).value ?? "")}
        />
      </div>
      <div class="sw-queue__body">
        ${
          total === 0
            ? html`<div class="sw-queue__empty">${params.emptyText}</div>`
            : groups.map(
                (group) => html`
                  <div class="sw-queue__group">
                    ${t(group.label)}
                    <span class="settings-count">${group.items.length}</span>
                  </div>
                  ${group.items.map((proposal) => renderProposalRow(props, proposal, selected))}
                `,
              )
        }
      </div>
    </aside>
  `;
}

function renderProposalRow(
  props: SkillWorkshopProps,
  proposal: SkillWorkshopProposal,
  selected: SkillWorkshopProposal | undefined,
) {
  const isSelected = selected?.key === proposal.key;
  return html`
    <button
      class="sw-row ${isSelected ? "is-selected" : ""}"
      @click=${() => props.onSelect(proposal.key)}
    >
      <span class="sw-row__dot"></span>
      <span>
        <span class="sw-row__title">${proposal.name}</span>
        <span class="sw-row__desc">${proposal.oneLine}</span>
      </span>
      <span class="sw-row__meta">${proposal.ageLabel}</span>
    </button>
  `;
}
