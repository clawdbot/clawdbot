import { html, nothing, type ReactiveControllerHost } from "lit";
import { keyed } from "lit/directives/keyed.js";
import {
  DEFAULT_SIDEBAR_ENTRIES,
  serializeSidebarEntry,
  type NavigationRouteId,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import type { ThemeMode } from "../app/theme.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { openEditor } from "../lib/editor-links.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import {
  canArchiveSessionRow,
  normalizeAgentId,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { renderSidebarAgentMenu, renderSidebarIdentityMenu } from "./app-sidebar-agent-menu.ts";
import { renderSidebarCustomizeMenu, renderSidebarMoreMenu } from "./app-sidebar-nav-menus.ts";
import {
  renderSidebarSessionGroupMenu,
  renderSidebarSessionSortMenu,
} from "./app-sidebar-session-menu-renderers.ts";
import type {
  SidebarRecentSession,
  SidebarSessionGroupMenuState,
  SidebarSessionMenuState,
  SidebarSessionSortMode,
} from "./app-sidebar-session-types.ts";
import type { SidebarWorkboardBoard, SidebarWorkboardRenderers } from "./app-sidebar-workboard.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import type { SessionMenuAction, SessionMenuWork } from "./session-menu.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-operations.runtime.ts";
import type { SessionCreatorOption } from "./session-owner-chip.ts";

type SidebarMenuAgent = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string; avatar?: string; avatarUrl?: string };
};

interface SidebarMenusRenderHost extends ReactiveControllerHost, SessionOrganizerControllerHost {
  readonly activeRouteId?: NavigationRouteId;
  readonly activeWorkboardBoardId: string;
  readonly basePath: string;
  readonly canPairDevice: boolean;
  readonly connected: boolean;
  readonly offline: boolean;
  readonly gatewayVersion: string | null;
  readonly onNavigate?: (
    routeId: NavigationRouteId,
    options?: ApplicationNavigationOptions,
  ) => void;
  readonly onPairMobile?: () => void;
  readonly onRetryConnect?: () => void;
  readonly pinnedAgentIds: readonly string[];
  readonly sessionData: SessionOrganizerControllerHost["sessionData"] &
    Pick<
      SessionDataController,
      "approvalBadgeSnapshot" | "presenceInstanceId" | "presencePayload" | "sessionsLoading"
    >;
  readonly sessionDataContext: ApplicationContext<RouteId> | undefined;
  readonly sessionOrganizer: SessionOrganizerController;
  readonly sessionCreatorFilterActive: boolean;
  sessionCreatorFilterId: string | null;
  readonly sessionCreatorOptions: readonly SessionCreatorOption[];
  readonly sessionOwnershipVisible: boolean;
  readonly sidebarEntries: readonly string[];
  sessionSortMode: SidebarSessionSortMode;
  readonly themeMode: ThemeMode;
  readonly workboardBoards: readonly SidebarWorkboardBoard[];
  readonly workboardRenderers?: SidebarWorkboardRenderers;
  activeChipAgent(): {
    activeId: string;
    agent: SidebarMenuAgent | undefined;
    agents: readonly SidebarMenuAgent[];
  };
  agentUnreadCount(agentId: string): number;
  askAgentCapabilities(agentId: string): void;
  onUpdateSidebarEntries?(entries: readonly string[]): void;
  reconciledSidebarZone(): {
    entries: readonly SidebarZoneEntry[];
    sidebarEntries: readonly string[];
  };
  selectedVisibleSessions(): SidebarRecentSession[];
  switchChipAgent(agentId: string): void;
}

interface SidebarMenusRenderController {
  readonly host: SidebarMenusRenderHost;
  readonly agentMenuFilter: string;
  readonly agentMenuPosition: { x: number; bottom: number } | null;
  readonly agentMenuTrigger: HTMLElement | null;
  readonly customizeMenuPosition: { x: number; y: number } | null;
  readonly customizeMenuTrigger: HTMLElement | null;
  readonly identityMenuPosition: { x: number; bottom: number; width: number } | null;
  readonly identityMenuTrigger: HTMLElement | null;
  readonly moreMenuPosition: { x: number; y: number } | null;
  readonly moreMenuTrigger: HTMLElement | null;
  readonly sessionGroupMenu: SidebarSessionGroupMenuState | null;
  readonly sessionGroupMenuTrigger: HTMLElement | null;
  readonly sessionMenu: SidebarSessionMenuState | null;
  readonly sessionMenuTrigger: HTMLElement | null;
  readonly sessionMenuWork: SessionMenuWork | null;
  readonly sessionSortMenuPosition: { x: number; y: number } | null;
  readonly sessionSortMenuTrigger: HTMLElement | null;
  cancelPreload(event: Event): void;
  closeAgentMenu(options?: { restoreFocus?: boolean }): void;
  closeCustomizeMenu(options?: { restoreFocus?: boolean }): void;
  closeIdentityMenu(options?: { restoreFocus?: boolean }): void;
  closeMoreMenu(options?: { restoreFocus?: boolean }): void;
  closeSessionGroupMenu(options?: { restoreFocus?: boolean }): void;
  closeSessionMenu(): void;
  closeSessionSortMenu(options?: { restoreFocus?: boolean }): void;
  isRouteEnabled(routeId: NavigationRouteId): boolean;
  openCustomizeMenu(x: number, y: number, trigger?: HTMLElement | null): void;
  preloadRoute(routeId: NavigationRouteId, event: Event, immediate?: boolean): void;
  setAgentMenuFilter(next: string): void;
}

