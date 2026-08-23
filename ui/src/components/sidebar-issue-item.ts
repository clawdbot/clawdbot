import { html, nothing } from "lit";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../app/exec-approval.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { t } from "../i18n/index.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { renderSidebarApprovalRow } from "./exec-approval-card.ts";
import { icons } from "./icons.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-items.ts";
import "./sidebar-update-card.ts";

type SidebarIssueItemHandlers = {
  basePath: string;
  onDismiss: (item: SidebarAttentionItem) => void;
  onNavigate: (routeId: NavigationRouteId) => void;
  onOpen: (item: SidebarAttentionItem) => void;
};

export function renderSidebarAskOpenClawButton(params: {
  count: number;
  severity: "error" | "warning" | null;
  snapshot: ApplicationContext["gateway"]["snapshot"] | undefined;
}) {
  if (!canCallGatewayMethod(params.snapshot, "openclaw.chat", "operator.admin")) {
    return nothing;
  }
  const label = params.count
    ? t(params.count === 1 ? "attention.custodianAlertAria" : "attention.custodianAlertsAria", {
        count: String(params.count),
      })
    : t("nav.askOpenClaw");
  return html`<openclaw-tooltip .content=${label}>
    <button
      type="button"
      class="sidebar-brand__icon sidebar-footer-bar__custodian sidebar-issues-panel__ask"
      aria-label=${label}
      @click=${() => window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT))}
    >
      <span class="sidebar-footer-bar__custodian-glyph">
        ${icons.lobster}
        ${params.count
          ? html`<span
              class="session-glyph__badge sidebar-footer-bar__custodian-badge sidebar-footer-bar__custodian-badge--${params.severity ??
              "warning"}"
              aria-hidden="true"
            ></span>`
          : nothing}
      </span>
    </button>
  </openclaw-tooltip>`;
}

export function renderSidebarApprovalItem(params: {
  approval: ExecApprovalRequest;
  context: ApplicationContext | undefined;
  onClosePanel: () => void;
  onDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
}) {
  const context = params.context;
  if (!context) {
    return nothing;
  }
  const snapshot = context.overlays.snapshot;
  const sessionKey = params.approval.request.sessionKey?.trim();
  const session = sessionKey
    ? context.sessions.state.result?.sessions.find((candidate) =>
        areUiSessionKeysEquivalent(candidate.key, sessionKey),
      )
    : undefined;
  const sessionTarget = sessionKey
    ? sessionNavigationTarget({ context, face: "chat", sessionKey })
    : null;
  return renderSidebarApprovalRow({
    approval: params.approval,
    busy: snapshot.approvalBusy,
    canGrant: snapshot.approvalCanGrant,
    error: snapshot.approvalErrors.get(params.approval.id) ?? null,
    openSessionHref: sessionTarget?.href,
    sessionTitle: session?.displayName?.trim() || session?.label?.trim(),
    onDecision: params.onDecision,
    onOpenSession: sessionTarget
      ? (event) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          params.onClosePanel();
          context.navigate("chat", sessionTarget.options);
        }
      : undefined,
  });
}

export function renderSidebarUpdateSurface(params: {
  context: ApplicationContext | undefined;
  onDismiss: () => void;
  onNavigate: () => void;
  visible: boolean;
  watchUpdateProgress: ((listener: (progress: UpdateProgress) => void) => () => void) | undefined;
}) {
  const context = params.context;
  if (!params.visible || !context) {
    return nothing;
  }
  const snapshot = context.overlays.snapshot;
  const gateway = context.gateway.snapshot;
  return html`<openclaw-sidebar-update-card
    class="sidebar-issues-panel__update"
    data-attention-kind="updateAvailable"
    .compact=${true}
    .updateAvailable=${snapshot.updateAvailable}
    .updateSchedule=${snapshot.updateSchedule}
    .heldUpdateCampaignId=${snapshot.heldUpdateCampaignId}
    .updateBusy=${snapshot.updateRunning}
    .statusBanner=${snapshot.updateStatusBanner}
    .watchUpdateProgress=${params.watchUpdateProgress}
    .canUpdate=${canCallGatewayMethod(gateway, "update.run", "operator.admin")}
    .canHoldUpdate=${canCallGatewayMethod(gateway, "update.hold", "operator.admin")}
    .onUpdate=${() => void context.overlays.runUpdate()}
    .refreshRequired=${false}
    .onHoldUpdate=${() => context.overlays.holdUpdate()}
    .onReviewUpdate=${params.onNavigate}
    .onDismiss=${params.onDismiss}
    .recoverNativeDecline=${false}
  ></openclaw-sidebar-update-card>`;
}

