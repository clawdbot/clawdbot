import { nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import {
  cancelRoutePreload,
  scheduleRoutePreload,
  type NavigationRouteId,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import type { ThemeMode } from "../app/theme.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { SidebarCatalogMenuController } from "./app-sidebar-catalog-menu.ts";
import { isSidebarRouteActive, renderSidebarNavRoute } from "./app-sidebar-nav-menus.ts";
import type {
  SidebarRecentSession,
  SidebarSessionGroupMenuState,
  SidebarSessionMenuState,
  SidebarSessionSortMode,
} from "./app-sidebar-session-types.ts";
import type { SidebarWorkboardBoard, SidebarWorkboardRenderers } from "./app-sidebar-workboard.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import { fetchSessionMenuWork } from "./session-menu-work.ts";
import type { SessionMenuWork } from "./session-menu.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-operations.runtime.ts";
import type { SessionCreatorOption } from "./session-owner-chip.ts";

type SidebarMenuAgent = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string; avatar?: string; avatarUrl?: string };
};

interface SidebarMenusControllerState {
  customizeMenuPosition: { x: number; y: number } | null;
  moreMenuPosition: { x: number; y: number } | null;
  sessionMenu: SidebarSessionMenuState | null;
  sessionMenuWork: SessionMenuWork | null;
  sessionGroupMenu: SidebarSessionGroupMenuState | null;
  sessionSortMenuPosition: { x: number; y: number } | null;
  agentMenuPosition: { x: number; bottom: number } | null;
  agentMenuFilter: string;
  identityMenuPosition: { x: number; bottom: number; width: number } | null;
}

type SidebarMenusRenderer = {
  renderSidebarAgentMenuForController(controller: SidebarMenusController): unknown;
  renderSidebarCustomizeMenuForController(controller: SidebarMenusController): unknown;
  renderSidebarIdentityMenuForController(controller: SidebarMenusController): unknown;
  renderSidebarMoreMenuForController(controller: SidebarMenusController): unknown;
  renderSidebarSessionGroupMenuForController(controller: SidebarMenusController): unknown;
  renderSidebarSessionMenuForController(controller: SidebarMenusController): unknown;
  renderSidebarSessionSortMenuForController(controller: SidebarMenusController): unknown;
};

interface SidebarMenusControllerHost
  extends ReactiveControllerHost, SessionOrganizerControllerHost {
  readonly activeRouteId?: NavigationRouteId;
  readonly activeWorkboardBoardId: string;
  readonly basePath: string;
  readonly canPairDevice: boolean;
  readonly connected: boolean;
  readonly offline: boolean;
  readonly enabledRouteIds?: readonly NavigationRouteId[];
  readonly gatewayVersion: string | null;
  readonly onNavigate?: (
    routeId: NavigationRouteId,
    options?: ApplicationNavigationOptions,
  ) => void;
  readonly onPairMobile?: () => void;
  readonly onRetryConnect?: () => void;
  readonly onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;
  readonly pinnedAgentIds: readonly string[];
  readonly selectedSessionKeys: ReadonlySet<string>;
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
  readonly terminalAvailable: boolean;
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
  getRouteSessionKey(): string;
  getSessionNavigationState(): { selectedAgentId: string };
  reconciledSidebarZone(): {
    entries: readonly SidebarZoneEntry[];
    sidebarEntries: readonly string[];
  };
  selectedVisibleSessions(): SidebarRecentSession[];
  switchChipAgent(agentId: string): void;
}

/** Popup ownership and stateless menu-renderer wiring. */
export class SidebarMenusController implements ReactiveController, SidebarMenusControllerState {
  customizeMenuPosition: { x: number; y: number } | null = null;
  moreMenuPosition: { x: number; y: number } | null = null;
  sessionMenu: SidebarSessionMenuState | null = null;
  sessionMenuWork: SessionMenuWork | null = null;
  sessionGroupMenu: SidebarSessionGroupMenuState | null = null;
  sessionSortMenuPosition: { x: number; y: number } | null = null;
  agentMenuPosition: { x: number; bottom: number } | null = null;
  agentMenuFilter = "";
  // Anchored by its bottom edge so the footer menu grows upward regardless of height.
  identityMenuPosition: { x: number; bottom: number; width: number } | null = null;

  customizeMenuTrigger: HTMLElement | null = null;
  moreMenuTrigger: HTMLElement | null = null;
  sessionMenuTrigger: HTMLElement | null = null;
  private sessionMenuWorkVersion = 0;
  sessionGroupMenuTrigger: HTMLElement | null = null;
  sessionSortMenuTrigger: HTMLElement | null = null;
  agentMenuTrigger: HTMLElement | null = null;
  identityMenuTrigger: HTMLElement | null = null;
  private readonly routePreloadTimers = new Map<
    EventTarget,
    ReturnType<typeof globalThis.setTimeout>
  >();
  private menuRenderer: SidebarMenusRenderer | null = null;
  // Popup rendering pulls Web Awesome menu code out of startup JS. It preloads
  // at idle and is requested immediately by the first menu interaction.
  private readonly menuRendererImport = createIdleImport(
    () => import("./sidebar-menus-render.ts"),
    (renderer) => {
      this.menuRenderer = renderer;
      this.host.requestUpdate();
    },
  );
  readonly catalogMenu: SidebarCatalogMenuController;