export function renderSidebarCustomizeMenuForController(controller: SidebarMenusRenderController) {
  const { host } = controller;
  const position = controller.customizeMenuPosition;
  const trigger = controller.customizeMenuTrigger;
  return renderSidebarCustomizeMenu({
    position,
    sidebarEntries: host.sidebarEntries,
    isRouteEnabled: (routeId) => controller.isRouteEnabled(routeId),
    workboardBoards: host.workboardBoards,
    workboardRenderers: host.workboardRenderers,
    onTabAway: () => trigger?.focus(),
    onClose: (restoreFocus) => {
      if (controller.customizeMenuPosition !== position) {
        return;
      }
      controller.closeCustomizeMenu({ restoreFocus });
    },
    onToggleRoute: (routeId) => {
      const entry = serializeSidebarEntry({ type: "route", route: routeId });
      const canonical = host.reconciledSidebarZone().sidebarEntries;
      const next = canonical.includes(entry)
        ? canonical.filter((candidate) => candidate !== entry)
        : [...canonical, entry];
      host.onUpdateSidebarEntries?.(next);
    },
    onToggleWorkboardBoard: (boardId) => {
      const entry = serializeSidebarEntry({ type: "workboard", boardId });
      const canonical = host.reconciledSidebarZone().sidebarEntries;
      const next = canonical.includes(entry)
        ? canonical.filter((candidate) => candidate !== entry)
        : [...canonical, entry];
      host.onUpdateSidebarEntries?.(next);
    },
    onReset: () => {
      // Canonical list, not the render list: unknown-state session slots
      // (other agents, still-loading caches) must survive a route reset.
      const sessions = host
        .reconciledSidebarZone()
        .sidebarEntries.filter((entry) => entry.startsWith("session:"));
      host.onUpdateSidebarEntries?.([...DEFAULT_SIDEBAR_ENTRIES, ...sessions]);
      controller.closeCustomizeMenu({ restoreFocus: true });
    },
  });
}

export function renderSidebarAgentMenuForController(controller: SidebarMenusRenderController) {
  const { host } = controller;
  const position = controller.agentMenuPosition;
  const trigger = controller.agentMenuTrigger;
  const { activeId, agent, agents } = host.activeChipAgent();
  return renderSidebarAgentMenu({
    position,
    activeId,
    activeName: agent ? normalizeAgentLabel(agent) : activeId,
    agents,
    filter: controller.agentMenuFilter,
    pinnedAgentIds: host.pinnedAgentIds,
    connected: host.connected,
    agentUnreadCount: (agentId) => host.agentUnreadCount(agentId),
    agentApprovalCount: (agentId) =>
      host.sessionData.approvalBadgeSnapshot().agentCounts.get(normalizeAgentId(agentId)) ?? 0,
    onFilterChange: (next) => controller.setAgentMenuFilter(next),
    onSwitchAgent: (agentId) => host.switchChipAgent(agentId),
    onAskCapabilities: (agentId) => host.askAgentCapabilities(agentId),
    onTabAway: () => trigger?.focus(),
    onClose: (restoreFocus) => {
      if (controller.agentMenuPosition !== position) {
        return;
      }
      controller.closeAgentMenu({ restoreFocus });
    },
    onNavigate: (routeId, options) => host.onNavigate?.(routeId, options),
  });
}

