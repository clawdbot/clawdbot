import { html, type TemplateResult } from "lit";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { SkillWorkshopMode } from "../../lib/skill-workshop/index.ts";
import type { SkillWorkshopState } from "./proposals.ts";
import { renderSelfLearningToggle, type SkillWorkshopSelfLearning } from "./self-learning.ts";
import { saveSkillWorkshopMode } from "./storage.ts";

type SkillWorkshopHeaderProps = {
  selfLearning: SkillWorkshopSelfLearning | null;
  onSelfLearningToggle: (enabled: boolean) => void;
  // The page owns what a section change resets, so the strip only reports it.
  onModeChange: (mode: SkillWorkshopMode) => void;
};

export function setSkillWorkshopMode(
  state: SkillWorkshopState,
  mode: SkillWorkshopState["skillWorkshopMode"],
  requestUpdate: () => void,
) {
  if (state.skillWorkshopMode === mode) {
    return;
  }
  state.skillWorkshopMode = mode;
  saveSkillWorkshopMode(mode);
  requestUpdate();
}

function sectionIcon(icon: TemplateResult) {
  return html`<span class="sw-section-tabs__icon" aria-hidden="true">${icon}</span>`;
}

export function renderSkillWorkshopHeaderControls(
  state: SkillWorkshopState,
  { selfLearning, onSelfLearningToggle, onModeChange }: SkillWorkshopHeaderProps,
) {
  // A failed or unfinished list read would otherwise publish a stale or
  // zero count as if it were the current inventory.
  const countsKnown =
    state.skillWorkshopLoaded && !state.skillWorkshopLoading && !state.skillWorkshopError;
  const countOf = (value: number) => (countsKnown ? value : null);
  const pending = state.skillWorkshopProposals.filter(
    (proposal) => proposal.status === "pending",
  ).length;

  return html`
    <div class="sw-header-controls">
      ${renderHubTabs({
        id: "skill-workshop-mode",
        active: state.skillWorkshopMode,
        tabs: [
          {
            value: "skills",
            count: countOf(state.skillWorkshopInstalledSkills.length),
            label: html`
              ${sectionIcon(icons.book)}
              <span>${t("skillWorkshop.sections.skills")}</span>
            `,
          },
          {
            value: "suggestions",
            count: countOf(pending),
            label: html`
              ${sectionIcon(icons.wandSparkles)}
              <span>${t("skillWorkshop.sections.suggestions")}</span>
            `,
          },
        ],
        ariaLabel: t("skillWorkshop.sections.aria"),
        panelId: "skill-workshop-mode-panel",
        variant: "sub",
        onSelect: onModeChange,
      })}
      ${renderSelfLearningToggle(selfLearning, onSelfLearningToggle)}
    </div>
  `;
}
