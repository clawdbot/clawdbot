import { html, nothing, type TemplateResult } from "lit";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { ScopeUpgradeController } from "../app/device-scope-upgrade-controller.runtime.ts";
import type { ExecApprovalDecision } from "../app/exec-approval.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { t } from "../i18n/index.ts";
import "../styles/sidebar-issues.css";
import { renderHubTabs } from "./hub-tabs.ts";
import { icons } from "./icons.ts";
import {
  sidebarInboxEntryMatchesTab,
  sidebarInboxTabCounts,
  type SidebarAttentionDismissal,
  type SidebarAttentionItem,
  type SidebarInboxEntry,
} from "./sidebar-attention-entries.ts";
import {
  renderSidebarApprovalItem,
  renderSidebarAskOpenClawButton,
  renderSidebarIssueItem,
  renderSidebarScopeUpgradeItem,
  renderSidebarUpdateSurface,
} from "./sidebar-issue-item.ts";
import { ISSUE_TABS, issueTabLabel, type IssueTab } from "./sidebar-issues-tabs.ts";
import "./menu-surface.ts";

// Keep request orchestration behind the same lazy boundary as its Inbox UI;
// ApplicationContext retains the activated controller across presenters.
export { ScopeUpgradeController };

export type SidebarAttentionPanelPosition = { left: number } & (
  | { anchor: "top"; top: number }
  | { anchor: "bottom"; bottom: number }
);

type SidebarAttentionPanelParams = {
  context: ApplicationContext;
  entries: readonly SidebarInboxEntry[];
  onApprovalDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
  onClose: (restoreFocus: boolean) => void;
  onDismiss: (dismissal: SidebarAttentionDismissal) => void;
  onKeydown: (event: KeyboardEvent) => void;
  onNavigate: (routeId: NavigationRouteId) => void;
  onOpen: (item: SidebarAttentionItem) => void;
  onScroll: () => void;
  onSelectTab: (tab: IssueTab) => void;
  overflowAbove: boolean;
  overflowBelow: boolean;
  panelPosition: SidebarAttentionPanelPosition;
  selectedTab: IssueTab;
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
};