export function renderSidebarIdentityMenuForController(controller: SidebarMenusRenderController) {
  const { host } = controller;
  const position = controller.identityMenuPosition;
  const trigger = controller.identityMenuTrigger;
  const selfUser = resolveCurrentSelfUser({
    snapshotUser: host.sessionDataContext?.gateway.snapshot.selfUser,
    presenceEntries: readPresenceEntries(host.sessionData.presencePayload),
    presenceInstanceId: host.sessionData.presenceInstanceId,
  });
  return renderSidebarIdentityMenu({
    position,
    canPairDevice: host.canPairDevice,
    basePath: host.basePath,
    gatewayVersion: host.gatewayVersion,
    selfName: selfUser?.name ?? undefined,
    selfEmail: selfUser?.email ?? undefined,
    offline: host.offline,
    themeMode: host.themeMode,
    triggerWidth: position?.width ?? 0,
    onTabAway: () => trigger?.focus(),
    onClose: (restoreFocus) => {
      if (controller.identityMenuPosition !== position) {
        return;
      }
      controller.closeIdentityMenu({ restoreFocus });
    },
    onNavigate: (routeId, options) => host.onNavigate?.(routeId, options),
    onPairMobile: () => host.onPairMobile?.(),
    onRetryConnect: host.onRetryConnect,
  });
}

export function renderSidebarSessionMenuForController(controller: SidebarMenusRenderController) {
  const { host } = controller;
  const menu = controller.sessionMenu;
  if (!menu) {
    return nothing;
  }
  const context = host.sessionDataContext;
  const { session } = menu;
  const mainKey = resolveUiConfiguredMainKey({
    agentsList: host.sessionDataContext?.agents.state.agentsList,
    hello: host.sessionDataContext?.gateway.snapshot.hello,
  });
  const selection = host.selectedVisibleSessions();
  const batchRows =
    selection.length > 1 && selection.some((row) => row.key === session.key) ? selection : null;
  const rows = batchRows ?? [session];
  const archiveAllowed = rows.every((row) => canArchiveSessionRow(row, mainKey));
  const allUnread = rows.every((row) => row.unread);
  const allArchived = rows.every((row) => row.archived === true);
  const sharedCategory = rows.every((row) => (row.category ?? null) === (rows[0]?.category ?? null))
    ? (rows[0]?.category ?? null)
    : null;
  return keyed(
    menu,
    html`
      <openclaw-session-menu
        .session=${{
          label: session.label,
          icon: session.icon,
          pinned: session.pinned,
          unread: batchRows ? allUnread : session.unread,
          archived: allArchived,
          category: batchRows ? sharedCategory : (session.category ?? null),
        }}
        .selectionCount=${rows.length}
        .lastActive=${batchRows ? "" : session.meta}
        .anchor=${menu}
        .trigger=${controller.sessionMenuTrigger}
        .disabled=${!host.connected}
        .forkDisabled=${host.sessionData.sessionsLoading || session.modelSelectionLocked}
        .archiveAllowed=${archiveAllowed}
        .cloudWorkerStopAllowed=${Boolean(
          !batchRows &&
          session.cloudWorkerActive &&
          !session.hasActiveRun &&
          context &&
          isGatewayMethodAdvertised(context.gateway.snapshot, "sessions.reclaim") === true,
        )}
        .groups=${host.knownSessionGroups()}
        .canOpenChat=${true}
        .work=${batchRows ? null : controller.sessionMenuWork}
        .workboard=${null}
        .onClose=${() => {
          if (controller.sessionMenu === menu) {
            controller.closeSessionMenu();
          }
        }}
        .onAction=${(action: SessionMenuAction) => {
          if (batchRows) {
            void host.sessionOrganizer.runBatchSessionAction(action, batchRows, allUnread);
            return;
          }
          switch (action.kind) {
            case "open-chat":
              host.selectSession(session.key);
              break;
            case "open-pr":
              openExternalUrlSafe(action.url);
              break;
            case "open-in":
              openEditor(action.editor, action.path);
              break;
            case "toggle-pin":
              void host.sessionOrganizer.patchSession(session, { pinned: !session.pinned });
              break;
            case "set-icon":
              void host.sessionOrganizer.patchSession(session, { icon: action.icon });
              break;
            case "toggle-unread":
              void host.sessionOrganizer.patchSession(session, { unread: !session.unread });
              break;
            case "rename":
              void host.sessionOrganizer.renameSession(session);
              break;
            case "fork":
              void host.sessionOrganizer.forkSession(session);
              break;
            case "workboard":
              break;
            case "move-to-group":
              if (action.category === null || session.category !== action.category) {
                void host.sessionOrganizer.assignSessionCategory(session, action.category);
              }
              break;
            case "new-group":
              void host.sessionOrganizer.createSessionGroup([session]);
              break;
            case "toggle-archived":
              if (session.archived) {
                void host.sessionOrganizer.patchSession(session, { archived: false });
              } else {
                void host.sessionOrganizer.archiveSessionWithUndo(session);
              }
              break;
            case "stop-cloud-worker":
              void host.sessionOrganizer.stopCloudWorker(session);
              break;
            case "delete":
              void host.sessionOrganizer.deleteSession(session);
              break;
          }
        }}
      ></openclaw-session-menu>
    `,
  );
}

