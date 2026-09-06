import { html } from "lit";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { t } from "../../i18n/index.ts";
import type { SkillWorkshopState } from "./proposals.ts";
import { renderSelfLearningToggle, type SkillWorkshopSelfLearning } from "./self-learning.ts";
import { saveSkillWorkshopMode } from "./storage.ts";

type SkillWorkshopHeaderProps = {
  selfLearning: SkillWorkshopSelfLearning | null;
  onSelfLearningToggle: (enabled: boolean) => void;
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

export function renderSkillWorkshopHeaderControls(
  state: SkillWorkshopState,
  { selfLearning, onSelfLearningToggle }: SkillWorkshopHeaderProps,
  requestUpdate: () => void,
) {
  return html`
    <div class="sw-header-controls">
      ${renderSelfLearningToggle(selfLearning, onSelfLearningToggle)}
      ${renderHubTabs({
        id: "skill-workshop-mode",
        active: state.skillWorkshopMode,
        tabs: [
          {
            value: "board",
            label: html`
              <svg viewBox="0 0 24 24" class="sw-mode-tabs__icon" aria-hidden="true">
                <rect x="3" y="4" width="7" height="16" rx="1.5" />
                <rect x="14" y="4" width="7" height="9" rx="1.5" />
                <rect x="14" y="15" width="7" height="5" rx="1.5" />
              </svg>
              <span>${t("skillWorkshop.header.board")}</span>
            `,
          },
          {
            value: "today",
            label: html`
              <svg viewBox="0 0 24 24" class="sw-mode-tabs__icon" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path
                  d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"
                />
              </svg>
              <span>${t("skillWorkshop.header.today")}</span>
            `,
          },
        ],
        ariaLabel: t("skillWorkshop.header.view"),
        panelId: "skill-workshop-mode-panel",
        variant: "sub",
        onSelect: (mode) => setSkillWorkshopMode(state, mode, requestUpdate),
      })}
    </div>
  `;
}
