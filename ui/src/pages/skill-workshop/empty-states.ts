// Empty-state renderers for the Workshop: the Suggestions and History detail
// panes, plus the whole-page no-proposals panel with the self-learning pitch.
import { html } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { SkillWorkshopStatusFilter } from "../../lib/skill-workshop/index.ts";
import { renderSelfLearningPitch, type SkillWorkshopSelfLearning } from "./self-learning.ts";

type SkillWorkshopEmptyIcon = "search" | "clock" | "check" | "x" | "shield" | "refresh";

export function renderSkillWorkshopEmptyDetail(params: {
  section: "suggestions" | "history";
  query: string;
  statusFilter: SkillWorkshopStatusFilter;
}) {
  const empty = resolveEmptyState(params);
  return html`
    <div class="sw-detail sw-detail--empty">
      <div class="sw-filter-empty">
        <div class="sw-filter-empty__icon" aria-hidden="true">${emptyStateIcons[empty.icon]}</div>
        <p class="sw-empty__title">${empty.title}</p>
        <p class="sw-empty__sub">${empty.body}</p>
      </div>
    </div>
  `;
}

function resolveEmptyState(params: {
  section: "suggestions" | "history";
  query: string;
  statusFilter: SkillWorkshopStatusFilter;
}): {
  icon: SkillWorkshopEmptyIcon;
  title: string;
  body: string;
} {
  if (params.query.trim()) {
    return {
      icon: "search",
      title: t("skillWorkshop.empty.searchTitle"),
      body: t("skillWorkshop.empty.searchBody"),
    };
  }
  if (params.section === "suggestions") {
    return {
      icon: "clock",
      title: t("skillWorkshop.empty.pendingTitle"),
      body: t("skillWorkshop.empty.pendingBody"),
    };
  }

  switch (params.statusFilter) {
    case "applied":
      return {
        icon: "check",
        title: t("skillWorkshop.records.emptyAppliedTitle"),
        body: t("skillWorkshop.records.emptyAppliedBody"),
      };
    case "rejected":
      return {
        icon: "x",
        title: t("skillWorkshop.records.emptyRejectedTitle"),
        body: t("skillWorkshop.records.emptyRejectedBody"),
      };
    case "quarantined":
      return {
        icon: "shield",
        title: t("skillWorkshop.records.emptyQuarantinedTitle"),
        body: t("skillWorkshop.records.emptyQuarantinedBody"),
      };
    case "stale":
      return {
        icon: "refresh",
        title: t("skillWorkshop.records.emptyStaleTitle"),
        body: t("skillWorkshop.records.emptyStaleBody"),
      };
    case "all":
    case "pending":
      break;
  }
  return {
    icon: "clock",
    title: t("skillWorkshop.records.emptyTitle"),
    body: t("skillWorkshop.records.emptyBody"),
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