export function renderSidebarSessionGroupMenuForController(
  controller: SidebarMenusRenderController,
) {
  const { host } = controller;
  const menu = controller.sessionGroupMenu;
  return renderSidebarSessionGroupMenu({
    menu,
    trigger: controller.sessionGroupMenuTrigger,
    connected: host.connected,
    onAction: (action, group) => {
      controller.closeSessionGroupMenu({ restoreFocus: true });
      switch (action) {
        case "rename-group":
          void host.sessionOrganizer.renameSessionGroupFromMenu(group);
          break;
        case "new-group":
          void host.sessionOrganizer.createSessionGroup();
          break;
        case "delete-group":
          void host.sessionOrganizer.deleteSessionGroupFromMenu(group);
          break;
      }
    },
    onClose: (restoreFocus) => {
      if (controller.sessionGroupMenu !== menu) {
        return;
      }
      controller.closeSessionGroupMenu({ restoreFocus });
    },
  });
}

export function renderSidebarSessionSortMenuForController(
  controller: SidebarMenusRenderController,
) {
  const { host } = controller;
  const position = controller.sessionSortMenuPosition;
  return renderSidebarSessionSortMenu({
    position,
    trigger: controller.sessionSortMenuTrigger,
    grouping: host.sessionsGrouping,
    sortMode: host.sessionSortMode,
    statusFilter: host.sessionsStatusFilter,
    showCron: host.sessionsShowCron,
    creators: host.sessionOwnershipVisible ? host.sessionCreatorOptions : [],
    creatorFilterId: host.sessionCreatorFilterActive ? host.sessionCreatorFilterId : null,
    onGroupingChange: (grouping) => {
      host.sessionOrganizer.setSessionsGrouping(grouping);
      controller.closeSessionSortMenu({ restoreFocus: true });
    },
    onSortModeChange: (mode) => {
      host.sessionSortMode = mode;
      controller.closeSessionSortMenu({ restoreFocus: true });
    },
    onStatusFilterChange: (statusFilter) => {
      host.sessionOrganizer.setSessionsStatusFilter(statusFilter);
      controller.closeSessionSortMenu({ restoreFocus: true });
    },
    onCreatorFilterChange: (creatorId) => {
      host.sessionCreatorFilterId = creatorId;
      void host.sessionDataContext?.sessions.setCreatorFilter(creatorId);
      controller.closeSessionSortMenu({ restoreFocus: true });
    },
    onShowCronChange: (show) => {
      host.sessionOrganizer.setSessionsShowCron(show);
      controller.closeSessionSortMenu({ restoreFocus: true });
    },
    onClose: (restoreFocus) => {
      if (controller.sessionSortMenuPosition !== position) {
        return;
      }
      controller.closeSessionSortMenu({ restoreFocus });
    },
  });
}

export function renderSidebarMoreMenuForController(controller: SidebarMenusRenderController) {
  const { host } = controller;
  const position = controller.moreMenuPosition;
  const trigger = controller.moreMenuTrigger;
  return renderSidebarMoreMenu({
    position,
    basePath: host.basePath,
    activeRouteId: host.activeRouteId,
    activeWorkboardBoardId: activeWorkboardBoardIsPinned(host) ? host.activeWorkboardBoardId : "",
    sidebarEntries: host.sidebarEntries,
    isRouteEnabled: (routeId) => controller.isRouteEnabled(routeId),
    onTabAway: () => trigger?.focus(),
    onClose: (restoreFocus) => {
      if (controller.moreMenuPosition !== position) {
        return;
      }
      controller.closeMoreMenu({ restoreFocus });
    },
    onNavigateRoute: (routeId) => {
      controller.closeMoreMenu({ restoreFocus: true });
      host.onNavigate?.(routeId);
    },
    onPreloadRoute: (routeId, event) => controller.preloadRoute(routeId, event),
    onCancelPreload: (event) => controller.cancelPreload(event),
    onEditPinnedItems: () => {
      const customizePosition = controller.moreMenuPosition;
      const customizeTrigger = controller.moreMenuTrigger;
      if (customizePosition) {
        controller.openCustomizeMenu(customizePosition.x, customizePosition.y, customizeTrigger);
      }
    },
  });
}

function activeWorkboardBoardIsPinned(host: SidebarMenusRenderHost): boolean {
  return Boolean(
    host.activeWorkboardBoardId &&
    host
      .reconciledSidebarZone()
      .entries.some(
        (entry) => entry.type === "workboard" && entry.boardId === host.activeWorkboardBoardId,
      ),
  );
}