export function renderSidebarAttentionPanel(params: SidebarAttentionPanelParams): TemplateResult {
  const { anchor } = params.panelPosition;
  const panelOffset =
    params.panelPosition.anchor === "top" ? params.panelPosition.top : params.panelPosition.bottom;
  const panelStyle = `left:${params.panelPosition.left}px;${anchor}:${panelOffset}px;--sidebar-issues-panel-${anchor}:${panelOffset}px`;
  const visibleEntries = params.entries.filter((entry) =>
    sidebarInboxEntryMatchesTab(entry, params.selectedTab),
  );
  const visibleDismissals = visibleEntries.flatMap((entry) =>
    entry.dismissal ? [entry.dismissal] : [],
  );
  const tabCounts = sidebarInboxTabCounts(params.entries);
  const custodianItems = params.entries.filter(
    (entry) => entry.type === "attention" && entry.action.kind === "askCustodian",
  );
  const custodianSeverity = custodianItems.some((item) => item.severity === "error")
    ? "error"
    : custodianItems.length
      ? "warning"
      : null;
  const renderEntry = (entry: SidebarInboxEntry) => {
    const dismissal = entry.dismissal;
    const onDismiss = dismissal ? () => params.onDismiss(dismissal) : undefined;
    switch (entry.type) {
      case "approval":
        return renderSidebarApprovalItem({
          approval: entry.approval,
          context: params.context,
          onClosePanel: () => params.onClose(false),
          onDecision: params.onApprovalDecision,
        });
      case "attention":
        return renderSidebarIssueItem(entry, {
          basePath: params.context.basePath,
          onDismiss,
          onNavigate: params.onNavigate,
          onOpen: params.onOpen,
        });
      case "scopeUpgrade":
        return renderSidebarScopeUpgradeItem({
          state: entry.state,
          onCancel: () => params.context.scopeUpgrade.cancel(),
          onDismiss,
          onRequest: () => params.context.scopeUpgrade.request(),
          onRetry: () => params.context.scopeUpgrade.retry(),
        });
      case "update":
        return renderSidebarUpdateSurface({
          context: params.context,
          onDismiss,
          onNavigate: () => params.onNavigate("updates"),
          visible: true,
          watchUpdateProgress: params.watchUpdateProgress,
        });
    }
    return entry satisfies never;
  };

  return html`<button
      type="button"
      class="sidebar-issues-panel__backdrop"
      aria-label=${t("common.close")}
      @click=${() => params.onClose(true)}
    ></button>
    <openclaw-menu-surface>
      <section
        id="sidebar-issues-panel"
        class="sidebar-issues-panel"
        role="dialog"
        aria-modal=${isMobileNavLayout() ? "true" : nothing}
        aria-labelledby="sidebar-issues-panel-heading"
        style=${panelStyle}
        @keydown=${params.onKeydown}
      >
        <div class="sidebar-issues-panel__grabber" aria-hidden="true"></div>
        <header class="sidebar-issues-panel__header">
          <h2 id="sidebar-issues-panel-heading" class="sidebar-issues-panel__heading">
            <span class="sidebar-issues-panel__heading-icon" aria-hidden="true"
              >${icons.inbox}</span
            >
            ${t("attention.issues")}
          </h2>
          <div class="sidebar-issues-panel__header-actions">
            ${visibleDismissals.length > 0
              ? html`<button
                  type="button"
                  class="btn btn--xs btn--ghost sidebar-issues-panel__dismiss-shown"
                  @click=${() => {
                    for (const dismissal of visibleDismissals) {
                      params.onDismiss(dismissal);
                    }
                  }}
                >
                  ${t("attention.dismissShown")}
                </button>`
              : nothing}
            ${renderSidebarAskOpenClawButton({
              count: custodianItems.length,
              severity: custodianSeverity,
              snapshot: params.context.gateway.snapshot,
            })}
            <button
              type="button"
              class="sidebar-brand__icon sidebar-issues-panel__mobile-close"
              aria-label=${t("common.close")}
              @click=${() => params.onClose(true)}
            >
              ${icons.x}
            </button>
          </div>
        </header>
        ${renderHubTabs<IssueTab>({
          id: "sidebar-issues",
          active: params.selectedTab,
          tabs: ISSUE_TABS.map((tab) => ({
            value: tab,
            label: issueTabLabel(tab),
            // A zero count is the tab's resting state, not information — show
            // the badge only when the tab actually holds items.
            count: tabCounts[tab] > 0 ? tabCounts[tab] : null,
          })),
          ariaLabel: t("attention.tabs.label"),
          panelId: "sidebar-issues-tabpanel",
          className: "sidebar-issues-panel__tabs",
          variant: "sub",
          onSelect: params.onSelectTab,
        })}
        <div class="sidebar-issues-panel__list-wrap">
          <div
            id="sidebar-issues-tabpanel"
            class="sidebar-issues-panel__list"
            role="tabpanel"
            aria-labelledby=${`sidebar-issues-tab-${params.selectedTab}`}
            tabindex="0"
            @scroll=${params.onScroll}
          >
            ${visibleEntries.length === 0
              ? html`<div class="sidebar-issues-panel__empty">
                  <span class="sidebar-issues-panel__empty-icon" aria-hidden="true"
                    >${icons.inbox}</span
                  >
                  <strong>${t("attention.emptyTitle")}</strong>
                  <span>${t("attention.emptyBody")}</span>
                </div>`
              : nothing}
            ${visibleEntries.map(renderEntry)}
          </div>
          <div
            class="sidebar-issues-panel__overflow-cue sidebar-issues-panel__overflow-cue--top"
            ?hidden=${!params.overflowAbove}
            aria-hidden="true"
          ></div>
          <div
            class="sidebar-issues-panel__overflow-cue sidebar-issues-panel__overflow-cue--bottom"
            ?hidden=${!params.overflowBelow}
            aria-hidden="true"
          ></div>
        </div>
      </section>
    </openclaw-menu-surface>`;
}
