import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import {
  cancelRoutePreload,
  DEFAULT_SIDEBAR_ENTRIES,
  scheduleRoutePreload,
  serializeSidebarEntry,
  type NavigationRouteId,
} from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { openEditor } from "../lib/editor-links.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import {
  canArchiveSessionRow,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { renderSidebarAgentMenu } from "./app-sidebar-agent-menu.ts";
import { SidebarCatalogMenuController } from "./app-sidebar-catalog-menu.ts";
import {
  isSidebarRouteActive,
  renderSidebarCustomizeMenu,
  renderSidebarMoreMenu,
  renderSidebarNavRoute,
} from "./app-sidebar-nav-menus.ts";
import { AppSidebarSessionGroupsElement } from "./app-sidebar-session-groups.ts";
import {
  renderSidebarSessionGroupMenu,
  renderSidebarSessionSortMenu,
} from "./app-sidebar-session-menu-renderers.ts";
import type {
  SidebarRecentSession,
  SidebarSessionGroupMenuState,
  SidebarSessionMenuState,
} from "./app-sidebar-session-types.ts";
import { fetchSessionMenuWork } from "./session-menu-work.ts";
import type { SessionMenuAction, SessionMenuWork } from "./session-menu.ts";

/** Popup ownership and stateless menu-renderer wiring. */
export abstract class AppSidebarMenusElement extends AppSidebarSessionGroupsElement {
  @state() protected customizeMenuPosition: { x: number; y: number } | null = null;
  @state() protected moreMenuPosition: { x: number; y: number } | null = null;
  @state() sessionMenu: SidebarSessionMenuState | null = null;
  @state() protected sessionMenuWork: SessionMenuWork | null = null;
  @state() sessionGroupMenu: SidebarSessionGroupMenuState | null = null;
  @state() sessionSortMenuPosition: { x: number; y: number } | null = null;
  // Anchored by its bottom edge so the footer menu grows upward regardless of height.
  @state() protected agentMenuPosition: { x: number; bottom: number } | null = null;
  @state() protected agentMenuFilter = "";

  private customizeMenuTrigger: HTMLElement | null = null;
  private moreMenuTrigger: HTMLElement | null = null;
  private sessionMenuTrigger: HTMLElement | null = null;
  private sessionMenuWorkVersion = 0;
  private sessionGroupMenuTrigger: HTMLElement | null = null;
  private sessionSortMenuTrigger: HTMLElement | null = null;
  private agentMenuTrigger: HTMLElement | null = null;
  private readonly routePreloadTimers = new Map<
    EventTarget,
    ReturnType<typeof globalThis.setTimeout>
  >();
  protected readonly catalogMenu = new SidebarCatalogMenuController({
    // Closing every transient menu keeps one popover at a time.
    beforeOpen: () => void this.dismissTransientMenus(),
    requestUpdate: () => this.requestUpdate(),
    terminalAvailable: () => this.terminalAvailable,
    navigate: (search) => this.onNavigate?.("chat", { search }),
  });

