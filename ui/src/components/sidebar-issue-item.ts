import { html, nothing } from "lit";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { ScopeUpgradeState } from "../app/device-scope-upgrade-availability.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../app/exec-approval.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { t } from "../i18n/index.ts";
import { formatDateTimeMs, formatRelativeTimestamp } from "../lib/format.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { PresenceViewer } from "../lib/presence-users.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { renderSidebarApprovalRow } from "./exec-approval-card.ts";
import { icons } from "./icons.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";
import "./sidebar-update-card.ts";
import "./viewer-facepile.ts";

type SidebarIssueItemHandlers = {
  basePath: string;
  onDismiss?: () => void;
  onNavigate: (routeId: NavigationRouteId) => void;
  onOpen: (item: SidebarAttentionItem) => void;
};

function renderSidebarDismissButton(itemLabel: string, onDismiss?: () => void) {
  if (!onDismiss) {
    return nothing;
  }
  const label = t("attention.dismissItem", { item: itemLabel });
  return html`<button
    type="button"
    class="sidebar-issues-panel__dismiss"
    aria-label=${label}
    title=${label}
    @click=${(event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    }}
  >
    ${icons.x}
  </button>`;
}

export function renderSidebarMentionItem(params: {
  mention: MentionInboxItem;
  context: Pick<ApplicationContext, "basePath" | "navigate">;
  dismissing: boolean;
  onDismiss: () => void;
  onClosePanel: () => void;
}) {
  const { mention, context } = params;
  const sender: PresenceViewer = {
    id: mention.senderProfileId,
    identity: { type: "profile", id: mention.senderProfileId },
    name: mention.senderLabel,
    avatarUrl: mention.senderAvatarUrl,
    watchedSessions: [],
  };
  const label = t("attention.mentions.from", { sender: mention.senderLabel });
  const target = sessionNavigationTarget({
    face: "chat",
    sessionKey: mention.sessionKey,
    fallbackAgentId: mention.agentId,
    basePath: context.basePath,
    row: { key: mention.sessionKey, displayName: mention.sessionTitle },
    exactKey: true,
  });
  return html`<article
    class="sidebar-mention-row"
    data-attention-kind="mention"
    data-mention-id=${mention.id}
    aria-label=${label}
  >
    <div class="sidebar-issues-panel__summary sidebar-mention-row__summary">
      <span class="sidebar-mention-row__avatar" aria-hidden="true">
        <openclaw-viewer-avatar
          .user=${sender}
          .markAsViewer=${false}
          variant="footer"
        ></openclaw-viewer-avatar>
      </span>
      <div class="sidebar-issues-panel__content">
        <div class="sidebar-mention-row__header">
          <span class="sidebar-issues-panel__entity" title=${label}>${label}</span>
          <time
            class="sidebar-mention-row__age"
            datetime=${new Date(mention.createdAt).toISOString()}
            title=${formatDateTimeMs(mention.createdAt)}
            >${formatRelativeTimestamp(mention.createdAt)}</time
          >
        </div>
        <span class="sidebar-issues-panel__state" title=${mention.sessionTitle}
          >${mention.sessionTitle}</span
        >
        ${mention.excerpt
          ? html`<p class="sidebar-mention-row__excerpt">${mention.excerpt}</p>`
          : nothing}
        <div class="sidebar-issues-panel__actions sidebar-mention-row__actions">
          <a
            class="sidebar-issues-panel__action sidebar-issues-panel__action--primary"
            href=${target.href}
            data-issue-row-focus
            @click=${(event: MouseEvent) => {
              if (!shouldHandleNavigationClick(event)) {
                return;
              }
              event.preventDefault();
              params.onClosePanel();
              context.navigate("chat", target.options);
            }}
            >${t("attention.mentions.open")}</a
          >
          <button
            type="button"
            class="sidebar-issues-panel__action"
            ?disabled=${params.dismissing}
            @click=${params.onDismiss}
          >
            ${t(params.dismissing ? "attention.mentions.dismissing" : "attention.mentions.dismiss")}
          </button>
        </div>
      </div>
    </div>
  </article>`;
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
  onDismiss?: () => void;
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
    .updateBusy=${snapshot.updateRunning || snapshot.updateReconciliationPending}
    .statusBanner=${snapshot.updateStatusBanner}
    .watchUpdateProgress=${params.watchUpdateProgress}
    .canUpdate=${canCallGatewayMethod(gateway, "update.run", "operator.admin")}
    .canHoldUpdate=${canCallGatewayMethod(gateway, "update.hold", "operator.admin")}
    .onUpdate=${() => void context.overlays.runUpdate()}
    .refreshRequired=${false}
    .onHoldUpdate=${() => context.overlays.holdUpdate()}
    .onReviewUpdate=${params.onNavigate}
    .onDismiss=${params.onDismiss}
  ></openclaw-sidebar-update-card>`;
}

function scopeUpgradeText(state: Exclude<ScopeUpgradeState, { phase: "hidden" }>): string {
  switch (state.phase) {
    case "guidance":
      return t("connection.scopeUpgrade.guidance");
    case "available":
      return t("connection.scopeUpgrade.limited");
    case "requesting":
      return t("connection.scopeUpgrade.requesting");
    case "pending":
      return t("connection.scopeUpgrade.pending");
    case "rejected":
      return t(
        state.expired ? "connection.scopeUpgrade.expired" : "connection.scopeUpgrade.rejected",
      );
    case "error":
      return t("connection.scopeUpgrade.error", { error: state.message });
  }
  return state satisfies never;
}

export function renderSidebarScopeUpgradeItem(params: {
  state: ScopeUpgradeState;
  onCancel: () => void;
  onDismiss?: () => void;
  onRequest: () => void;
  onRetry: () => void;
}) {
  if (params.state.phase === "hidden") {
    return nothing;
  }
  const text = scopeUpgradeText(params.state);
  const summary = t("connection.scopeUpgrade.inboxState");
  const retryable =
    params.state.phase === "error"
      ? params.state.retryable
      : params.state.phase === "pending" || params.state.phase === "rejected";
  return html`<details
    class="sidebar-issues-panel__details sidebar-issues-panel__details--${
      params.state.phase === "error" || params.state.phase === "rejected" ? "error" : "warning"
    }"
    data-attention-kind="scopeUpgrade"
  >
    <summary class="sidebar-issues-panel__summary" data-issue-row-focus>
      <span class="sidebar-issues-panel__icon" aria-hidden="true">${icons.shieldQuestion}</span>
      <span class="sidebar-issues-panel__content">
        <span class="sidebar-issues-panel__entity">${t("connection.scopeUpgrade.status")}</span>
        <span class="sidebar-issues-panel__state" title=${summary}>${summary}</span>
      </span>
      ${
        params.onDismiss
          ? renderSidebarDismissButton(t("connection.scopeUpgrade.status"), params.onDismiss)
          : nothing
      }
      <span class="sidebar-issues-panel__chevron" aria-hidden="true">${icons.chevronRight}</span>
    </summary>
    <div class="sidebar-issues-panel__body" role="status" aria-live="polite">
      <div>${text}</div>
      ${
        params.state.phase === "available"
          ? html`<div class="sidebar-issues-panel__actions">
              <button
                type="button"
                class="sidebar-issues-panel__action sidebar-issues-panel__action--primary"
                @click=${params.onRequest}
              >
                ${t("connection.scopeUpgrade.request")}
              </button>
            </div>`
          : params.state.phase === "requesting"
            ? html`<div class="sidebar-issues-panel__actions">
                <button
                  type="button"
                  class="sidebar-issues-panel__action sidebar-issues-panel__action--primary"
                  disabled
                >
                  ${t("connection.scopeUpgrade.requestingAction")}
                </button>
              </div>`
            : retryable || params.state.phase === "error"
              ? html`<div class="sidebar-issues-panel__actions">
                  ${
                    retryable
                      ? html`<button
                          type="button"
                          class="sidebar-issues-panel__action sidebar-issues-panel__action--primary"
                          @click=${params.onRetry}
                        >
                          ${t("connection.scopeUpgrade.retry")}
                        </button>`
                      : nothing
                  }
                  <button
                    type="button"
                    class="sidebar-issues-panel__action"
                    @click=${params.onCancel}
                  >
                    ${t("connection.scopeUpgrade.cancel")}
                  </button>
                </div>`
              : nothing
      }
    </div>
  </details>`;
}

function renderItemMeta(item: SidebarAttentionItem) {
  if (!item.meta) {
    return html`<span class="sidebar-issues-panel__state" title=${item.detail}
      >${item.detail}</span
    >`;
  }
  return html`<span class="sidebar-issues-panel__state-row" title=${item.detail}>
    ${
      item.meta.context
        ? html`<span class="sidebar-issues-panel__meta-context">${item.meta.context}</span>
            <span aria-hidden="true">·</span>`
        : nothing
    }
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
      ${renderSidebarDismissButton(item.label, handlers.onDismiss)}
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
        class="sidebar-issues-panel__icon ${
          item.kind === "modelAuthExpired" ? "sidebar-issues-panel__icon--critical" : ""
        }"
        aria-hidden="true"
        >${icons[item.icon]}</span
      >
      <span class="sidebar-issues-panel__content">
        <span class="sidebar-issues-panel__entity" title=${item.label}>${item.label}</span>
        ${renderItemMeta(item)}
      </span>
      ${renderSidebarDismissButton(item.label, handlers.onDismiss)}
      <span class="sidebar-issues-panel__chevron" aria-hidden="true">${icons.chevronRight}</span>
    </summary>
    <div class="sidebar-issues-panel__body">
      ${
        visibleFacts.length
          ? html`<ul class="sidebar-issues-panel__facts">
              ${visibleFacts.map((fact) => html`<li>${fact}</li>`)}
            </ul>`
          : nothing
      }
      <div class="sidebar-issues-panel__actions">
        ${
          inlineAction
            ? html`<button
                type="button"
                class="sidebar-issues-panel__action sidebar-issues-panel__action--primary"
                @click=${() => handlers.onNavigate(inlineAction.routeId)}
              >
                ${inlineAction.label}
              </button>`
            : nothing
        }
        <button
          type="button"
          class="sidebar-issues-panel__action ${
            inlineAction ? "" : "sidebar-issues-panel__action--primary"
          }"
          @click=${() => handlers.onOpen(item)}
        >
          ${actionLabel}
        </button>
      </div>
    </div>
  </details>`;
}
