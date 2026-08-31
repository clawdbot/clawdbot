// Empty-state renderers for the Workshop board: filtered-queue detail pane
// and the whole-page no-proposals panel with the self-learning pitch.
import { html } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { SkillWorkshopStatusFilter } from "../../lib/skill-workshop/index.ts";
import { renderSelfLearningPitch, type SkillWorkshopSelfLearning } from "./self-learning.ts";

type SkillWorkshopEmptyIcon = "search" | "clock" | "check" | "x" | "shield" | "refresh";

export function renderBoardEmptyDetail(query: string, statusFilter: SkillWorkshopStatusFilter) {
  const empty = resolveBoardEmptyState(query, statusFilter);
  return html`
    <div class="sw-detail sw-detail--empty">
      <div class="sw-filter-empty">
        <div class="sw-filter-empty__icon" aria-hidden="true">
          ${renderEmptyStateIcon(empty.icon)}
        </div>
        <p class="sw-empty__title">${empty.title}</p>
        <p class="sw-empty__sub">${empty.body}</p>
      </div>
    </div>
  `;
}

function resolveBoardEmptyState(
  query: string,
  statusFilter: SkillWorkshopStatusFilter,
): {
  icon: SkillWorkshopEmptyIcon;
  title: string;
  body: string;
} {
  if (query.trim()) {
    return {
      icon: "search",
      title: t("skillWorkshop.empty.searchTitle"),
      body: t("skillWorkshop.empty.searchBody"),
    };
  }

  switch (statusFilter) {
    case "pending":
      return {
        icon: "clock",
        title: t("skillWorkshop.empty.pendingTitle"),
        body: t("skillWorkshop.empty.pendingBody"),
      };
    case "applied":
      return {
        icon: "check",
        title: t("skillWorkshop.empty.appliedTitle"),
        body: t("skillWorkshop.empty.appliedBody"),
      };
    case "rejected":
      return {
        icon: "x",
        title: t("skillWorkshop.empty.rejectedTitle"),
        body: t("skillWorkshop.empty.rejectedBody"),
      };
    case "quarantined":
      return {
        icon: "shield",
        title: t("skillWorkshop.empty.quarantinedTitle"),
        body: t("skillWorkshop.empty.quarantinedBody"),
      };
    case "stale":
      return {
        icon: "refresh",
        title: t("skillWorkshop.empty.staleTitle"),
        body: t("skillWorkshop.empty.staleBody"),
      };
    case "all":
      return {
        icon: "search",
        title: t("skillWorkshop.empty.allTitle"),
        body: t("skillWorkshop.empty.allBody"),
      };
  }
  return {
    icon: "search",
    title: t("skillWorkshop.empty.allTitle"),
    body: t("skillWorkshop.empty.allBody"),
  };
}

const emptyStateIcons: Record<SkillWorkshopEmptyIcon, (typeof icons)[keyof typeof icons]> = {
  search: icons.search,
  clock: icons.clock,
  check: icons.check,
  x: icons.x,
  shield: icons.shieldCheck,
  refresh: icons.refresh,
};

function renderEmptyStateIcon(icon: SkillWorkshopEmptyIcon) {
  return emptyStateIcons[icon];
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