  override disconnectedCallback() {
    for (const timer of this.routePreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.routePreloadTimers.clear();
    super.disconnectedCallback();
  }

  // The shell calls this before CSS hides the panel or drawer. Mounted menus
  // keep document-level shortcuts alive even when an ancestor is hidden.
  dismissTransientMenus(): boolean {
    const hadTransientMenu = Boolean(
      this.customizeMenuPosition ||
      this.moreMenuPosition ||
      this.sessionMenu ||
      this.catalogMenu.isOpen ||
      this.sessionGroupMenu ||
      this.sessionSortMenuPosition ||
      this.agentMenuPosition,
    );
    this.closeCustomizeMenu();
    this.closeMoreMenu();
    this.closeSessionMenu();
    this.catalogMenu.close();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.closeAgentMenu();
    return hadTransientMenu;
  }

  protected preloadRoute(routeId: NavigationRouteId, event: Event, immediate = false) {
    scheduleRoutePreload(
      this.routePreloadTimers,
      routeId,
      event,
      (nextRouteId) => this.onPreloadRoute?.(nextRouteId),
      routeId === this.activeRouteId || !this.isRouteEnabled(routeId),
      immediate,
    );
  }

  private readonly cancelPreload = (event: Event) => {
    cancelRoutePreload(this.routePreloadTimers, event);
  };

  protected isRouteEnabled(routeId: NavigationRouteId): boolean {
    return this.enabledRouteIds?.includes(routeId) ?? true;
  }

  protected readonly openCustomizeMenuFromContext = (event: MouseEvent) => {
    event.preventDefault();
    this.openCustomizeMenu(event.clientX, event.clientY);
  };

  private openCustomizeMenu(x: number, y: number, trigger: HTMLElement | null = null) {
    const menuWidth = 240;
    const menuMaxHeight = 420;
    this.dismissTransientMenus();
    this.customizeMenuTrigger = trigger;
    this.customizeMenuPosition = {
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuMaxHeight - 8)),
    };
  }

  private closeCustomizeMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.customizeMenuTrigger;
    this.customizeMenuTrigger = null;
    this.customizeMenuPosition = null;
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  protected toggleMoreMenu(trigger: HTMLElement) {
    if (this.moreMenuPosition) {
      this.closeMoreMenu();
      return;
    }
    const menuWidth = 240;
    const menuMaxHeight = 420;
    const rect = trigger.getBoundingClientRect();
    this.dismissTransientMenus();
    this.moreMenuTrigger = trigger;
    this.moreMenuPosition = {
      x: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuMaxHeight - 8)),
    };
  }

  private closeMoreMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.moreMenuTrigger;
    this.moreMenuTrigger = null;
    this.moreMenuPosition = null;
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  /** A row outside the current selection retargets before the menu opens. */
  openSessionMenu(
    session: SidebarRecentSession,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ) {
    if (!this.selectedSessionKeys.has(session.key)) {
      this.clearSessionSelection();
    }
    this.showSessionMenu(session, x, y, trigger);
  }

  private showSessionMenu(
    session: SidebarRecentSession,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ) {
    this.dismissTransientMenus();
    this.sessionMenuTrigger = trigger;
    this.sessionMenu = { session, x, y };
    this.loadSessionMenuWork(session);
  }

  protected closeSessionMenu() {
    this.sessionMenuTrigger = null;
    this.sessionMenu = null;
    this.sessionMenuWorkVersion += 1;
    this.sessionMenuWork = null;
  }

  private loadSessionMenuWork(session: SidebarRecentSession) {
    const version = ++this.sessionMenuWorkVersion;
    if (!session.worktreeId) {
      this.sessionMenuWork = null;
      return;
    }
    this.sessionMenuWork = { loading: true, pullRequestUrl: null, worktreePath: null };
    const context = this.context;
    const client = context?.gateway.snapshot.client;
    if (!context || !client) {
      this.sessionMenuWork = { loading: false, pullRequestUrl: null, worktreePath: null };
      return;
    }
    const { selectedAgentId } = this.getSessionNavigationState();
    void fetchSessionMenuWork({
      client,
      pullRequestsAvailable:
        isGatewayMethodAdvertised(context.gateway.snapshot, "controlUi.sessionPullRequests") ===
        true,
      sessionKey: session.key,
      agentId: parseAgentSessionKey(session.key)?.agentId ?? selectedAgentId,
      worktreeId: session.worktreeId,
    }).then((work) => {
      if (version === this.sessionMenuWorkVersion) {
        this.sessionMenuWork = { loading: false, ...work };
      }
    });
  }

  openSessionGroupMenu(group: string, x: number, y: number, trigger: HTMLElement | null) {
    const menuWidth = 224;
    const menuMaxHeight = 160;
    this.dismissTransientMenus();
    this.sessionGroupMenuTrigger = trigger;
    this.sessionGroupMenu = {
      group,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuMaxHeight - 8)),
    };
  }

  private closeSessionGroupMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.sessionGroupMenuTrigger;
    this.sessionGroupMenuTrigger = null;
    this.sessionGroupMenu = null;
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  toggleSessionSortMenu(trigger: HTMLElement) {
    if (this.sessionSortMenuPosition) {
      this.closeSessionSortMenu();
      return;
    }
    const menuWidth = 200;
    const menuMaxHeight = 280;
    const rect = trigger.getBoundingClientRect();
    this.dismissTransientMenus();
    this.sessionSortMenuTrigger = trigger;
    this.sessionSortMenuPosition = {
      x: Math.max(8, Math.min(rect.right, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuMaxHeight - 8)),
    };
  }

  private closeSessionSortMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.sessionSortMenuTrigger;
    this.sessionSortMenuTrigger = null;
    this.sessionSortMenuPosition = null;
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  protected toggleAgentMenu(trigger: HTMLElement) {
    if (this.agentMenuPosition) {
      this.closeAgentMenu();
      return;
    }
    const menuWidth = 240;
    const rect = trigger.getBoundingClientRect();
    this.closeCustomizeMenu();
    this.closeMoreMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.agentMenuTrigger = trigger;
    this.agentMenuFilter = "";
    this.agentMenuPosition = {
      x: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 4),
    };
  }

  protected closeAgentMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.agentMenuTrigger;
    this.agentMenuTrigger = null;
    this.agentMenuPosition = null;
    this.agentMenuFilter = "";
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  protected renderCustomizeMenu() {
    const position = this.customizeMenuPosition;
    const trigger = this.customizeMenuTrigger;
    return renderSidebarCustomizeMenu({
      position,
      sidebarEntries: this.sidebarEntries,
      isRouteEnabled: (routeId) => this.isRouteEnabled(routeId),
      workboardBoards: this.workboardBoards,
      workboardRenderers: this.workboardRenderers,
      onTabAway: () => trigger?.focus(),
      onClose: (restoreFocus) => {
        if (this.customizeMenuPosition !== position) {
          return;
        }
        this.closeCustomizeMenu({ restoreFocus });
      },
      onToggleRoute: (routeId) => {
        const entry = serializeSidebarEntry({ type: "route", route: routeId });
        const canonical = this.reconciledSidebarZone().sidebarEntries;
        const next = canonical.includes(entry)
          ? canonical.filter((candidate) => candidate !== entry)
          : [...canonical, entry];
        this.onUpdateSidebarEntries?.(next);
      },
      onToggleWorkboardBoard: (boardId) => {
        const entry = serializeSidebarEntry({ type: "workboard", boardId });
        const canonical = this.reconciledSidebarZone().sidebarEntries;
        const next = canonical.includes(entry)
          ? canonical.filter((candidate) => candidate !== entry)
          : [...canonical, entry];
        this.onUpdateSidebarEntries?.(next);
      },
      onReset: () => {
        // Canonical list, not the render list: unknown-state session slots
        // (other agents, still-loading caches) must survive a route reset.
        const sessions = this.reconciledSidebarZone().sidebarEntries.filter((entry) =>
          entry.startsWith("session:"),
        );
        this.onUpdateSidebarEntries?.([...DEFAULT_SIDEBAR_ENTRIES, ...sessions]);
        this.closeCustomizeMenu({ restoreFocus: true });
      },
    });
  }

  protected renderAgentMenu() {
    const position = this.agentMenuPosition;
    const trigger = this.agentMenuTrigger;
    const { activeId, agent, agents } = this.activeChipAgent();
    return renderSidebarAgentMenu({
      position,
      activeId,
      activeName: agent ? normalizeAgentLabel(agent) : activeId,
      agents,
      filter: this.agentMenuFilter,
      pinnedAgentIds: this.pinnedAgentIds,
      connected: this.connected,
      canPairDevice: this.canPairDevice,
      basePath: this.basePath,
      gatewayVersion: this.gatewayVersion,
      themeMode: this.themeMode,
      agentUnreadCount: (agentId) => this.agentUnreadCount(agentId),
      agentApprovalCount: (agentId) =>
        this.approvalBadgeSnapshot().agentCounts.get(normalizeAgentId(agentId)) ?? 0,
      onFilterChange: (next) => {
        this.agentMenuFilter = next;
      },
      onSwitchAgent: (agentId) => this.switchChipAgent(agentId),
      onAskCapabilities: (agentId) => this.askAgentCapabilities(agentId),
      onTabAway: () => trigger?.focus(),
      onClose: (restoreFocus) => {
        if (this.agentMenuPosition !== position) {
          return;
        }
        this.closeAgentMenu({ restoreFocus });
      },
      onNavigate: (routeId, options) => this.onNavigate?.(routeId, options),
      onPairMobile: () => this.onPairMobile?.(),
    });
  }

  protected renderSessionMenu() {
    const menu = this.sessionMenu;
    if (!menu) {
      return nothing;
    }
    const context = this.context;
    const { session } = menu;
    const mainKey = resolveUiConfiguredMainKey({
      agentsList: this.context?.agents.state.agentsList,
      hello: this.context?.gateway.snapshot.hello,
    });
    const selection = this.selectedVisibleSessions();
    const batchRows =
      selection.length > 1 && selection.some((row) => row.key === session.key) ? selection : null;
    const rows = batchRows ?? [session];
    const archiveAllowed = rows.every((row) => canArchiveSessionRow(row, mainKey));
    const allUnread = rows.every((row) => row.unread);
    const allArchived = rows.every((row) => row.archived === true);
    const sharedCategory = rows.every(
      (row) => (row.category ?? null) === (rows[0]?.category ?? null),
    )
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
          .trigger=${this.sessionMenuTrigger}
          .disabled=${!this.connected}
          .forkDisabled=${this.sessionsLoading || session.modelSelectionLocked}
          .archiveAllowed=${archiveAllowed}
          .cloudWorkerStopAllowed=${Boolean(
            !batchRows &&
            session.cloudWorkerActive &&
            !session.hasActiveRun &&
            context &&
            isGatewayMethodAdvertised(context.gateway.snapshot, "sessions.reclaim") === true,
          )}
          .groups=${this.knownSessionGroups()}
          .canOpenChat=${true}
          .work=${batchRows ? null : this.sessionMenuWork}
          .workboard=${null}
          .onClose=${() => {
            if (this.sessionMenu === menu) {
              this.closeSessionMenu();
            }
          }}
          .onAction=${(action: SessionMenuAction) => {
            if (batchRows) {
              this.runBatchSessionAction(action, batchRows, allUnread);
              return;
            }
            switch (action.kind) {
              case "open-chat":
                this.selectSession(session.key);
                break;
              case "open-pr":
                openExternalUrlSafe(action.url);
                break;
              case "open-in":
                openEditor(action.editor, action.path);
                break;
              case "toggle-pin":
                void this.patchSession(session, { pinned: !session.pinned });
                break;
              case "set-icon":
                void this.patchSession(session, { icon: action.icon });
                break;
              case "toggle-unread":
                void this.patchSession(session, { unread: !session.unread });
                break;
              case "rename":
                this.renameSession(session);
                break;
              case "fork":
                void this.forkSession(session);
                break;
              case "workboard":
                break;
              case "move-to-group":
                if (action.category === null || session.category !== action.category) {
                  this.assignSessionCategory(session, action.category);
                }
                break;
              case "new-group":
                this.createSessionGroup([session]);
                break;
              case "toggle-archived":
                if (session.archived) {
                  void this.patchSession(session, { archived: false });
                } else {
                  void this.archiveSessionWithUndo(session);
                }
                break;
              case "stop-cloud-worker":
                void this.stopCloudWorker(session);
                break;
              case "delete":
                void this.deleteSession(session);
                break;
            }
          }}
        ></openclaw-session-menu>
      `,
    );
  }

  protected renderSessionGroupMenu() {
    const menu = this.sessionGroupMenu;
    return renderSidebarSessionGroupMenu({
      menu,
      trigger: this.sessionGroupMenuTrigger,
      connected: this.connected,
      onAction: (action, group) => {
        this.closeSessionGroupMenu({ restoreFocus: true });
        switch (action) {
          case "rename-group":
            this.renameSessionGroupFromMenu(group);
            break;
          case "new-group":
            this.createSessionGroup();
            break;
          case "delete-group":
            this.deleteSessionGroupFromMenu(group);
            break;
        }
      },
      onClose: (restoreFocus) => {
        if (this.sessionGroupMenu !== menu) {
          return;
        }
        this.closeSessionGroupMenu({ restoreFocus });
      },
    });
  }

  protected renderSessionSortMenu() {
    const position = this.sessionSortMenuPosition;
    return renderSidebarSessionSortMenu({
      position,
      trigger: this.sessionSortMenuTrigger,
      grouping: this.sessionsGrouping,
      sortMode: this.sessionSortMode,
      statusFilter: this.sessionsStatusFilter,
      showCron: this.sessionsShowCron,
      onGroupingChange: (grouping) => {
        this.setSessionsGrouping(grouping);
        this.closeSessionSortMenu({ restoreFocus: true });
      },
      onSortModeChange: (mode) => {
        this.sessionSortMode = mode;
        this.closeSessionSortMenu({ restoreFocus: true });
      },
      onStatusFilterChange: (statusFilter) => {
        this.setSessionsStatusFilter(statusFilter);
        this.closeSessionSortMenu({ restoreFocus: true });
      },
      onShowCronChange: (show) => {
        this.setSessionsShowCron(show);
        this.closeSessionSortMenu({ restoreFocus: true });
      },
      onClose: (restoreFocus) => {
        if (this.sessionSortMenuPosition !== position) {
          return;
        }
        this.closeSessionSortMenu({ restoreFocus });
      },
    });
  }

  protected renderRoute(routeId: NavigationRouteId) {
    if (!this.isRouteEnabled(routeId)) {
      return nothing;
    }
    const routeSessionKey = routeId === "chat" ? this.getRouteSessionKey() : "";
    const chatSearch =
      routeId === "chat" && routeSessionKey ? searchForSession(routeSessionKey) : "";
    return renderSidebarNavRoute({
      routeId,
      href: chatSearch
        ? `${pathForRoute("chat", this.basePath)}${chatSearch}`
        : pathForRoute(routeId, this.basePath),
      active:
        isSidebarRouteActive(this.activeRouteId, routeId) &&
        !(routeId === "workboard" && this.activeWorkboardBoardIsPinned()),
      onNavigate: () => {
        this.onNavigate?.(routeId, chatSearch ? { search: chatSearch } : undefined);
      },
      onPreload: (event, immediate) => this.preloadRoute(routeId, event, immediate),
      onCancelPreload: this.cancelPreload,
    });
  }

  protected renderMoreMenu() {
    const position = this.moreMenuPosition;
    const trigger = this.moreMenuTrigger;
    return renderSidebarMoreMenu({
      position,
      basePath: this.basePath,
      activeRouteId: this.activeRouteId,
      activeWorkboardBoardId: this.activeWorkboardBoardIsPinned()
        ? this.activeWorkboardBoardId
        : "",
      sidebarEntries: this.sidebarEntries,
      isRouteEnabled: (routeId) => this.isRouteEnabled(routeId),
      onTabAway: () => trigger?.focus(),
      onClose: (restoreFocus) => {
        if (this.moreMenuPosition !== position) {
          return;
        }
        this.closeMoreMenu({ restoreFocus });
      },
      onNavigateRoute: (routeId) => {
        this.closeMoreMenu({ restoreFocus: true });
        this.onNavigate?.(routeId);
      },
      onPreloadRoute: (routeId, event) => this.preloadRoute(routeId, event),
      onCancelPreload: this.cancelPreload,
      onEditPinnedItems: () => {
        const customizePosition = this.moreMenuPosition;
        const customizeTrigger = this.moreMenuTrigger;
        if (customizePosition) {
          this.openCustomizeMenu(customizePosition.x, customizePosition.y, customizeTrigger);
        }
      },
    });
  }

  private activeWorkboardBoardIsPinned(): boolean {
    return Boolean(
      this.activeWorkboardBoardId &&
      this.reconciledSidebarZone().entries.some(
        (entry) => entry.type === "workboard" && entry.boardId === this.activeWorkboardBoardId,
      ),
    );
  }
}
