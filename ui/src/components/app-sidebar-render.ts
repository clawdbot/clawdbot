import { html, nothing } from "lit";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  serializeSidebarEntry,
  type NavigationRouteId,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import { isSessionRouteId } from "../app-route-paths.ts";
import { resolveControlUiAuthToken } from "../app/control-ui-auth.ts";
import { isNativeWebChromeHost } from "../app/native-web-chrome.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { deriveAvatarInitial, resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { sessionHasBoard } from "../lib/board/provider.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import { pluginTabKey } from "../pages/plugin/route.ts";
import { renderSidebarPluginTab } from "./app-sidebar-nav-menus.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SidebarWorkboardBoard } from "./app-sidebar-workboard.ts";
import { icons } from "./icons.ts";
import {
  renderSessionAttentionIcon,
  renderSessionRunSpinner,
  sessionAttentionSubtitle,
} from "./session-attention-presentation.ts";
import { renderSessionGlyph, renderSessionUnreadBadge } from "./session-glyph.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";
import { formatSidebarBuildSubtitle } from "./sidebar-build-chip-format.ts";

type AppSidebarRenderHost = AppSidebarSessionNavigationElement & {
  activePluginTabId: string;
  activeWorkboardBoardId: string;
  offline: boolean;
  onOpenApprovals?: () => void;
  getRouteSessionKey(): string;
  renderPinnedSidebarSession(session: SidebarRecentSession): unknown;
};

type SidebarNativeGateway = {
  id: string;
  name: string;
  isPrimary: boolean;
  health: "ok" | "error" | "unknown";
};

type SidebarNativeGatewaysSnapshot = {
  gateways: SidebarNativeGateway[];
  currentId: string;
};

// Display-only: read the injected global directly; the capability module must stay
// chat-chunk-owned to protect the QA smoke startup budget.
function readSidebarNativeGateway(): SidebarNativeGateway | null {
  if (!isNativeWebChromeHost()) {
    return null;
  }
  const snapshot = (
    window as Window & { __OPENCLAW_NATIVE_GATEWAYS__?: SidebarNativeGatewaysSnapshot }
  )["__OPENCLAW_NATIVE_GATEWAYS__"];
  if (!snapshot || !Array.isArray(snapshot.gateways) || snapshot.gateways.length < 2) {
    return null;
  }
  return snapshot.gateways.find((gateway) => gateway.id === snapshot.currentId) ?? null;
}