  constructor(readonly host: SidebarMenusControllerHost) {
    host.addController(this);
    this.catalogMenu = new SidebarCatalogMenuController({
      // Closing every transient menu keeps one popover at a time.
      beforeOpen: () => void this.dismissTransientMenus(),
      requestUpdate: () => host.requestUpdate(),
      terminalAvailable: () => host.terminalAvailable,
      navigate: (search) => host.onNavigate?.("chat", { search }),
    });
  }

  hostConnected(): void {
    this.menuRendererImport.schedule();
  }

  hostDisconnected(): void {
    this.menuRendererImport.dispose();
    for (const timer of this.routePreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.routePreloadTimers.clear();
  }

  private updateState<Key extends keyof SidebarMenusControllerState>(
    key: Key,
    value: SidebarMenusControllerState[Key],
  ): void {
    Object.assign(this, { [key]: value });
    this.host.requestUpdate();
  }

  preloadMenuRenderer() {
    return this.menuRendererImport.load();
  }

  private loadMenuRenderer() {
    void this.preloadMenuRenderer().catch(() => undefined);
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
      this.agentMenuPosition ||
      this.identityMenuPosition,
    );
    this.closeCustomizeMenu();
    this.closeMoreMenu();
    this.closeSessionMenu();
    this.catalogMenu.close();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.closeAgentMenu();
    this.closeIdentityMenu();
    return hadTransientMenu;
  }

  preloadRoute(routeId: NavigationRouteId, event: Event, immediate = false) {
    scheduleRoutePreload(
      this.routePreloadTimers,
      routeId,
      event,
      (nextRouteId) => this.host.onPreloadRoute?.(nextRouteId),
      routeId === this.host.activeRouteId || !this.isRouteEnabled(routeId),
      immediate,
    );
  }

  readonly cancelPreload = (event: Event) => {
    cancelRoutePreload(this.routePreloadTimers, event);
  };

  isRouteEnabled(routeId: NavigationRouteId): boolean {
    return this.host.enabledRouteIds?.includes(routeId) ?? true;
  }

  readonly openCustomizeMenuFromContext = (event: MouseEvent) => {
    event.preventDefault();
    this.openCustomizeMenu(event.clientX, event.clientY);
  };

