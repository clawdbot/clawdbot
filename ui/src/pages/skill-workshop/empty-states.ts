// Empty-state renderers for the Workshop board: filtered-queue detail pane
// and the whole-page no-proposals panel with the self-learning pitch.
import { html, nothing } from "lit";
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

function renderEmptyStateIcon(icon: SkillWorkshopEmptyIcon) {
  switch (icon) {
    case "clock":
      return html`
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="8"></circle>
          <path d="M12 7v5l3 2"></path>
        </svg>
      `;
    case "check":
      return html`
        <svg viewBox="0 0 24 24">
          <path d="M5 12.5l4 4L19 7"></path>
        </svg>
      `;
    case "x":
      return html`
        <svg viewBox="0 0 24 24">
          <path d="M7 7l10 10"></path>
          <path d="M17 7L7 17"></path>
        </svg>
      `;
    case "shield":
      return html`
        <svg viewBox="0 0 24 24">
          <path d="M12 3l7 3v5c0 4.2-2.8 7.8-7 10-4.2-2.2-7-5.8-7-10V6l7-3z"></path>
          <path d="M9 12l2 2 4-5"></path>
        </svg>
      `;
    case "refresh":
      return html`
        <svg viewBox="0 0 24 24">
          <path d="M17 2v5h-5"></path>
          <path d="M7 22v-5h5"></path>
          <path d="M19 10a7 7 0 0 0-12-4l-2 2"></path>
          <path d="M5 14a7 7 0 0 0 12 4l2-2"></path>
        </svg>
      `;
    case "search":
      return html`
        <svg viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="6"></circle>
          <path d="M16 16l4 4"></path>
        </svg>
      `;
  }
  return nothing;
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
