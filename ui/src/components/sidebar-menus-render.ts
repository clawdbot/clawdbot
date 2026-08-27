import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { DEFAULT_SIDEBAR_ENTRIES, serializeSidebarEntry } from "../app-navigation.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { isUpdateActionable } from "../app/update-overlay-helpers.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { openEditor } from "../lib/editor-links.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { categoryClearReturnsToGroups } from "../lib/sessions/grouping.ts";
import {
  canArchiveSessionRow,
  canDeleteSessionRows,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
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
import { listAssignableSessionOwners } from "./session-owner-chip.ts";
import {
  isSidebarAttentionDismissed,
  isUpdateAttentionForced,
  loadDismissals,
  resolveUpdateAttentionDismissal,
} from "./sidebar-attention-dismissals.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";

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
    pinnedAgentIds: host.pinnedAgentIds,
    connected: host.connected,
    openMode: controller.agentMenuInteractionState === "open-hover" ? "hover" : "click",
    agentUnreadCount: (agentId) => host.agentUnreadCount(agentId),
    onPointerEnter: () => controller.handleAgentMenuPointerEnter(),
    onPointerLeave: () => controller.handleAgentMenuPointerLeave(),
    onAfterShow: () => controller.restoreFocusAfterAgentMenuHoverOpen(),
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
  const context = host.sessionDataContext;
  const overlaySnapshot = context?.overlays.snapshot;
  const updateAttentionDismissal = resolveUpdateAttentionDismissal({
    gatewayBootId: context?.gateway.snapshot.hello?.server?.bootId,
    updateAvailable: overlaySnapshot?.updateAvailable,
    updateSchedule: overlaySnapshot?.updateSchedule,
  });
  const updateAttentionDismissed = Boolean(
    context &&
    updateAttentionDismissal &&
    isUpdateActionable(
      overlaySnapshot?.updateAvailable,
      overlaySnapshot?.updateSchedule,
      Boolean(overlaySnapshot?.updateRunning || overlaySnapshot?.updateReconciliationPending),
    ) &&
    !overlaySnapshot?.updateRunning &&
    !overlaySnapshot?.updateReconciliationPending &&
    overlaySnapshot?.updateSchedule?.campaign?.state !== "applying" &&
    !isUpdateAttentionForced(overlaySnapshot?.updateStatusBanner?.tone) &&
    isSidebarAttentionDismissed(
      loadDismissals(context.gateway.connection.gatewayUrl),
      updateAttentionDismissal,
    ),
  );
  return renderSidebarIdentityMenu({
    position,
    canPairDevice: host.canPairDevice,
    basePath: host.basePath,
    gatewayVersion: host.gatewayVersion,
    updateAttentionDismissed,
    profileViewer: selfUser ? { ...selfUser, watchedSessions: [] } : undefined,
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
    (!cloudWorkerStopAction.blocksActiveRun || !session.hasActiveRun) &&
    context &&
    isGatewayMethodAdvertised(context.gateway.snapshot, cloudWorkerStopAction.method) === true,
  );
  const selfUser = context?.gateway.snapshot.selfUser ?? null;
  const sessionsResult = [
    host.sessionData.sessionsResult,
    ...Object.values(host.sessionData.sessionResultsByAgent),
  ].find((result) => result?.sessions.some((row) => row.key === session.key));
  const ownerOptions = listAssignableSessionOwners({
    facet: sessionsResult?.owners,
    agents: context?.agents.state.agentsList?.agents,
    self: selfUser,
  });
  const selfOwner = selfUser
    ? (ownerOptions.find((owner) => owner.type === "human" && owner.id === selfUser.id) ?? null)
    : null;
  const assignmentAccess = host.readSessionMutationAccess({
    method: "sessions.assignOwner",
    params: { key: session.key, owner: { type: "human", id: selfUser?.id ?? "profile" } },
    requiredScope: "operator.write",
  });
  const actionDisabledReasons = {
    ...sessionMenuReasons({
      snapshot: context?.gateway.snapshot,
      session,
      batchRows,
      cloudWorkerStopAction: session.cloudWorkerStopAction,
    }),
    ...(!assignmentAccess.allowed ? { "assign-owner": assignmentAccess.reason } : {}),
  };
  return keyed(
    menu,
    html`
      <openclaw-session-menu
        .session=${{
          label: session.label,
          sessionId: session.sessionId ?? null,
          isChild: session.isChild,
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
        .compact=${isMobileNavLayout()}
        .lastActive=${batchRows ? "" : formatSidebarTimestamp(session.updatedAt)}
        .anchor=${menu}
        .trigger=${controller.sessionMenuTrigger}
        .disabled=${!host.connected}
        .actionDisabledReasons=${actionDisabledReasons}
        .forkDisabled=${host.sessionData.sessionsLoading || session.modelSelectionLocked}
        .forkFromLastCompleted=${session.gatewayHasActiveRun ?? session.hasActiveRun}
        .archiveAllowed=${archiveAllowed}
        .deleteAllowed=${deleteAllowed}
        .cloudWorkerStopAllowed=${cloudWorkerStopAllowed}
        .groups=${host.knownSessionGroups()}
        .ownerOptions=${ownerOptions}
        .selfOwner=${selfOwner}
        .currentOwnerId=${session.owner?.actor.id ?? null}
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
            case "copy-session-id":
              void copyToClipboard(session.sessionId ?? "").then((copied) => {
                showToast({ message: t(copied ? "common.copied" : "common.copyFailed") });
              });
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
            case "assign-owner":
              void host.sessionOrganizer.assignSessionOwner(session, action.owner);
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
            default:
              action satisfies never;
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
    grouping: host.effectiveSessionsGrouping(),
    sortMode: host.effectiveSessionSortMode(),
    peopleSortAvailable: host.sessionPeopleSortAvailable(),
    statusFilter: host.sessionsStatusFilter,
    showCron: host.sessionsShowCron,
    showPreview: host.sessionsShowPreview,
    showSystem: host.sessionsShowSystem,
    owners: host.sessionOwnershipVisible ? host.sessionOwnerOptions : [],
    ownerFilterId: host.sessionOwnerFilterActive ? host.sessionOwnerFilterId : null,
    involvingMe: host.sessionInvolvingMeFilterActive,
    selfOwnerId: host.sessionDataContext?.gateway.snapshot.selfUser?.id ?? null,
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
    onOwnerFilterChange: (ownerId, involvingMe = false) => {
      host.setSessionOwnerFilter(ownerId, involvingMe);
      controller.closeSessionSortMenu({ restoreFocus: true });
    },
    onShowCronChange: (show) => {
      host.sessionOrganizer.setSessionsShowCron(show);
      controller.closeSessionSortMenu({ restoreFocus: true });
    },
    onShowPreviewChange: (show) => {
      host.sessionOrganizer.setSessionsShowPreview(show);
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
    owners: host.sessionOwnershipVisible ? host.sessionOwnerOptions : [],
    ownerFilterId: host.sessionOwnerFilterActive ? host.sessionOwnerFilterId : null,
    involvingMe: host.sessionInvolvingMeFilterActive,
    selfOwnerId: host.sessionDataContext?.gateway.snapshot.selfUser?.id ?? null,
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
    onOwnerFilterChange: (ownerId, involvingMe = false) => {
      host.setSessionOwnerFilter(ownerId, involvingMe);
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
