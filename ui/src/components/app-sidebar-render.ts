import { html, nothing } from "lit";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  serializeSidebarEntry,
  type NavigationRouteId,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { sessionHasPendingApproval } from "../app/approval-presentation.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { sessionHasBoard } from "../lib/board/provider.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent, normalizeAgentId } from "../lib/sessions/session-key.ts";
import { pluginTabKey } from "../pages/plugin/route.ts";
import { renderSidebarPluginTab, shouldHandleNavigationClick } from "./app-sidebar-nav-menus.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SidebarWorkboardBoard } from "./app-sidebar-workboard.ts";
import { icons } from "./icons.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";

type AppSidebarRenderHost = AppSidebarSessionNavigationElement & {
  activePluginTabId: string;
  activeWorkboardBoardId: string;
  offline: boolean;
  onOpenApprovals?: () => void;
  getRouteSessionKey(): string;
  renderPinnedSidebarSession(session: SidebarRecentSession): unknown;
};

export function renderAppSidebarBrand(host: AppSidebarRenderHost) {
  const { activeId: cardAgentId, agent: cardAgent, agents: cardAgents } = host.activeChipAgent();
  const menuUnread = cardAgents.some((entry) => {
    const agentId = normalizeAgentId(entry.id);
    return agentId !== cardAgentId && host.agentUnreadCount(agentId) > 0;
  });
  const cardName = cardAgent ? normalizeAgentLabel(cardAgent) : cardAgentId;
  const approvalCount = host.sessionData.approvalBadgeSnapshot().agentCounts.get(cardAgentId) ?? 0;
  const cardAvatarText =
    (cardAgent ? resolveAgentTextAvatar(cardAgent) : null) ??
    (cardName || cardAgentId).slice(0, 1).toUpperCase();
  // The sidebar action follows gateway availability; collapsed native chrome
  // keeps its separate offline-tolerant ⌘N mirror.
  return html`
    <div class="sidebar-brand">
      <openclaw-sidebar-agent-card
        .agentName=${cardName}
        .avatarUrl=${cardAgent ? resolveAgentAvatarUrl(cardAgent) : null}
        .avatarText=${cardAvatarText}
        .subtitle=${host.agentChipSubtitle(cardAgentId)}
        .menuOpen=${host.sidebarMenus.agentMenuPosition !== null}
        .menuUnread=${menuUnread}
        .approvalCount=${approvalCount}
        .switcherAvailable=${cardAgents.length > 1}
        .onToggleMenu=${(trigger: HTMLElement) => host.sidebarMenus.toggleAgentMenu(trigger)}
      ></openclaw-sidebar-agent-card>
      <div class="sidebar-brand__actions">
        <openclaw-tooltip
          .content=${host.connected
            ? t("chat.runControls.newSession")
            : t("chat.runControls.newSessionDisconnected")}
        >
          <button
            class="sidebar-brand__icon sidebar-brand__new-thread"
            type="button"
            @click=${() => host.onOpenNewSession?.(host.expandedAgentId())}
            aria-label=${t("chat.runControls.newSession")}
            ?disabled=${!host.connected}
          >
            ${icons.plus}
          </button>
        </openclaw-tooltip>
      </div>
    </div>
  `;
}