function renderItemMeta(item: SidebarAttentionItem) {
  if (!item.meta) {
    return html`<span class="sidebar-issues-panel__state" title=${item.detail}
      >${item.detail}</span
    >`;
  }
  return html`<span class="sidebar-issues-panel__state-row" title=${item.detail}>
    ${item.meta.context
      ? html`<span class="sidebar-issues-panel__meta-context">${item.meta.context}</span>
          <span aria-hidden="true">·</span>`
      : nothing}
    <span class="sidebar-issues-panel__meta-status">${item.meta.status}</span>
    <span aria-hidden="true">·</span>
    <span class="sidebar-issues-panel__meta-time">${item.meta.time}</span>
  </span>`;
}

function renderNavigationItem(item: SidebarAttentionItem, handlers: SidebarIssueItemHandlers) {
  if (item.action.kind !== "navigate") {
    return nothing;
  }
  const routeId = item.action.routeId;
  return html`<div
    class="sidebar-issues-panel__details sidebar-issues-panel__details--${item.severity}"
    data-attention-kind=${item.kind}
  >
    <div class="sidebar-issues-panel__summary sidebar-issues-panel__summary--navigation">
      <a
        class="sidebar-issues-panel__navigation-link"
        href=${pathForRoute(routeId, handlers.basePath)}
        data-issue-row-focus
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          handlers.onNavigate(routeId);
        }}
      >
        <span class="sidebar-issues-panel__icon" aria-hidden="true">${icons[item.icon]}</span>
        <span class="sidebar-issues-panel__content">
          <span class="sidebar-issues-panel__entity" title=${item.label}>${item.label}</span>
          ${renderItemMeta(item)}
        </span>
      </a>
      <button
        type="button"
        class="sidebar-issues-panel__dismiss"
        aria-label=${t("attention.dismissItem", { item: item.label })}
        title=${t("attention.dismissItem", { item: item.label })}
        @click=${() => handlers.onDismiss(item)}
      >
        ${icons.x}
      </button>
      <span class="sidebar-issues-panel__chevron" aria-hidden="true">${icons.chevronRight}</span>
    </div>
  </div>`;
}

export function renderSidebarIssueItem(
  item: SidebarAttentionItem,
  handlers: SidebarIssueItemHandlers,
) {
  if (item.action.kind === "navigate") {
    return renderNavigationItem(item, handlers);
  }
  const facts = item.action.kind === "askCustodian" ? item.action.alert.facts : [];
  const visibleFacts = facts.filter((fact) => fact !== item.label);
  const actionLabel = item.action.kind === "askCustodian" ? t("nav.askOpenClaw") : item.label;
  const inlineAction = item.inlineAction;
  return html`<details
    class="sidebar-issues-panel__details sidebar-issues-panel__details--${item.severity}"
    data-attention-kind=${item.kind}
  >
    <summary class="sidebar-issues-panel__summary" data-issue-row-focus>
      <span
        class="sidebar-issues-panel__icon ${item.kind === "modelAuthExpired"
          ? "sidebar-issues-panel__icon--critical"
          : ""}"
        aria-hidden="true"
        >${icons[item.icon]}</span
      >
      <span class="sidebar-issues-panel__content">
        <span class="sidebar-issues-panel__entity" title=${item.label}>${item.label}</span>
        ${renderItemMeta(item)}
      </span>
      <button
        type="button"
        class="sidebar-issues-panel__dismiss"
        aria-label=${t("attention.dismissItem", { item: item.label })}
        title=${t("attention.dismissItem", { item: item.label })}
        @click=${(event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          handlers.onDismiss(item);
        }}
      >
        ${icons.x}
      </button>
      <span class="sidebar-issues-panel__chevron" aria-hidden="true">${icons.chevronRight}</span>
    </summary>
    <div class="sidebar-issues-panel__body">
      ${visibleFacts.length
        ? html`<ul class="sidebar-issues-panel__facts">
            ${visibleFacts.map((fact) => html`<li>${fact}</li>`)}
          </ul>`
        : nothing}
      <div class="sidebar-issues-panel__actions">
        ${inlineAction
          ? html`<button
              type="button"
              class="sidebar-issues-panel__action sidebar-issues-panel__action--primary"
              @click=${() => handlers.onNavigate(inlineAction.routeId)}
            >
              ${inlineAction.label}
            </button>`
          : nothing}
        <button
          type="button"
          class="sidebar-issues-panel__action ${inlineAction
            ? ""
            : "sidebar-issues-panel__action--primary"}"
          @click=${() => handlers.onOpen(item)}
        >
          ${actionLabel}
        </button>
      </div>
    </div>
  </details>`;
}