export function renderAppSidebarBrand(host: AppSidebarRenderHost) {
  const {
    activeId: cardAgentId,
    agent: cardAgent,
    agents: cardAgents,
    identity: cardIdentity,
  } = host.activeChipAgent();
  const menuUnread = cardAgents.some((entry) => {
    const agentId = normalizeAgentId(entry.id);
    return agentId !== cardAgentId && host.agentUnreadCount(agentId) > 0;
  });
  const cardName = normalizeAgentLabel(cardAgent ?? { id: cardAgentId }, cardIdentity);
  const approvalCount = host.sessionData.approvalBadgeSnapshot().agentCounts.get(cardAgentId) ?? 0;
  const gateway = host.sessionDataContext?.gateway;
  const avatarAuthToken = gateway
    ? resolveControlUiAuthToken({
        hello: gateway.snapshot.hello,
        settings: { token: gateway.connection.token },
        password: gateway.connection.password,
      })
    : null;
  const avatarAuthReady = Boolean(
    gateway &&
    (gateway.snapshot.hello ||
      gateway.connection.token.trim() ||
      gateway.connection.password.trim()),
  );
  const cardAvatarText =
    (cardAgent ? resolveAgentTextAvatar(cardAgent, cardIdentity) : cardIdentity?.emoji) ??
    (deriveAvatarInitial(cardName || cardAgentId) || "?");
  const newSessionAccess = host.readNewSessionAccess();
  // The sidebar action follows gateway availability; collapsed native chrome
  // keeps its separate offline-tolerant ⌘N mirror.
  return html`
    <div class="sidebar-brand">
      <openclaw-sidebar-agent-card
        .agentName=${cardName}
        .avatarUrl=${cardAgent
          ? resolveAgentAvatarUrl(cardAgent, cardIdentity)
          : cardIdentity?.avatar}
        .authToken=${avatarAuthToken}
        .avatarAuthReady=${avatarAuthReady}
        .avatarText=${cardAvatarText}
        .subtitle=${host.agentChipSubtitle(cardAgentId)}
        .menuOpen=${host.sidebarMenus.agentMenuPosition !== null}
        .menuUnread=${menuUnread}
        .approvalCount=${approvalCount}
        .switcherAvailable=${cardAgents.length > 1}
        .onToggleMenu=${(trigger: HTMLElement) => host.sidebarMenus.toggleAgentMenu(trigger)}
        @contextmenu=${(event: MouseEvent) => {
          event.preventDefault();
          if (host.sidebarMenus.agentMenuPosition !== null) {
            return;
          }
          const card = event.currentTarget as HTMLElement;
          const trigger = card.querySelector<HTMLElement>(".sidebar-agent-card__main") ?? card;
          host.sidebarMenus.toggleAgentMenu(trigger);
        }}
      ></openclaw-sidebar-agent-card>
      <div class="sidebar-brand__actions">
        <openclaw-tooltip
          .content=${newSessionAccess.allowed
            ? t("chat.runControls.newSession")
            : newSessionAccess.reason}
        >
          <button
            class="sidebar-brand__icon sidebar-brand__new-thread"
            type="button"
            @click=${() => host.requestOpenNewSession(host.expandedAgentId())}
            aria-label=${t("chat.runControls.newSession")}
            ?disabled=${!newSessionAccess.allowed}
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
  const attention = host.resolveHomeSessionAttention(mainKey, mainRow);
  const attentionLabel = sessionAttentionSubtitle(attention);
  const outboxCount = host.outboxCountForSession(mainKey);
  const active =
    isSessionRouteId(host.activeRouteId) &&
    areUiSessionKeysEquivalent(host.getRouteSessionKey(), mainKey);
  const hasComposerDraft = !active && host.hasSessionDraft(mainKey);
  const running = mainRow?.hasActiveRun === true;
  const unread = mainRow?.unread === true && !active;
  // Home keeps its page/attention glyph leading and shares trailing activity with session rows.
  const homeGlyph = renderSessionGlyph({
    content:
      attention.kind === "none"
        ? html`<span class="nav-item__icon" aria-hidden="true">${icons.home}</span>`
        : renderSessionAttentionIcon(attention),
    running: false,
    badge: unread ? renderSessionUnreadBadge() : nothing,
  });
  return html`
    <a
      href=${sessionNavigationTarget({
        face: resolveSessionPreferredFace(mainRow),
        sessionKey: mainKey,
        fallbackAgentId: agentId,
        basePath: host.basePath,
        row: mainRow ?? undefined,
        mainKey: parseAgentSessionKey(mainKey)?.rest,
        preferenceDerivedFace: true,
      }).href}
      class="nav-item nav-item--home ${active ? "nav-item--active" : ""}"
      aria-label=${attentionLabel ? `${t("nav.home")} · ${attentionLabel}` : nothing}
      aria-current=${active ? "page" : nothing}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        host.openMainSession(agentId);
      }}
    >
      ${attentionLabel
        ? html`<openclaw-tooltip .content=${attentionLabel}>${homeGlyph}</openclaw-tooltip>`
        : homeGlyph}
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
      ${running || outboxCount > 0 || hasComposerDraft
        ? html`<span class="nav-item__state sidebar-home-session-states">
            ${running ? renderSessionRunSpinner() : nothing}
            ${renderSessionRowBadges({ hasAutomation: false, outboxCount, hasComposerDraft })}
          </span>`
        : nothing}
    </a>
  `;
}

export function renderAppSidebarPagesHead(host: AppSidebarRenderHost) {
  return html`
    <div class="sidebar-nav__head">
      <span class="sidebar-recent-sessions__label-text sr-only">${t("nav.pages")}</span>
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
  const gateway = host.offline ? null : readSidebarNativeGateway();
  const buildSubtitle = formatSidebarBuildSubtitle(CONTROL_UI_BUILD_INFO);
  // Health is visual-only here by budget decision; the header picker owns health accessibility.
  const gatewayPrimaryTag = gateway?.isPrimary
    ? t("chat.sessionHeader.gatewayPicker.primaryTag")
    : null;
  const identityMenuLabel = t("profilePage.identity.menuButtonLabel", { name: selfLabel });
  const identityDetail = host.offline
    ? t("connection.reconnecting")
    : gateway
      ? `${gateway.name}${gatewayPrimaryTag ? `, ${gatewayPrimaryTag}` : ""}`
      : buildSubtitle;
  return html`
    <div class="sidebar-footer-bar">
      <openclaw-tooltip .content=${selfLabel}>
        <button
          type="button"
          class="sidebar-identity-card"
          aria-haspopup="menu"
          aria-expanded=${String(host.sidebarMenus.identityMenuPosition !== null)}
          aria-label=${identityDetail
            ? `${identityMenuLabel}: ${identityDetail}`
            : identityMenuLabel}
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
              : gateway
                ? html`<span
                    class="sidebar-identity-card__subtitle sidebar-identity-card__subtitle--gateway"
                    aria-hidden="true"
                  >
                    <span
                      class="sidebar-identity-card__gateway-health"
                      data-health=${gateway.health}
                    ></span>
                    <span class="sidebar-identity-card__gateway-name">${gateway.name}</span>
                    ${gatewayPrimaryTag
                      ? html`<span class="sidebar-identity-card__gateway-primary"
                          >· ${gatewayPrimaryTag}</span
                        >`
                      : nothing}
                  </span>`
                : buildSubtitle
                  ? html`<span class="sidebar-identity-card__subtitle" aria-hidden="true"
                      >${buildSubtitle}</span
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