/** Home: the first page. Opens the rolling main session on its saved face. */
export function renderAppSidebarHomeRow(host: AppSidebarRenderHost) {
  const agentId = host.activeChipAgent().activeId;
  const mainKey = host.selectedAgentMainSessionKey(agentId);
  const mainRow = host.mainSessionRow(agentId);
  const approvalNeeded = sessionHasPendingApproval(
    host.sessionData.approvalBadgeSnapshot(),
    mainKey,
  );
  const outboxCount = host.outboxCountForSessionKey(mainKey);
  const active =
    host.activeRouteId === "chat" && areUiSessionKeysEquivalent(host.getRouteSessionKey(), mainKey);
  const stateBadge = mainRow?.hasActiveRun
    ? html`<openclaw-tooltip .content=${t("sessionsView.activeRun")}>
        <span
          class="session-run-spinner"
          role="img"
          aria-label=${t("sessionsView.activeRun")}
        ></span>
      </openclaw-tooltip>`
    : mainRow?.unread === true && !active
      ? html`<span
          class="session-unread-dot"
          role="img"
          aria-label=${t("sessionsView.unread")}
        ></span>`
      : nothing;
  return html`
    <a
      href=${`${pathForRoute("chat", host.basePath)}${searchForSession(mainKey)}`}
      class="nav-item nav-item--home ${active ? "nav-item--active" : ""}"
      aria-current=${active ? "page" : nothing}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        host.openMainSession(agentId);
      }}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons.home}</span>
      <span class="nav-item__text">${t("nav.home")}</span>
      ${sessionHasBoard(mainKey)
        ? html`<openclaw-tooltip .content=${t("sessionsView.dashboardAvailable")}>
            <span
              class="sidebar-board-glyph"
              role="img"
              aria-label=${t("sessionsView.dashboardAvailable")}
              >${icons.layoutDashboard}</span
            >
          </openclaw-tooltip>`
        : nothing}
      ${stateBadge !== nothing || approvalNeeded || outboxCount > 0
        ? html`<span class="nav-item__state sidebar-home-session-states">
            ${stateBadge}
            ${approvalNeeded
              ? html`<openclaw-tooltip .content=${t("sessionsView.approvalNeeded")}>
                  <span
                    class="session-approval-badge"
                    role="img"
                    aria-label=${t("sessionsView.approvalNeeded")}
                    >${icons.alertTriangle}</span
                  >
                </openclaw-tooltip>`
              : nothing}
            ${renderSessionRowBadges({ hasAutomation: false, outboxCount })}
          </span>`
        : nothing}
    </a>
  `;
}

export function renderAppSidebarPagesHead(host: AppSidebarRenderHost) {
  return html`
    <div class="sidebar-nav__head">
      <span class="sidebar-recent-sessions__label-text">${t("nav.pages")}</span>
      <button
        type="button"
        class="sidebar-nav__head-action"
        aria-haspopup="menu"
        aria-expanded=${String(host.sidebarMenus.moreMenuPosition !== null)}
        aria-label=${t("nav.customize")}
        @click=${(event: MouseEvent) =>
          host.sidebarMenus.toggleMoreMenu(event.currentTarget as HTMLElement)}
      >
        ${icons.penLine}
      </button>
    </div>
  `;
}

/** Zone 5: product chrome recedes to one slim footer bar. */
export function renderAppSidebarFooterBar(host: AppSidebarRenderHost) {
  const selfUser = resolveCurrentSelfUser({
    snapshotUser: host.sessionDataContext?.gateway.snapshot.selfUser,
    presenceEntries: readPresenceEntries(host.sessionData.presencePayload),
    presenceInstanceId: host.sessionData.presenceInstanceId,
  });
  const selfLabel = selfUser?.name ?? selfUser?.email ?? t("nav.account");
  const avatarUser = {
    ...(selfUser ?? { id: "account", name: selfLabel }),
    watchedSessions: [],
  };
  return html`
    <div class="sidebar-footer-bar">
      <openclaw-tooltip .content=${selfLabel}>
        <button
          type="button"
          class="sidebar-identity-card"
          aria-haspopup="menu"
          aria-expanded=${String(host.sidebarMenus.identityMenuPosition !== null)}
          aria-label=${t("profilePage.identity.menuButtonLabel", { name: selfLabel })}
          @click=${(event: MouseEvent) =>
            host.sidebarMenus.toggleIdentityMenu(event.currentTarget as HTMLElement)}
        >
          <openclaw-viewer-avatar .user=${avatarUser} variant="footer"></openclaw-viewer-avatar>
          <span class="sidebar-identity-card__text">
            <span class="sidebar-identity-card__name">${selfLabel}</span>
            ${host.offline
              ? html`<span class="sidebar-identity-card__subtitle" aria-hidden="true"
                  >${t("connection.reconnecting")}</span
                >`
              : nothing}
          </span>
          <span class="sidebar-identity-card__chevron" aria-hidden="true"
            >${icons.chevronDown}</span
          >
        </button>
      </openclaw-tooltip>
      <span class="sidebar-identity-card__status" role="status" aria-live="polite"
        >${host.offline ? t("connection.reconnecting") : ""}</span
      >
    </div>
  `;
}

