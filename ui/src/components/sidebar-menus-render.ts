import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { DEFAULT_SIDEBAR_ENTRIES, serializeSidebarEntry } from "../app-navigation.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { openEditor } from "../lib/editor-links.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { categoryClearReturnsToGroups } from "../lib/sessions/grouping.ts";
import {
  canArchiveSessionRow,
  canDeleteSessionRows,
  normalizeAgentId,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { renderSidebarAgentMenu, renderSidebarIdentityMenu } from "./app-sidebar-agent-menu.ts";
import { renderSidebarCustomizeMenu, renderSidebarMoreMenu } from "./app-sidebar-nav-menus.ts";
import { formatSidebarTimestamp } from "./app-sidebar-session-catalogs.ts";
import {
  renderSidebarCatalogViewMenu,
  renderSidebarSessionGroupMenu,
  renderSidebarSessionSortMenu,
} from "./app-sidebar-session-menu-renderers.ts";
import { sessionMenuReasons } from "./session-menu-access.ts";
import type { SessionMenuAction } from "./session-menu.ts";
import type {
  SidebarMenusController,
  SidebarMenusControllerHost,
} from "./sidebar-menus-controller.ts";

export function renderSidebarCustomizeMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const position = controller.customizeMenuPosition;
  const trigger = controller.customizeMenuTrigger;
  return renderSidebarCustomizeMenu({
    position,
    sidebarEntries: host.sidebarEntries,
    preferencesBrowserOnly: host.preferencesBrowserOnly,
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

export function renderSidebarAgentMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const position = controller.agentMenuPosition;
  const trigger = controller.agentMenuTrigger;
  const { activeId, agent, agents, identity, identities } = host.activeChipAgent();
  return renderSidebarAgentMenu({
    position,
    basePath: host.basePath,
    activeId,
    activeName: normalizeAgentLabel(agent ?? { id: activeId }, identity),
    agents,
    identities,
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

export function renderSidebarIdentityMenuForController(controller: SidebarMenusController) {
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

export function renderSidebarSessionMenuForController(controller: SidebarMenusController) {
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
  const deleteAllowed = canDeleteSessionRows(rows, mainKey);
  const allUnread = rows.every((row) => row.unread);
  const allArchived = rows.every((row) => row.archived === true);
  const sharedCategory = rows.every((row) => (row.category ?? null) === (rows[0]?.category ?? null))
    ? (rows[0]?.category ?? null)
    : null;
  const cloudWorkerStopAction = session.cloudWorkerStopAction;
  const cloudWorkerStopAllowed = Boolean(
    !batchRows &&
    cloudWorkerStopAction &&
    (cloudWorkerStopAction.method !== "sessions.reclaim" || !session.hasActiveRun) &&
    context &&
    isGatewayMethodAdvertised(context.gateway.snapshot, cloudWorkerStopAction.method) === true,
  );
  return keyed(
    menu,
    html`
      <openclaw-session-menu
        .session=${{
          label: session.label,
          pinned: session.pinned,
          unread: batchRows ? allUnread : session.unread,
          archived: allArchived,
          category: batchRows ? sharedCategory : (session.category ?? null),
          icon: batchRows ? null : (session.icon ?? null),
          categoryClearReturnsToGroups:
            sharedCategory !== null &&
            rows.every((row) => categoryClearReturnsToGroups(row, host.sessionsGrouping)),
        }}
        .selectionCount=${rows.length}
        .lastActive=${batchRows ? "" : formatSidebarTimestamp(session.updatedAt)}
        .anchor=${menu}
        .trigger=${controller.sessionMenuTrigger}
        .disabled=${!host.connected}
        .actionDisabledReasons=${sessionMenuReasons({
          snapshot: context?.gateway.snapshot,
          session,
          batchRows,
          cloudWorkerStopAction: session.cloudWorkerStopAction,
        })}
        .forkDisabled=${host.sessionData.sessionsLoading || session.modelSelectionLocked}
        .forkFromLastCompleted=${session.gatewayHasActiveRun ?? session.hasActiveRun}
        .archiveAllowed=${archiveAllowed}
        .deleteAllowed=${deleteAllowed}
        .cloudWorkerStopAllowed=${cloudWorkerStopAllowed}
        .groups=${host.knownSessionGroups()}
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
            case "open-pr":
              openExternalUrlSafe(action.url);
              break;
            case "open-in":
              openEditor(action.editor, action.path);
              break;
            case "toggle-pin":
              void host.sessionOrganizer.patchSession(session, { pinned: !session.pinned });
              break;
            case "toggle-unread":
              void host.sessionOrganizer.patchSession(session, { unread: !session.unread });
              break;
            case "rename":
              void host.sessionOrganizer.renameSession(session);
              break;
            case "set-icon":
              void host.sessionOrganizer.patchSession(session, { icon: action.icon });
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

export function renderSidebarSessionGroupMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const menu = controller.sessionGroupMenu;
  const groupDefaultsStatus = host.sessionDataContext?.sessions.groupsStatus() ?? "idle";
  const groupActionAccess = {
    "group-defaults": readSessionMethodAccess(host.sessionDataContext?.gateway.snapshot, {
      method: "sessions.groups.update",
      requiredScope: "operator.write",
    }),
    "rename-group": readSessionMethodAccess(host.sessionDataContext?.gateway.snapshot, {
      method: "sessions.groups.rename",
      requiredScope: "operator.write",
    }),
    "new-group": readSessionMethodAccess(host.sessionDataContext?.gateway.snapshot, {
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    }),
    "delete-group": readSessionMethodAccess(host.sessionDataContext?.gateway.snapshot, {
      method: "sessions.groups.delete",
      requiredScope: "operator.write",
    }),
  } as const;
  return renderSidebarSessionGroupMenu({
    menu,
    trigger: controller.sessionGroupMenuTrigger,
    connected: host.connected,
    groupDefaultsUnavailable: groupDefaultsStatus === "unavailable",
    actionDisabledReasons: Object.fromEntries(
      Object.entries(groupActionAccess).flatMap(([action, access]) => {
        if (!access.allowed) {
          return [[action, access.reason]];
        }
        return action === "group-defaults" &&
          groupDefaultsStatus !== "ready" &&
          groupDefaultsStatus !== "unavailable"
          ? [[action, t("common.loading")]]
          : [];
      }),
    ),
    onAction: (action, group) => {
      controller.closeSessionGroupMenu({ restoreFocus: true });
      switch (action) {
        case "group-defaults":
          if (groupDefaultsStatus === "unavailable") {
            host.sessionDataContext?.sessions.groupsInvalidate();
            void host.sessionDataContext?.sessions.groupsLoad();
            break;
          }
          void host.sessionOrganizer.editSessionGroupDefaults(group);
          break;
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

export function renderSidebarSessionSortMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const position = controller.sessionSortMenuPosition;
  return renderSidebarSessionSortMenu({
    position,
    trigger: controller.sessionSortMenuTrigger,
    grouping: host.sessionsGrouping,
    sortMode: host.effectiveSessionSortMode(),
    peopleSortAvailable: host.sessionPeopleSortAvailable(),
    statusFilter: host.sessionsStatusFilter,
    showCron: host.sessionsShowCron,
    showSystem: host.sessionsShowSystem,
    creators: host.sessionOwnershipVisible ? host.sessionCreatorOptions : [],
    creatorFilterId: host.sessionCreatorFilterActive ? host.sessionCreatorFilterId : null,
    onGroupingChange: (grouping) => {
      host.sessionOrganizer.setSessionsGrouping(grouping);
      controller.closeSessionSortMenu({ restoreFocus: true });
    },
    onSortModeChange: (mode) => {
      host.setSessionSortMode(mode);
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
    onShowSystemChange: (show) => {
      host.sessionOrganizer.setSessionsShowSystem(show);
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

export function renderSidebarCatalogViewMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const position = controller.catalogViewMenuPosition;
  return renderSidebarCatalogViewMenu({
    position,
    trigger: controller.catalogViewMenuTrigger,
    grouping: host.catalogProjectGrouping,
    creators: host.sessionOwnershipVisible ? host.sessionCreatorOptions : [],
    creatorFilterId: host.sessionCreatorFilterActive ? host.sessionCreatorFilterId : null,
    onGroupingChange: (grouping) => {
      host.setCatalogProjectGrouping(grouping);
      controller.closeCatalogViewMenu({ restoreFocus: true });
    },
    onHide: () => {
      if (!position || controller.catalogViewMenuPosition !== position) {
        return;
      }
      host.hideSessionCatalog(position.catalogId);
      controller.closeCatalogViewMenu();
    },
    onCreatorFilterChange: (creatorId) => {
      host.sessionCreatorFilterId = creatorId;
      void host.sessionDataContext?.sessions.setCreatorFilter(creatorId);
      controller.closeCatalogViewMenu({ restoreFocus: true });
    },
    onClose: (restoreFocus) => {
      if (controller.catalogViewMenuPosition !== position) {
        return;
      }
      controller.closeCatalogViewMenu({ restoreFocus });
    },
  });
}

export function renderSidebarMoreMenuForController(controller: SidebarMenusController) {
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

function activeWorkboardBoardIsPinned(host: SidebarMenusControllerHost): boolean {
  return Boolean(
    host.activeWorkboardBoardId &&
    host
      .reconciledSidebarZone()
      .entries.some(
        (entry) => entry.type === "workboard" && entry.boardId === host.activeWorkboardBoardId,
      ),
  );
}
