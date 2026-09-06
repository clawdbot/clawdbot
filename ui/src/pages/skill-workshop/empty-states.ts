import { html } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { renderSelfLearningPitch, type SkillWorkshopSelfLearning } from "./self-learning.ts";

export function renderSkillWorkshopEmptyDetail({ query }: { query: string }) {
  const searching = query.trim().length > 0;
  return html`
    <div class="sw-detail sw-detail--empty">
      <div class="sw-filter-empty">
        <div class="sw-filter-empty__icon" aria-hidden="true">
          ${searching ? icons.search : icons.clock}
        </div>
        <p class="sw-empty__title">
          ${t(searching ? "skillWorkshop.empty.searchTitle" : "skillWorkshop.empty.pendingTitle")}
        </p>
        <p class="sw-empty__sub">
          ${t(searching ? "skillWorkshop.empty.searchBody" : "skillWorkshop.empty.pendingBody")}
        </p>
      </div>
    </div>
  `;
}

export function renderWorkshopEmptyState(params: {
  agentName: string;
  selfLearning: SkillWorkshopSelfLearning | null;
  onSelfLearningToggle: (enabled: boolean) => void;
}) {
  return html`
    <div class="sw-empty-state">
      <section class="sw-empty-state__panel" aria-label=${t("skillWorkshop.empty.noProposalsAria")}>
        <div class="sw-empty-state__glyph" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <p class="sw-empty-state__eyebrow">${t("skillWorkshop.title")}</p>
        <h2>${t("skillWorkshop.empty.noProposalsTitle")}</h2>
        <p>${t("skillWorkshop.empty.noProposalsBody", { agent: params.agentName })}</p>
        <div class="sw-empty-state__footer">${t("skillWorkshop.empty.noProposalsFooter")}</div>
        ${renderSelfLearningPitch(params.selfLearning, params.onSelfLearningToggle)}
      </section>
    </div>
  `;
}
