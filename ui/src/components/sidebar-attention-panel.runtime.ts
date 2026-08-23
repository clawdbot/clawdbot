import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../app/exec-approval.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { t } from "../i18n/index.ts";
import "../styles/sidebar-issues.css";
import { icons } from "./icons.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-items.ts";
import {
  renderSidebarApprovalItem,
  renderSidebarAskOpenClawButton,
  renderSidebarIssueItem,
  renderSidebarUpdateSurface,
} from "./sidebar-issue-item.ts";
import { ISSUE_TABS, issueTabLabel, type IssueTab } from "./sidebar-issues-tabs.ts";
import { syncTabGroupLabel } from "./web-awesome-tabs.ts";
import "./menu-surface.ts";

type SidebarAttentionPanelParams = {
  approvalQueue: readonly ExecApprovalRequest[];
  context: ApplicationContext;
  items: SidebarAttentionItem[];
  onApprovalDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
  onClose: (restoreFocus: boolean) => void;
  onDismiss: (item: SidebarAttentionItem) => void;
  onDismissUpdate: () => void;
  onKeydown: (event: KeyboardEvent) => void;
  onNavigate: (routeId: NavigationRouteId) => void;
  onOpen: (item: SidebarAttentionItem) => void;
  onScroll: () => void;
  onSelectTab: (tab: IssueTab) => void;
  overflowAbove: boolean;
  overflowBelow: boolean;
  panelPosition: { left: number; bottom: number };
  selectedTab: IssueTab;
  updateSurface: boolean;
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
};

function isIssueTab(value: string): value is IssueTab {
  return ISSUE_TABS.some((tab) => tab === value);
}

function renderTab(tab: IssueTab, count: number, selected: boolean) {
  const countLabel = t(count === 1 ? "attention.issueCount" : "attention.issueCountPlural", {
    count: String(count),
  });
  return html`<wa-tab
    slot="nav"
    id=${`sidebar-issues-tab-${tab}`}
    class="sidebar-issues-panel__tab"
    panel=${tab}
    aria-label=${`${issueTabLabel(tab)}, ${countLabel}`}
    aria-controls="sidebar-issues-tabpanel"
    ?active=${selected}
  >
    <span>${issueTabLabel(tab)}</span>
    <span class="sidebar-issues-panel__tab-count" aria-hidden="true">${count}</span>
  </wa-tab>`;
}

export function renderSidebarAttentionPanel(params: SidebarAttentionPanelParams): TemplateResult {
  const automationItems = params.items.filter(
    (item) => item.kind === "cronFailed" || item.kind === "cronOverdue",
  );
  const systemItems = params.items.filter((item) => item.kind === "modelAuthExpired");
  const visibleItems =
    params.selectedTab === "automations"
      ? automationItems
      : params.selectedTab === "system"
        ? systemItems
        : params.selectedTab === "approvals"
          ? []
          : params.items;
  const showApprovals = params.selectedTab === "all" || params.selectedTab === "approvals";
  const showUpdate = params.updateSurface && ["all", "system"].includes(params.selectedTab);
  const visibleCount =
    (showApprovals ? params.approvalQueue.length : 0) + visibleItems.length + (showUpdate ? 1 : 0);
  const errorItems = visibleItems.filter((item) => item.severity === "error");
  const warningItems = visibleItems.filter((item) => item.severity === "warning");
  const count = params.approvalQueue.length + params.items.length + (params.updateSurface ? 1 : 0);
  const tabCounts: Record<IssueTab, number> = {
    all: count,
    approvals: params.approvalQueue.length,
    automations: automationItems.length,
    system: systemItems.length + (params.updateSurface ? 1 : 0),
  };
  const custodianItems = params.items.filter((item) => item.action.kind === "askCustodian");
  const custodianSeverity = custodianItems.some((item) => item.severity === "error")
    ? "error"
    : custodianItems.length
      ? "warning"
      : null;
  const updateError = params.context.overlays.snapshot.updateStatusBanner?.tone === "danger";
  const renderApproval = (approval: ExecApprovalRequest) =>
    renderSidebarApprovalItem({
      approval,
      context: params.context,
      onClosePanel: () => params.onClose(false),
      onDecision: params.onApprovalDecision,
    });
  const renderItem = (item: SidebarAttentionItem) =>
    renderSidebarIssueItem(item, {
      basePath: params.context.basePath,
      onDismiss: params.onDismiss,
      onNavigate: params.onNavigate,
      onOpen: params.onOpen,
    });
  const update = () =>
    renderSidebarUpdateSurface({
      context: params.context,
      onDismiss: params.onDismissUpdate,
      onNavigate: () => params.onNavigate("updates"),
      visible: params.updateSurface,
      watchUpdateProgress: params.watchUpdateProgress,
    });

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
        aria-labelledby="sidebar-issues-panel-heading"
        style=${`left:${params.panelPosition.left}px;bottom:${params.panelPosition.bottom}px;--sidebar-issues-panel-bottom:${params.panelPosition.bottom}px`}
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
        </header>
        <wa-tab-group
          class="sidebar-issues-panel__tabs"
          aria-label=${t("attention.tabs.label")}
          .active=${params.selectedTab}
          activation="auto"
          without-scroll-controls
          ${ref((element) => syncTabGroupLabel(element, t("attention.tabs.label")))}
          @wa-tab-show=${(event: CustomEvent<{ name: string }>) => {
            if (isIssueTab(event.detail.name)) {
              params.onSelectTab(event.detail.name);
            }
          }}
        >
          ${ISSUE_TABS.map((tab) => renderTab(tab, tabCounts[tab], tab === params.selectedTab))}
        </wa-tab-group>
        <div class="sidebar-issues-panel__list-wrap">
          <div
            id="sidebar-issues-tabpanel"
            class="sidebar-issues-panel__list"
            role="tabpanel"
            aria-labelledby=${`sidebar-issues-tab-${params.selectedTab}`}
            tabindex="0"
            @scroll=${params.onScroll}
          >
            ${visibleCount === 0
              ? html`<div class="sidebar-issues-panel__empty">
                  <span class="sidebar-issues-panel__empty-icon" aria-hidden="true"
                    >${icons.inbox}</span
                  >
                  <strong>${t("attention.emptyTitle")}</strong>
                  <span>${t("attention.emptyBody")}</span>
                </div>`
              : nothing}
            ${showApprovals ? params.approvalQueue.map(renderApproval) : nothing}
            ${showUpdate && updateError ? update() : nothing} ${errorItems.map(renderItem)}
            ${showUpdate && !updateError ? update() : nothing} ${warningItems.map(renderItem)}
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