export function renderAppSidebarZoneEntry(
  host: AppSidebarRenderHost,
  entry: SidebarZoneEntry,
  sessionRows: ReadonlyMap<string, SidebarRecentSession>,
  workboardRows: ReadonlyMap<string, SidebarWorkboardBoard>,
) {
  if (
    (entry.type === "route" && !host.sidebarMenus.isRouteEnabled(entry.route)) ||
    (entry.type === "workboard" && !host.sidebarMenus.isRouteEnabled("workboard"))
  ) {
    return nothing;
  }
  const serialized = serializeSidebarEntry(entry);
  const dropPosition =
    host.sessionOrganizer.sidebarZoneDropTarget?.entry === serialized
      ? host.sessionOrganizer.sidebarZoneDropTarget.position
      : null;
  const content =
    entry.type === "route"
      ? host.sidebarMenus.renderRoute(entry.route)
      : entry.type === "workboard"
        ? renderWorkboardBoard(host, workboardRows.get(entry.boardId))
        : sessionRows.has(entry.key)
          ? host.renderPinnedSidebarSession(sessionRows.get(entry.key)!)
          : nothing;
  const draggable = entry.type === "route" || entry.type === "workboard";
  return html`
    <div
      class="sidebar-zone-entry ${dropPosition
        ? `sidebar-zone-entry--drop-${dropPosition}`
        : ""} ${host.sessionOrganizer.draggingSidebarEntry === serialized
        ? "sidebar-zone-entry--dragging"
        : ""}"
      data-sidebar-entry=${serialized}
      draggable=${draggable ? "true" : "false"}
      @dragstart=${entry.type === "route"
        ? (event: DragEvent) => host.sessionOrganizer.startSidebarRouteDrag(event, entry.route)
        : entry.type === "workboard"
          ? (event: DragEvent) =>
              host.sessionOrganizer.startSidebarWorkboardDrag(event, entry.boardId)
          : nothing}
      @dragend=${draggable ? () => host.sessionOrganizer.finishSidebarEntryDrag() : nothing}
      @dragover=${(event: DragEvent) =>
        host.sessionOrganizer.handleSidebarZoneDragOver(event, serialized)}
      @drop=${(event: DragEvent) => host.sessionOrganizer.handleSidebarZoneDrop(event, serialized)}
    >
      ${content}
    </div>
  `;
}

export function renderAppSidebarPluginTabEntry(
  host: AppSidebarRenderHost,
  tab: GatewayControlUiPluginTab,
) {
  const ref = { pluginId: tab.pluginId, id: tab.id };
  const key = pluginTabKey(ref);
  return html`
    <div class="sidebar-zone-entry" data-sidebar-entry=${`plugin:${key}`}>
      ${renderSidebarPluginTab({
        tab,
        basePath: host.basePath,
        active: host.activeRouteId === "plugin" && host.activePluginTabId === key,
        onNavigate: (search) => host.onNavigate?.("plugin", { search }),
      })}
    </div>
  `;
}

function renderWorkboardBoard(
  host: AppSidebarRenderHost,
  board: SidebarWorkboardBoard | undefined,
) {
  if (!board) {
    return nothing;
  }
  const active = host.activeRouteId === "workboard" && host.activeWorkboardBoardId === board.id;
  return (
    host.workboardRenderers?.renderEntry({
      board,
      basePath: host.basePath,
      active,
      onNavigate: (pathname) => host.onNavigate?.("workboard", { pathname }),
    }) ?? nothing
  );
}

export function renderAppSidebarAttention(host: AppSidebarRenderHost) {
  return html`<openclaw-sidebar-attention
    .onNavigate=${(routeId: NavigationRouteId) => host.onNavigate?.(routeId)}
    .onOpenApprovals=${() => host.onOpenApprovals?.()}
  ></openclaw-sidebar-attention>`;
}