  openCustomizeMenu(x: number, y: number, trigger: HTMLElement | null = null) {
    const menuWidth = 240;
    const menuMaxHeight = 420;
    this.loadMenuRenderer();
    this.dismissTransientMenus();
    this.customizeMenuTrigger = trigger;
    this.updateState("customizeMenuPosition", {
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuMaxHeight - 8)),
    });
  }

  closeCustomizeMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.customizeMenuTrigger;
    this.customizeMenuTrigger = null;
    this.updateState("customizeMenuPosition", null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  toggleMoreMenu(trigger: HTMLElement) {
    if (this.moreMenuPosition) {
      this.closeMoreMenu();
      return;
    }
    this.loadMenuRenderer();
    const menuWidth = 240;
    const menuMaxHeight = 420;
    const rect = trigger.getBoundingClientRect();
    this.dismissTransientMenus();
    this.moreMenuTrigger = trigger;
    this.updateState("moreMenuPosition", {
      x: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuMaxHeight - 8)),
    });
  }

  closeMoreMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.moreMenuTrigger;
    this.moreMenuTrigger = null;
    this.updateState("moreMenuPosition", null);
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
    if (!this.host.selectedSessionKeys.has(session.key)) {
      this.host.clearSessionSelection();
    }
    this.showSessionMenu(session, x, y, trigger);
  }

  private showSessionMenu(
    session: SidebarRecentSession,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ) {
    this.loadMenuRenderer();
    this.dismissTransientMenus();
    this.sessionMenuTrigger = trigger;
    this.updateState("sessionMenu", { session, x, y });
    this.loadSessionMenuWork(session);
  }

  closeSessionMenu() {
    this.sessionMenuTrigger = null;
    this.sessionMenuWorkVersion += 1;
    this.updateState("sessionMenu", null);
    this.updateState("sessionMenuWork", null);
  }

  private loadSessionMenuWork(session: SidebarRecentSession) {
    const version = ++this.sessionMenuWorkVersion;
    if (!session.worktreeId) {
      this.updateState("sessionMenuWork", null);
      return;
    }
    this.updateState("sessionMenuWork", {
      loading: true,
      pullRequestUrl: null,
      worktreePath: null,
    });
    const context = this.host.sessionDataContext;
    const client = context?.gateway.snapshot.client;
    if (!context || !client) {
      this.updateState("sessionMenuWork", {
        loading: false,
        pullRequestUrl: null,
        worktreePath: null,
      });
      return;
    }
    const { selectedAgentId } = this.host.getSessionNavigationState();
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
        this.updateState("sessionMenuWork", { loading: false, ...work });
      }
    });
  }

  openSessionGroupMenu(group: string, x: number, y: number, trigger: HTMLElement | null) {
    const menuWidth = 224;
    const menuMaxHeight = 160;
    this.loadMenuRenderer();
    this.dismissTransientMenus();
    this.sessionGroupMenuTrigger = trigger;
    this.updateState("sessionGroupMenu", {
      group,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuMaxHeight - 8)),
    });
  }

  closeSessionGroupMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.sessionGroupMenuTrigger;
    this.sessionGroupMenuTrigger = null;
    this.updateState("sessionGroupMenu", null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  toggleSessionSortMenu(trigger: HTMLElement) {
    if (this.sessionSortMenuPosition) {
      this.closeSessionSortMenu();
      return;
    }
    this.loadMenuRenderer();
    const menuWidth = 200;
    const menuMaxHeight = 280;
    const rect = trigger.getBoundingClientRect();
    this.dismissTransientMenus();
    this.sessionSortMenuTrigger = trigger;
    this.updateState("sessionSortMenuPosition", {
      x: Math.max(8, Math.min(rect.right, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuMaxHeight - 8)),
    });
  }

  closeSessionSortMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.sessionSortMenuTrigger;
    this.sessionSortMenuTrigger = null;
    this.updateState("sessionSortMenuPosition", null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  toggleAgentMenu(trigger: HTMLElement) {
    if (this.agentMenuPosition) {
      this.closeAgentMenu();
      return;
    }
    this.loadMenuRenderer();
    const menuWidth = 240;
    const rect = trigger.getBoundingClientRect();
    this.closeCustomizeMenu();
    this.closeMoreMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.closeIdentityMenu();
    this.agentMenuTrigger = trigger;
    this.updateState("agentMenuFilter", "");
    this.updateState("agentMenuPosition", {
      x: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 4),
    });
  }

  closeAgentMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.agentMenuTrigger;
    this.agentMenuTrigger = null;
    this.updateState("agentMenuPosition", null);
    this.updateState("agentMenuFilter", "");
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  setAgentMenuFilter(next: string) {
    this.updateState("agentMenuFilter", next);
  }

  toggleIdentityMenu(trigger: HTMLElement) {
    if (this.identityMenuPosition) {
      this.closeIdentityMenu();
      return;
    }
    this.loadMenuRenderer();
    const rect = trigger.getBoundingClientRect();
    const menuWidth = Math.max(240, rect.width);
    this.dismissTransientMenus();
    this.identityMenuTrigger = trigger;
    this.updateState("identityMenuPosition", {
      x: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 4),
      width: rect.width,
    });
  }

  closeIdentityMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.identityMenuTrigger;
    this.identityMenuTrigger = null;
    this.updateState("identityMenuPosition", null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  renderCustomizeMenu() {
    return this.menuRenderer?.renderSidebarCustomizeMenuForController(this) ?? nothing;
  }

  renderAgentMenu() {
    return this.menuRenderer?.renderSidebarAgentMenuForController(this) ?? nothing;
  }

  renderIdentityMenu() {
    return this.menuRenderer?.renderSidebarIdentityMenuForController(this) ?? nothing;
  }

  renderSessionMenu() {
    return this.menuRenderer?.renderSidebarSessionMenuForController(this) ?? nothing;
  }

  renderSessionGroupMenu() {
    return this.menuRenderer?.renderSidebarSessionGroupMenuForController(this) ?? nothing;
  }

  renderSessionSortMenu() {
    return this.menuRenderer?.renderSidebarSessionSortMenuForController(this) ?? nothing;
  }

  renderRoute(routeId: NavigationRouteId) {
    if (!this.isRouteEnabled(routeId)) {
      return nothing;
    }
    const routeSessionKey = routeId === "chat" ? this.host.getRouteSessionKey() : "";
    const chatSearch =
      routeId === "chat" && routeSessionKey ? searchForSession(routeSessionKey) : "";
    return renderSidebarNavRoute({
      routeId,
      href: chatSearch
        ? `${pathForRoute("chat", this.host.basePath)}${chatSearch}`
        : pathForRoute(routeId, this.host.basePath),
      active:
        isSidebarRouteActive(this.host.activeRouteId, routeId) &&
        !(routeId === "workboard" && this.activeWorkboardBoardIsPinned()),
      onNavigate: () => {
        this.host.onNavigate?.(routeId, chatSearch ? { search: chatSearch } : undefined);
      },
      onPreload: (event, immediate) => this.preloadRoute(routeId, event, immediate),
      onCancelPreload: this.cancelPreload,
    });
  }

  renderMoreMenu() {
    return this.menuRenderer?.renderSidebarMoreMenuForController(this) ?? nothing;
  }

  private activeWorkboardBoardIsPinned(): boolean {
    return Boolean(
      this.host.activeWorkboardBoardId &&
      this.host
        .reconciledSidebarZone()
        .entries.some(
          (entry) =>
            entry.type === "workboard" && entry.boardId === this.host.activeWorkboardBoardId,
        ),
    );
  }
}
