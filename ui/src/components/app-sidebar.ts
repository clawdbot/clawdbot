import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionsListResult, UpdateAvailable } from "../api/types.ts";
import {
  cancelRoutePreload,
  DEFAULT_SIDEBAR_PINNED_ROUTES,
  scheduleRoutePreload,
  type NavigationRouteId,
  type SidebarNavRoute,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationNavigationOptions,
} from "../app/context.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import "./menu-surface.ts";
import "./session-menu.ts";
import "./sidebar-agent-chip.ts";
import "./sidebar-attention.ts";
import "./sidebar-build-chip.ts";
import "./sidebar-update-card.ts";
import "./theme-mode-toggle.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import "./tooltip.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { editorOpenUrl } from "../lib/editor-links.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { startHoverMarquee, stopHoverMarquee } from "../lib/hover-marquee.ts";
import {
  channelDisplayLabel,
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkSubtitle,
} from "../lib/session-display.ts";
import {
  CATALOG_SESSION_CONTINUED_EVENT,
  type CatalogSessionContinuedDetail,
} from "../lib/sessions/catalog-key.ts";
import { reorderSessionCustomGroups } from "../lib/sessions/custom-groups.ts";
import {
  readSessionDragData,
  readSessionGroupDragData,
  sessionDragActive,
  sessionGroupDragActive,
  writeSessionDragData,
  writeSessionGroupDragData,
} from "../lib/sessions/drag.ts";
import {
  groupSidebarSessionRows,
  normalizeSidebarSessionsGrouping,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import {
  compareSessionRowsByUpdatedAt,
  filterVisibleSessionRows,
  resolveSessionNavigation,
  searchForSession,
  type SessionCapability,
} from "../lib/sessions/index.ts";
import {
  buildAgentMainSessionKey,
  canArchiveSessionRow,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import { renderSidebarAgentMenu } from "./app-sidebar-agent-menu.ts";
import {
  isSidebarRouteActive,
  renderSidebarCustomizeMenu,
  renderSidebarMoreMenu,
  renderSidebarMoreRow,
  renderSidebarNavRoute,
  shouldHandleNavigationClick,
  sidebarMoreMenuHoldsActiveRoute,
  sidebarPluginTabs,
} from "./app-sidebar-nav-menus.ts";
import {
  mergeCatalogSessionRows,
  mergeSessionCatalogPage,
  preserveExpandedCatalogHost,
  sessionCatalogRequestError,
} from "./app-sidebar-session-catalog-state.ts";
import {
  adoptedCatalogSessionKeys,
  bindAdoptedCatalogSession,
  type CatalogBackingSessionDisplay,
  formatSidebarTimestamp,
  renderSessionCatalogGroups,
} from "./app-sidebar-session-catalogs.ts";
import { icons } from "./icons.ts";
import {
  LOBSTER_LOGO_VISIT_EVENT,
  LOBSTER_PET_BUILD_MULS,
  LOBSTER_PET_CLAW_MULS,
  lobsterPetSeed,
  renderLobsterSvg,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
  type LobsterLogoVisitDetail,
} from "./lobster-pet.ts";
import { fetchSessionMenuWork } from "./session-menu-work.ts";
import type { SessionMenuAction, SessionMenuWork } from "./session-menu.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";
import { consumeDropdownKeyboardDismissal, trackDropdownKeyboardDismissal } from "./web-awesome.ts";

type SidebarRecentSession = {
  key: string;
  label: string;
  meta: string;
  /** Compact repo/branch/node line for work sessions. */
  subtitle?: string;
  href: string;
  active: boolean;
  visuallyActive: boolean;
  hasActiveRun: boolean;
  modelSelectionLocked: boolean;
  kind?: string;
  pinned: boolean;
  category?: string;
  channel?: string;
  channelSession?: boolean;
  workSession?: boolean;
  worktreeId?: string;
  hasAutomation: boolean;
  unread: boolean;
};

type SidebarSessionMenuState = {
  session: SidebarRecentSession;
  x: number;
  y: number;
};

type SidebarSessionGroupMenuState = {
  group: string;
  x: number;
  y: number;
};

type SidebarSessionSortMode = "created" | "updated";
type SidebarSessionsScrollState = "none" | "top" | "middle" | "bottom";
type SidebarSessionGroupDropTarget = {
  group: string;
  position: "before" | "after";
};

type SidebarSessionMutationScope = {
  epoch: number;
  context: ApplicationContext<RouteId>;
  gateway: ApplicationContext<RouteId>["gateway"];
  sessions: SessionCapability;
  client: GatewayBrowserClient;
  selectedAgentId: string;
};

type SidebarSessionMutationResult = "completed" | "failed" | "stale";

const SIDEBAR_SESSION_GROUPING_STORAGE_KEY = "openclaw:sidebar:sessions:grouping";
const SIDEBAR_SESSION_SHOW_CRON_STORAGE_KEY = "openclaw:sidebar:sessions:show-cron";
const SIDEBAR_AGENT_SESSION_LIST_LIMIT = 60;
const SIDEBAR_SESSION_PAGE_SIZE = 10;
const SIDEBAR_SESSION_SEE_LESS_THRESHOLD = 30;
const SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY =
  "openclaw:sidebar:sessions:collapsed-sections";

function limitSidebarSessionRows(rows: SidebarRecentSession[], limit: number) {
  const requiredCount = rows.filter((row) => row.active || row.pinned).length;
  let optionalSlots = Math.max(0, limit - requiredCount);
  // Active and pinned sessions remain reachable without changing their
  // relative order, even when their sort position falls outside the page.
  return rows.filter((row) => {
    if (row.active || row.pinned) {
      return true;
    }
    if (optionalSlots === 0) {
      return false;
    }
    optionalSlots -= 1;
    return true;
  });
}

const PALETTE_SHORTCUT = /Mac|iP(hone|ad|od)/i.test(globalThis.navigator?.platform ?? "")
  ? "⌘K"
  : "Ctrl K";

function loadStoredSidebarSessionsGrouping(): SidebarSessionsGrouping {
  return normalizeSidebarSessionsGrouping(
    getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_GROUPING_STORAGE_KEY),
  );
}

function loadStoredSidebarSessionsShowCron(): boolean {
  return getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_SHOW_CRON_STORAGE_KEY) === "true";
}

function loadStoredCollapsedSessionSections(): ReadonlySet<string> {
  try {
    const raw = getSafeLocalStorage()?.getItem(SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.flatMap((value) => (typeof value === "string" && value ? [value] : []))
        : [],
    );
  } catch {
    return new Set();
  }
}

const SIDEBAR_SESSION_SORT_OPTIONS = [
  { mode: "created", labelKey: "chat.sidebar.sortCreated" },
  { mode: "updated", labelKey: "chat.sidebar.sortUpdated" },
] as const satisfies ReadonlyArray<{
  mode: SidebarSessionSortMode;
  labelKey: "chat.sidebar.sortCreated" | "chat.sidebar.sortUpdated";
}>;

function sessionCatalogHostKey(catalogId: string, hostId: string): string {
  return `${catalogId}\u0000${hostId}`;
}

class AppSidebar extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) activeRouteId?: NavigationRouteId;
  @property({ attribute: false }) activePluginTabId = "";
  @property({ attribute: false }) enabledRouteIds?: readonly NavigationRouteId[];
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) canPairDevice = false;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) sidebarPinnedRoutes: readonly SidebarNavRoute[] =
    DEFAULT_SIDEBAR_PINNED_ROUTES;
  /** Agents surfaced first in the chip quick switcher when many exist. */
  @property({ attribute: false }) pinnedAgentIds: readonly string[] = [];
  @property({ attribute: false }) themeMode: ThemeMode = "system";
  @property({ attribute: false }) lobsterPetVisits = true;
  @property({ attribute: false }) lobsterPetSounds = false;
  @property({ attribute: false }) gatewayVersion: string | null = null;
  @property({ attribute: false }) devGitBranch: string | null = null;
  @property({ attribute: false }) updateAvailable: UpdateAvailable | null = null;
  @property({ attribute: false }) updateRunning = false;
  @property({ attribute: false }) onUpdate: () => void = () => undefined;
  @property({ attribute: false }) onOpenPalette?: () => void;
  @property({ attribute: false }) onToggleSidebar?: () => void;
  @property({ attribute: false }) onOpenNewSession?: (
    agentId: string,
    target?: NewSessionTarget,
  ) => void;
  /** Agent id of the in-flight new-session draft; renders the draft row. */
  @property({ attribute: false }) draftSessionAgentId = "";
  @property({ attribute: false }) onUpdatePinnedRoutes?: (routes: SidebarNavRoute[]) => void;
  @property({ attribute: false }) onPairMobile?: () => void;
  @property({ attribute: false })
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  @property({ attribute: false }) onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext<RouteId>;
  @state() private customizeMenuPosition: { x: number; y: number } | null = null;
  @state() private moreMenuPosition: { x: number; y: number } | null = null;
  @state() private sessionMenu: SidebarSessionMenuState | null = null;
  // Multi-select set for batch menu actions; stale keys are dropped lazily by
  // selectedVisibleSessions() so list refreshes never need to prune here.
  @state() private selectedSessionKeys: ReadonlySet<string> = new Set();
  private sessionSelectionAnchor: string | null = null;
  @state() private sessionMenuWork: SessionMenuWork | null = null;
  @state() private sessionGroupMenu: SidebarSessionGroupMenuState | null = null;
  @state() private draggingSessionKey: string | null = null;
  @state() private draggingSessionGroup: string | null = null;
  @state() private sessionDropTarget: string | null = null;
  @state() private sessionGroupDropTarget: SidebarSessionGroupDropTarget | null = null;
  @state() private collapsedSessionSections = loadStoredCollapsedSessionSections();
  @state() private sessionSortMode: SidebarSessionSortMode = "created";
  @state() private sessionsGrouping: SidebarSessionsGrouping = loadStoredSidebarSessionsGrouping();
  @state() private sessionsShowCron = loadStoredSidebarSessionsShowCron();
  @state() private sessionSortMenuPosition: { x: number; y: number } | null = null;
  // Anchored by its bottom edge so the footer menu grows upward regardless of height.
  @state() private agentMenuPosition: { x: number; bottom: number } | null = null;
  @state() private agentMenuFilter = "";
  @state() private visibleSessionLimit = SIDEBAR_SESSION_PAGE_SIZE;
  @state() private sessionsResult: SessionsListResult | null = null;
  @state() private sessionsAgentId: string | null = null;
  @state() private sessionsLoading = false;
  @state() private sessionsScrollState: SidebarSessionsScrollState = "none";
  @state() private sessionCatalogs: SessionCatalog[] = [];
  @state() private loadingMoreSessionCatalogIds: ReadonlySet<string> = new Set();
  @state() private sessionMutationError: string | null = null;
  @state() private logoVisit: LobsterLogoVisitDetail | null = null;

  private readonly subscriptions = new SubscriptionsController(this);
  private customizeMenuTrigger: HTMLElement | null = null;
  private moreMenuTrigger: HTMLElement | null = null;
  private sessionMenuTrigger: HTMLElement | null = null;
  // Guards the async work fetch: a menu reopened for another session must not
  // adopt a stale response.
  private sessionMenuWorkVersion = 0;
  private sessionGroupMenuTrigger: HTMLElement | null = null;
  private sessionSortMenuTrigger: HTMLElement | null = null;
  private agentMenuTrigger: HTMLElement | null = null;
  private sessionRowsByAgent: Record<string, SessionsListResult["sessions"]> = {};
  private sessionCreatedOrder = new Map<string, number>();
  private sessionsSource: SessionCapability | null = null;
  private reconnectListRevision: number | null = null;
  private gatewaySource: ApplicationContext<RouteId>["gateway"] | null = null;
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  // Mutation completions belong to one context/capability/connection epoch.
  // Bumping this prevents old failures or batch tails crossing a reconnect.
  private sessionMutationEpoch = 0;
  private sessionsScrollElement: HTMLElement | null = null;
  private sessionsScrollResizeObserver: ResizeObserver | null = null;
  private sessionCatalogTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private sessionCatalogAgentId: string | null = null;
  private sessionCatalogGeneration = 0;
  private sessionCatalogRevision = 0;
  private sessionCatalogRequestGeneration: number | null = null;
  private readonly sessionCatalogPageDepths = new Map<string, number>();
  private readonly sessionCatalogRevisions = new Map<string, number>();
  private readonly routePreloadTimers = new Map<
    EventTarget,
    ReturnType<typeof globalThis.setTimeout>
  >();

  constructor() {
    super();
    // Host listener: the footer pet announces logo stand-in phases (bubbling
    // custom event) and the brand slot here renders the swap.
    this.addEventListener(LOBSTER_LOGO_VISIT_EVENT, this.handleLogoVisit as EventListener);
    this.subscriptions
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.synchronizeGateway(gateway),
      )
      .watch(
        () => this.context?.sessions,
        (sessions, notify) => sessions.subscribe(notify),
        (sessions) => this.synchronizeSessions(sessions),
      )
      .effect(
        () => this.context?.sessions,
        (sessions) => sessions.subscribeCreated((key) => this.promoteCreatedSession(key)),
      )
      .watch(
        () => this.context?.agents,
        (agents, notify) => agents.subscribe(notify),
      )
      .watch(
        () => this.context?.agentSelection,
        (agentSelection, notify) => agentSelection.subscribe(notify),
      );
  }

  override connectedCallback() {
    super.connectedCallback();
    // Document listener: the chat pane announces catalog adoptions so the
    // catalog row binds to the new session key before the next catalog poll.
    document.addEventListener(
      CATALOG_SESSION_CONTINUED_EVENT,
      this.handleCatalogSessionContinued as EventListener,
    );
  }

  override disconnectedCallback() {
    document.removeEventListener(
      CATALOG_SESSION_CONTINUED_EVENT,
      this.handleCatalogSessionContinued as EventListener,
    );
    this.dismissTransientMenus();
    this.invalidateSessionMutations();
    this.gatewaySource = null;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    this.sessionCatalogGeneration += 1;
    for (const timer of this.routePreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.routePreloadTimers.clear();
    this.sessionsScrollResizeObserver?.disconnect();
    this.sessionsScrollResizeObserver = null;
    this.sessionsScrollElement = null;
    if (this.sessionCatalogTimer) {
      globalThis.clearTimeout(this.sessionCatalogTimer);
      this.sessionCatalogTimer = null;
    }
    super.disconnectedCallback();
  }

  override updated() {
    this.syncSessionsScrollObserver();
    const snapshot = this.context?.gateway.snapshot;
    if (this.context) {
      this.synchronizeSessionCatalogAgent(this.expandedAgentId());
    }
    if (
      !snapshot?.connected ||
      !snapshot.client ||
      isGatewayMethodAdvertised(snapshot, "sessions.catalog.list") !== true ||
      this.sessionCatalogTimer ||
      this.sessionCatalogRequestGeneration === this.sessionCatalogGeneration
    ) {
      return;
    }
    void this.refreshSessionCatalogs();
  }

  private synchronizeSessionCatalogAgent(agentId: string) {
    if (agentId === this.sessionCatalogAgentId) {
      return;
    }
    this.sessionCatalogAgentId = agentId;
    this.sessionCatalogGeneration += 1;
    this.sessionCatalogRevision += 1;
    this.loadingMoreSessionCatalogIds = new Set();
    if (this.sessionCatalogTimer) {
      globalThis.clearTimeout(this.sessionCatalogTimer);
      this.sessionCatalogTimer = null;
    }
    if (this.sessionCatalogs.some((catalog) => catalog.capabilities.createSession)) {
      this.sessionCatalogs = this.sessionCatalogs.map((catalog) => {
        const { createSession: _createSession, ...capabilities } = catalog.capabilities;
        return { ...catalog, capabilities };
      });
    }
  }

  private readonly handleCatalogSessionContinued = (
    event: CustomEvent<CatalogSessionContinuedDetail>,
  ) => {
    const detail = event.detail;
    if (!detail?.sessionKey) {
      return;
    }
    this.sessionCatalogs = bindAdoptedCatalogSession(this.sessionCatalogs, detail);
    // Invalidate in-flight polls and load-more merges so a pre-adoption
    // snapshot cannot clobber the patched rows; the 30s poll reconfirms.
    this.sessionCatalogRevision += 1;
    this.sessionCatalogRevisions.set(
      detail.catalogId,
      (this.sessionCatalogRevisions.get(detail.catalogId) ?? 0) + 1,
    );
  };

  private async refreshSessionCatalogs() {
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.connected) {
      return;
    }
    const generation = this.sessionCatalogGeneration;
    const revision = this.sessionCatalogRevision;
    const agentId = this.sessionCatalogAgentId ?? this.expandedAgentId();
    if (this.sessionCatalogRequestGeneration === generation) {
      return;
    }
    this.sessionCatalogRequestGeneration = generation;
    try {
      const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
        agentId,
        limitPerHost: 40,
      });
      if (generation !== this.sessionCatalogGeneration || client !== this.gatewayClient) {
        return;
      }
      const catalogs = await this.refetchSessionCatalogPages({
        catalogs: result.catalogs,
        client,
        generation,
        agentId,
      });
      if (
        generation !== this.sessionCatalogGeneration ||
        revision !== this.sessionCatalogRevision ||
        client !== this.gatewayClient
      ) {
        return;
      }
      const revisedCatalogIds = new Set([
        ...this.sessionCatalogs.map((catalog) => catalog.id),
        ...catalogs.map((catalog) => catalog.id),
      ]);
      this.sessionCatalogs = catalogs;
      for (const catalogId of revisedCatalogIds) {
        this.sessionCatalogRevisions.set(
          catalogId,
          (this.sessionCatalogRevisions.get(catalogId) ?? 0) + 1,
        );
      }
      this.sessionCatalogRevision += 1;
    } catch {
      // A transient poll failure must not collapse already visible or expanded pages.
    } finally {
      if (this.sessionCatalogRequestGeneration === generation) {
        this.sessionCatalogRequestGeneration = null;
      }
      if (
        generation === this.sessionCatalogGeneration &&
        client === this.gatewayClient &&
        this.isConnected
      ) {
        this.sessionCatalogTimer = globalThis.setTimeout(() => {
          this.sessionCatalogTimer = null;
          void this.refreshSessionCatalogs();
        }, 30_000);
      }
    }
  }

  private async refetchSessionCatalogPages(params: {
    catalogs: SessionCatalog[];
    client: GatewayBrowserClient;
    generation: number;
    agentId: string;
  }): Promise<SessionCatalog[]> {
    const previousCatalogs = new Map(this.sessionCatalogs.map((catalog) => [catalog.id, catalog]));
    return Promise.all(
      params.catalogs.map(async (catalog) => {
        const previousHosts = new Map(
          previousCatalogs.get(catalog.id)?.hosts.map((host) => [host.hostId, host]) ?? [],
        );
        const hosts = await Promise.all(
          catalog.hosts.map(async (host) => {
            const key = sessionCatalogHostKey(catalog.id, host.hostId);
            const pageDepth = this.sessionCatalogPageDepths.get(key) ?? 0;
            if (pageDepth === 0) {
              return host;
            }
            const previous = previousHosts.get(host.hostId);
            if (host.error) {
              return preserveExpandedCatalogHost(host, previous);
            }
            let sessions = host.sessions;
            let nextCursor = host.nextCursor;
            let loadedPages = 0;
            for (; loadedPages < pageDepth && nextCursor; loadedPages += 1) {
              let result: SessionsCatalogListResult;
              try {
                result = await params.client.request<SessionsCatalogListResult>(
                  "sessions.catalog.list",
                  {
                    agentId: params.agentId,
                    catalogId: catalog.id,
                    cursors: { [host.hostId]: nextCursor },
                  },
                );
              } catch {
                return previous ?? host;
              }
              if (
                params.generation !== this.sessionCatalogGeneration ||
                params.client !== this.gatewayClient
              ) {
                return previous ?? host;
              }
              const pageHost = result.catalogs
                .find((candidate) => candidate.id === catalog.id)
                ?.hosts.find((candidate) => candidate.hostId === host.hostId);
              if (!pageHost) {
                return previous ?? host;
              }
              if (pageHost.error) {
                return preserveExpandedCatalogHost({ ...host, ...pageHost }, previous ?? host);
              }
              sessions = mergeCatalogSessionRows(sessions, pageHost.sessions);
              nextCursor = pageHost.nextCursor;
            }
            const {
              nextCursor: _firstPageCursor,
              sessions: _firstPageSessions,
              ...freshHost
            } = host;
            return {
              ...freshHost,
              sessions,
              ...(nextCursor ? { nextCursor } : {}),
            };
          }),
        );
        return { ...catalog, hosts };
      }),
    );
  }

  private async loadMoreSessionCatalog(catalogId: string) {
    if (this.loadingMoreSessionCatalogIds.has(catalogId)) {
      return;
    }
    const catalog = this.sessionCatalogs.find((candidate) => candidate.id === catalogId);
    const cursors = Object.fromEntries(
      (catalog?.hosts ?? []).flatMap((host) =>
        host.nextCursor ? [[host.hostId, host.nextCursor] as const] : [],
      ),
    );
    if (!catalog || Object.keys(cursors).length === 0) {
      return;
    }
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.connected) {
      return;
    }
    const generation = this.sessionCatalogGeneration;
    const agentId = this.sessionCatalogAgentId ?? this.expandedAgentId();
    const revision = this.sessionCatalogRevisions.get(catalogId) ?? 0;
    this.loadingMoreSessionCatalogIds = new Set([...this.loadingMoreSessionCatalogIds, catalogId]);
    try {
      const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
        agentId,
        catalogId,
        cursors,
      });
      if (
        generation !== this.sessionCatalogGeneration ||
        revision !== (this.sessionCatalogRevisions.get(catalogId) ?? 0) ||
        client !== this.gatewayClient
      ) {
        return;
      }
      const page = result.catalogs.find((candidate) => candidate.id === catalogId);
      if (!page) {
        return;
      }
      const current = this.sessionCatalogs.find((candidate) => candidate.id === catalogId);
      if (!current) {
        return;
      }
      const merged = mergeSessionCatalogPage({ current, page, cursors });
      for (const hostId of merged.advancedHostIds) {
        const key = sessionCatalogHostKey(catalogId, hostId);
        this.sessionCatalogPageDepths.set(key, (this.sessionCatalogPageDepths.get(key) ?? 0) + 1);
      }
      this.sessionCatalogs = this.sessionCatalogs.map((candidate) =>
        candidate.id === catalogId ? merged.catalog : candidate,
      );
      this.sessionCatalogRevisions.set(catalogId, revision + 1);
      this.sessionCatalogRevision += 1;
    } catch (error) {
      if (
        generation !== this.sessionCatalogGeneration ||
        revision !== (this.sessionCatalogRevisions.get(catalogId) ?? 0) ||
        client !== this.gatewayClient
      ) {
        return;
      }
      // Preserve rows and cursors: the visible error explains that retrying
      // Load More will request the same page rather than advancing past it.
      this.sessionCatalogs = this.sessionCatalogs.map((candidate) =>
        candidate.id === catalogId
          ? { ...candidate, error: sessionCatalogRequestError(error) }
          : candidate,
      );
      this.sessionCatalogRevisions.set(catalogId, revision + 1);
      this.sessionCatalogRevision += 1;
    } finally {
      if (generation === this.sessionCatalogGeneration) {
        const loading = new Set(this.loadingMoreSessionCatalogIds);
        loading.delete(catalogId);
        this.loadingMoreSessionCatalogIds = loading;
      }
    }
  }

  private syncSessionsScrollObserver() {
    const element = this.querySelector<HTMLElement>(".sidebar-recent-sessions");
    if (element !== this.sessionsScrollElement) {
      this.sessionsScrollResizeObserver?.disconnect();
      this.sessionsScrollElement = element;
      this.sessionsScrollResizeObserver = null;
      if (element && typeof ResizeObserver === "function") {
        this.sessionsScrollResizeObserver = new ResizeObserver(() =>
          this.updateSessionsScrollState(element),
        );
        this.sessionsScrollResizeObserver.observe(element);
      }
    }
    if (element) {
      this.updateSessionsScrollState(element);
    }
  }

  private updateSessionsScrollState(element: HTMLElement) {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    let nextState: SidebarSessionsScrollState = "none";
    if (maxScrollTop > 1) {
      if (element.scrollTop <= 1) {
        nextState = "top";
      } else if (element.scrollTop >= maxScrollTop - 1) {
        nextState = "bottom";
      } else {
        nextState = "middle";
      }
    }
    if (nextState !== this.sessionsScrollState) {
      this.sessionsScrollState = nextState;
    }
  }

  // The shell calls this before CSS hides the panel or drawer. Mounted menus
  // keep their document-level shortcuts alive even when an ancestor is hidden.
  dismissTransientMenus(): boolean {
    const hadTransientMenu = Boolean(
      this.customizeMenuPosition ||
      this.moreMenuPosition ||
      this.sessionMenu ||
      this.sessionGroupMenu ||
      this.sessionSortMenuPosition ||
      this.agentMenuPosition,
    );
    this.closeCustomizeMenu();
    this.closeMoreMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.closeAgentMenu();
    return hadTransientMenu;
  }

  private readonly updateSessions = (sessions: SessionCapability) => {
    const snapshot = sessions.state;
    const gateway = this.context?.gateway;
    const sameClientDisconnected =
      gateway !== undefined &&
      gateway === this.gatewaySource &&
      gateway.snapshot.client !== null &&
      gateway.snapshot.client === this.gatewayClient &&
      !gateway.snapshot.connected;
    if (sameClientDisconnected && this.reconnectListRevision === null) {
      this.reconnectListRevision = sessions.canonicalListRevision + 1;
    }
    const waitingForReconnectList =
      this.reconnectListRevision !== null &&
      sessions.canonicalListRevision < this.reconnectListRevision;
    if (!sameClientDisconnected && !waitingForReconnectList) {
      // Keep the result and agent scope paired until the first canonical list
      // after reconnect; chat startup may publish a partial reconciliation first.
      this.reconnectListRevision = null;
      this.sessionsResult = snapshot.result;
      this.sessionsAgentId = snapshot.agentId;
      if (snapshot.result) {
        for (const row of snapshot.result.sessions) {
          if (row.key && !this.sessionCreatedOrder.has(row.key)) {
            this.sessionCreatedOrder.set(row.key, this.sessionCreatedOrder.size);
          }
        }
      }
      if (snapshot.result && snapshot.agentId) {
        this.sessionRowsByAgent[normalizeAgentId(snapshot.agentId)] = snapshot.result.sessions;
      }
    }
    this.sessionsLoading = snapshot.loading;
  };

  private synchronizeSessions(sessions: SessionCapability) {
    if (sessions !== this.sessionsSource) {
      this.invalidateSessionMutations();
      this.clearSessionCache();
      this.sessionsSource = sessions;
    }
    this.updateSessions(sessions);
    if (this.context?.gateway.snapshot.connected) {
      // Group catalog hydration is idempotent per connection.
      void sessions.groupsLoad();
    }
  }

  private synchronizeGateway(gateway: ApplicationContext<RouteId>["gateway"]) {
    const client = gateway.snapshot.client;
    const connected = gateway.snapshot.connected;
    const sourceOrClientChanged = gateway !== this.gatewaySource || client !== this.gatewayClient;
    const connectionChanged = connected !== this.gatewayConnected;
    if (!sourceOrClientChanged && !connectionChanged) {
      return;
    }
    this.invalidateSessionMutations();
    this.gatewaySource = gateway;
    this.gatewayClient = client;
    this.gatewayConnected = connected;
    if (!sourceOrClientChanged) {
      return;
    }
    this.clearSessionCache();
    this.sessionCatalogGeneration += 1;
    this.sessionCatalogRevision += 1;
    if (this.sessionCatalogTimer) {
      globalThis.clearTimeout(this.sessionCatalogTimer);
      this.sessionCatalogTimer = null;
    }
    this.sessionCatalogs = [];
    this.loadingMoreSessionCatalogIds = new Set();
    this.sessionCatalogPageDepths.clear();
    this.sessionCatalogRevisions.clear();
  }

  private clearSessionCache() {
    this.reconnectListRevision = null;
    this.sessionsResult = null;
    this.sessionsAgentId = null;
    this.sessionRowsByAgent = {};
    this.sessionCreatedOrder.clear();
    this.visibleSessionLimit = SIDEBAR_SESSION_PAGE_SIZE;
  }

  private invalidateSessionMutations() {
    this.sessionMutationEpoch += 1;
    this.sessionMutationError = null;
  }

  private beginSessionMutation(): SidebarSessionMutationScope | null {
    const context = this.context;
    if (!context || !this.connected) {
      return null;
    }
    const gateway = context.gateway;
    const client = gateway.snapshot.client;
    if (!gateway.snapshot.connected || !client) {
      return null;
    }
    this.sessionMutationError = null;
    return {
      epoch: this.sessionMutationEpoch,
      context,
      gateway,
      sessions: context.sessions,
      client,
      selectedAgentId: this.getSessionNavigationState().selectedAgentId,
    };
  }

  private isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean {
    const context = this.context;
    const gateway = context?.gateway;
    return (
      this.connected &&
      this.sessionMutationEpoch === scope.epoch &&
      context === scope.context &&
      gateway === scope.gateway &&
      context.sessions === scope.sessions &&
      gateway.snapshot.connected &&
      gateway.snapshot.client === scope.client
    );
  }

  private publishSessionMutationError(scope: SidebarSessionMutationScope, error: unknown) {
    if (this.isSessionMutationScopeCurrent(scope)) {
      this.sessionMutationError = String(error);
    }
  }

  private readonly handleLogoVisit = (event: Event) => {
    const detail = (event as CustomEvent<LobsterLogoVisitDetail>).detail;
    this.logoVisit = detail.phase === "out" || !detail.look ? null : detail;
  };

  // Rare treat: on planned loads the footer pet's first visit perches here
  // instead, filling in for the brand mark (see lobster-pet.ts logo visits).
  private renderLogoStandIn() {
    const visit = this.logoVisit;
    if (!visit?.look) {
      return nothing;
    }
    const look = visit.look;
    const classes = [
      "sidebar-brand__pet",
      `lobster-pet--palette-${look.palette.id}`,
      visit.phase === "leaving" ? "sidebar-brand__pet--leaving" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const style = [
      `--lob-shell:${look.palette.shell}`,
      `--lob-claw:${look.palette.claw}`,
      `--lob-blink-delay:${look.blinkDelayS}s`,
      `--lob-w:${LOBSTER_PET_BUILD_MULS[look.build].w}`,
      `--lob-h:${LOBSTER_PET_BUILD_MULS[look.build].h}`,
      `--lob-claw-scale:${LOBSTER_PET_CLAW_MULS[look.clawSize]}`,
    ].join(";");
    // Native title tooltip like the ledge sprite's names: no i18n surface.
    const title = `${visit.name} · filling in for the logo`;
    return html`
      <span class=${classes} style=${style} title=${title}>${renderLobsterSvg(look)}</span>
    `;
  }

  private renderBrand() {
    const collapseLabel = t("nav.collapse");
    return html`
      <div class="sidebar-brand">
        <a
          class="sidebar-brand__identity"
          href=${pathForRoute("new-session", this.basePath)}
          aria-label=${titleForRoute("new-session")}
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.onNavigate?.("new-session");
          }}
        >
          <span class="sidebar-brand__logo-slot">
            <img
              class="sidebar-brand__logo ${this.logoVisit ? "sidebar-brand__logo--vacated" : ""}"
              src=${controlUiPublicAssetPath("apple-touch-icon.png", this.basePath)}
              alt=""
              aria-hidden="true"
            />
            ${this.renderLogoStandIn()}
          </span>
          <span class="sidebar-brand__title">OpenClaw</span>
        </a>
        <div class="sidebar-brand__actions">
          ${this.renderSearch()}
          <openclaw-tooltip .content=${`${collapseLabel} (⌘B)`}>
            <button
              class="sidebar-brand__icon sidebar-brand__collapse"
              type="button"
              @click=${() => this.onToggleSidebar?.()}
              aria-label=${collapseLabel}
              aria-expanded="true"
            >
              ${icons.panelLeftClose}
            </button>
          </openclaw-tooltip>
        </div>
      </div>
    `;
  }

  /** Command palette entry point; the palette itself is owned by the shell. */
  private renderSearch() {
    const tooltip = `${t("chat.openCommandPalette")} (${PALETTE_SHORTCUT})`;
    return html`
      <openclaw-tooltip .content=${tooltip}>
        <button
          type="button"
          class="sidebar-brand__icon sidebar-search"
          ?disabled=${!this.onOpenPalette}
          aria-label=${t("chat.openCommandPalette")}
          @click=${() => this.onOpenPalette?.()}
        >
          ${icons.search}
        </button>
      </openclaw-tooltip>
    `;
  }

  private getRouteSessionKey(): string {
    return this.sessionKey.trim() || this.context?.gateway.snapshot.sessionKey.trim() || "";
  }

  private readonly compareSidebarSessionRows = (
    a: SessionsListResult["sessions"][number],
    b: SessionsListResult["sessions"][number],
  ) => {
    if (this.sessionSortMode === "updated") {
      return compareSessionRowsByUpdatedAt(a, b);
    }
    return (
      (this.sessionCreatedOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
      (this.sessionCreatedOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER)
    );
  };

  private promoteCreatedSession(sessionKey: string) {
    const currentOrder = this.sessionCreatedOrder.get(sessionKey);
    if (currentOrder === 0) {
      return;
    }
    for (const [key, order] of this.sessionCreatedOrder) {
      if (key !== sessionKey && (currentOrder === undefined || order < currentOrder)) {
        this.sessionCreatedOrder.set(key, order + 1);
      }
    }
    this.sessionCreatedOrder.set(sessionKey, 0);
    this.requestUpdate();
  }

  private getSessionNavigationState() {
    const context = this.context;
    const routeSessionKey = this.getRouteSessionKey();
    const navigation = resolveSessionNavigation({
      result: this.sessionsResult,
      resultAgentId: this.sessionsAgentId,
      sessionKey: routeSessionKey,
      assistantAgentId:
        context?.agentSelection.state.selectedId ?? context?.gateway.snapshot.assistantAgentId,
      hello: context?.gateway.snapshot.hello,
      showCron: this.sessionsShowCron,
      compareSessions: this.compareSidebarSessionRows,
    });
    const highlightCurrentSession = this.activeRouteId === "chat";
    const toSidebarSession = (row: SessionsListResult["sessions"][number]) => {
      const channelInfo = resolveChannelSessionInfo(row.key, row.channel);
      return {
        key: row.key,
        label: resolveSessionDisplayName(row.key, row),
        meta: formatSidebarTimestamp(row.updatedAt),
        subtitle: resolveSessionWorkSubtitle(row),
        href: `${pathForRoute("chat", context?.basePath ?? "")}${searchForSession(row.key)}`,
        active: row.key === navigation.activeRowKey,
        visuallyActive: highlightCurrentSession && row.key === navigation.currentSessionKey,
        hasActiveRun: Boolean(row.hasActiveRun),
        modelSelectionLocked: row.modelSelectionLocked === true,
        kind: row.kind,
        pinned: row.pinned === true,
        category: normalizeOptionalString(row.category),
        channel: channelInfo.channel,
        channelSession: channelInfo.channelSession,
        workSession: Boolean(row.worktree || row.execNode),
        worktreeId: row.worktree?.id,
        hasAutomation: row.hasAutomation === true,
        unread: row.unread === true,
      };
    };
    const visibleSessions = navigation.visibleSessions.map(toSidebarSession);
    // The dialog always creates a fresh session, so only connectivity gates it.
    const newSessionDisabled = !this.connected;
    return {
      routeSessionKey: navigation.currentSessionKey,
      selectedAgentId: navigation.selectedAgentId,
      visibleSessions,
      toSidebarSession,
      newSessionDisabled,
      newSessionTitle: this.connected
        ? t("chat.runControls.newSession")
        : t("chat.runControls.newSessionDisconnected"),
    };
  }

  private readonly selectSession = (sessionKey: string) => {
    this.context?.gateway.setSessionKey(sessionKey);
    this.onNavigate?.("chat", {
      search: searchForSession(sessionKey),
    });
  };

  /** Rows in on-screen order (grouped sections, collapsed ones skipped); shift
      ranges and batch actions both key off this order. */
  private visibleSessionRowsInOrder(): SidebarRecentSession[] {
    const navigationState = this.getSessionNavigationState();
    const sections = groupSidebarSessionRows(
      limitSidebarSessionRows(
        this.selectedAgentSessionRows(navigationState),
        this.visibleSessionLimit,
      ),
      {
        grouping: this.sessionsGrouping,
        knownGroups: this.sessionsGrouping === "category" ? this.knownSessionGroups() : undefined,
      },
    );
    return sections.flatMap((section) => {
      // Mirrors renderSessionSection: only headered sections can collapse.
      const showHeader = section.id === "pinned" || this.sessionsGrouping === "category";
      return showHeader && this.collapsedSessionSections.has(section.id) ? [] : section.rows;
    });
  }

  private selectedVisibleSessions(): SidebarRecentSession[] {
    if (this.selectedSessionKeys.size === 0) {
      return [];
    }
    return this.visibleSessionRowsInOrder().filter((row) => this.selectedSessionKeys.has(row.key));
  }

  private handleSessionRowClick(event: MouseEvent, session: SidebarRecentSession) {
    if (event.defaultPrevented || event.button !== 0) {
      return;
    }
    // Cmd/Ctrl and Shift clicks build the multi-select instead of the browser's
    // open-in-new-tab default; middle-click still opens the row in a new tab.
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      this.toggleSessionSelected(session.key);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      this.extendSessionSelection(session.key);
      return;
    }
    if (event.altKey) {
      return;
    }
    event.preventDefault();
    this.clearSessionSelection();
    this.selectSession(session.key);
  }

  private toggleSessionSelected(key: string) {
    const next = new Set(this.selectedSessionKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.sessionSelectionAnchor = next.has(key) ? key : null;
    this.selectedSessionKeys = next;
  }

  private extendSessionSelection(key: string) {
    const rows = this.visibleSessionRowsInOrder();
    const anchor =
      this.sessionSelectionAnchor ??
      rows.find((row) => row.visuallyActive || row.active)?.key ??
      key;
    const anchorIndex = rows.findIndex((row) => row.key === anchor);
    const targetIndex = rows.findIndex((row) => row.key === key);
    if (anchorIndex === -1 || targetIndex === -1) {
      this.sessionSelectionAnchor = key;
      this.selectedSessionKeys = new Set([key]);
      return;
    }
    const [start, end] =
      anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    this.sessionSelectionAnchor = anchor;
    this.selectedSessionKeys = new Set(rows.slice(start, end + 1).map((row) => row.key));
  }

  private clearSessionSelection() {
    this.sessionSelectionAnchor = null;
    if (this.selectedSessionKeys.size > 0) {
      this.selectedSessionKeys = new Set();
    }
  }

  private readonly replaceCurrentSession = (sessionKey: string) => {
    this.context?.gateway.setSessionKey(sessionKey);
    if (this.activeRouteId === "chat") {
      this.onNavigate?.("chat", {
        search: searchForSession(sessionKey),
      });
    }
  };

  /** Chip switching selects the agent and refreshes its session list. */
  private readonly expandAgent = (agentId: string) => {
    const context = this.context;
    if (!context) {
      return;
    }
    const nextAgentId = normalizeAgentId(agentId);
    if (nextAgentId === normalizeAgentId(this.expandedAgentId())) {
      context.agentSelection.setScope(nextAgentId);
      return;
    }
    this.clearSessionSelection();
    this.visibleSessionLimit = SIDEBAR_SESSION_PAGE_SIZE;
    context.agentSelection.set(nextAgentId);
    void context.sessions.refresh({
      agentId: nextAgentId,
      limit: SIDEBAR_AGENT_SESSION_LIST_LIMIT,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      force: true,
    });
  };

  private expandedAgentId(): string {
    const context = this.context;
    const selected = normalizeOptionalString(context?.agentSelection.state.selectedId);
    if (selected) {
      return normalizeAgentId(selected);
    }
    return normalizeAgentId(this.getSessionNavigationState().selectedAgentId);
  }

  private readonly patchSession = async (
    session: SidebarRecentSession,
    patch: {
      archived?: boolean;
      pinned?: boolean;
      unread?: boolean;
      label?: string | null;
      category?: string | null;
    },
    scope: SidebarSessionMutationScope | null = this.beginSessionMutation(),
  ): Promise<SidebarSessionMutationResult> => {
    if (!scope) {
      return "stale";
    }
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
    try {
      const patched = await scope.sessions.patch(session.key, patch, { agentId });
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      if (!patched) {
        if (scope.sessions.state.error) {
          this.publishSessionMutationError(scope, scope.sessions.state.error);
        }
        return "failed";
      }
      if (patch.archived !== true || !session.active) {
        return "completed";
      }
      this.replaceCurrentSession(
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: scope.context.agents.state.agentsList,
            hello: scope.gateway.snapshot.hello,
          }),
        }),
      );
      return "completed";
    } catch (error) {
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      this.publishSessionMutationError(scope, error);
      return "failed";
    }
  };

  private async patchSessions(
    rows: readonly SidebarRecentSession[],
    patch: { archived?: boolean; unread?: boolean; category?: string | null },
    scope: SidebarSessionMutationScope | null = this.beginSessionMutation(),
  ): Promise<SidebarSessionMutationResult> {
    if (!scope) {
      return "stale";
    }
    let result: SidebarSessionMutationResult = "completed";
    // Sequential like deleteMany: parallel patches would race the shared
    // session-state publishes inside the capability.
    for (const row of rows) {
      const rowResult = await this.patchSession(row, patch, scope);
      if (rowResult === "stale") {
        return "stale";
      }
      if (rowResult === "failed") {
        result = "failed";
      }
    }
    return result;
  }

  /** Batch delete: one confirm and one preserved-worktrees alert for the whole
      selection instead of cascading per-session prompts. */
  private async deleteSessionsBatch(rows: readonly SidebarRecentSession[]) {
    if (rows.length === 0) {
      return;
    }
    if (!window.confirm(t("sessionsView.deleteSessionsConfirm", { count: String(rows.length) }))) {
      return;
    }
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    try {
      const result = await scope.sessions.deleteMany(
        rows.map((row) => ({
          key: row.key,
          agentId: parseAgentSessionKey(row.key)?.agentId ?? scope.selectedAgentId,
          deleteTranscript: true,
        })),
      );
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return;
      }
      // Dirty/unpushed checkouts survive deletion; point at the Worktrees page
      // instead of cascading one force-delete confirm per session.
      if (result.preservedWorktrees.length > 0) {
        window.alert(
          t("sessionsView.deletePreservedWorktrees", {
            count: String(result.preservedWorktrees.length),
            branches: result.preservedWorktrees.map((worktree) => worktree.branch).join(", "),
          }),
        );
        if (!this.isSessionMutationScopeCurrent(scope)) {
          return;
        }
      }
      const deletedActive = rows.find((row) => row.active && result.deleted.includes(row.key));
      if (deletedActive) {
        this.replaceCurrentSession(
          buildAgentMainSessionKey({
            agentId: parseAgentSessionKey(deletedActive.key)?.agentId ?? scope.selectedAgentId,
            mainKey: resolveUiConfiguredMainKey({
              agentsList: scope.context.agents.state.agentsList,
              hello: scope.gateway.snapshot.hello,
            }),
          }),
        );
      }
      if (result.errors.length > 0) {
        this.publishSessionMutationError(scope, result.errors.join("; "));
      }
    } catch (error) {
      this.publishSessionMutationError(scope, error);
    }
  }

  private runBatchSessionAction(
    action: SessionMenuAction,
    rows: SidebarRecentSession[],
    allUnread: boolean,
  ) {
    switch (action.kind) {
      case "toggle-unread":
        void this.patchSessions(rows, { unread: !allUnread });
        break;
      case "move-to-group":
        void this.patchSessions(
          rows.filter((row) => (row.category ?? null) !== action.category),
          { category: action.category },
        );
        break;
      case "new-group":
        this.createSessionGroup(rows);
        break;
      case "toggle-archived":
        void this.patchSessions(rows, { archived: true });
        break;
      case "delete":
        void this.deleteSessionsBatch(rows);
        break;
      default:
        break;
    }
  }

  private preloadRoute(routeId: NavigationRouteId, event: Event, immediate = false) {
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

  private isRouteEnabled(routeId: NavigationRouteId): boolean {
    return this.enabledRouteIds?.includes(routeId) ?? true;
  }

  private readonly openCustomizeMenuFromContext = (event: MouseEvent) => {
    event.preventDefault();
    this.openCustomizeMenu(event.clientX, event.clientY);
  };

  private openCustomizeMenu(x: number, y: number, trigger: HTMLElement | null = null) {
    // Clamp so the fixed-position menu never overflows the viewport.
    const menuWidth = 240;
    const menuMaxHeight = 420;
    this.closeMoreMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.closeAgentMenu();
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

  private toggleMoreMenu(trigger: HTMLElement) {
    if (this.moreMenuPosition) {
      this.closeMoreMenu();
      return;
    }
    // Clamp so the fixed-position menu never overflows the viewport.
    const menuWidth = 240;
    const menuMaxHeight = 420;
    const rect = trigger.getBoundingClientRect();
    this.closeCustomizeMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.closeAgentMenu();
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

  /** Row-triggered opens (context menu, "…"): a row outside the current
      selection retargets the selection before the menu decides batch mode. */
  private openSessionMenuForRow(
    session: SidebarRecentSession,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ) {
    if (!this.selectedSessionKeys.has(session.key)) {
      this.clearSessionSelection();
    }
    this.openSessionMenu(session, x, y, trigger);
  }

  private openSessionMenu(
    session: SidebarRecentSession,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ) {
    this.closeCustomizeMenu();
    this.closeMoreMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.closeAgentMenu();
    this.sessionMenuTrigger = trigger;
    this.sessionMenu = { session, x, y };
    this.loadSessionMenuWork(session);
  }

  private closeSessionMenu() {
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

  private openSessionGroupMenu(group: string, x: number, y: number, trigger: HTMLElement | null) {
    const menuWidth = 224;
    const menuMaxHeight = 160;
    this.closeCustomizeMenu();
    this.closeMoreMenu();
    this.closeSessionMenu();
    this.closeSessionSortMenu();
    this.closeAgentMenu();
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

  private toggleSessionSortMenu(trigger: HTMLElement) {
    if (this.sessionSortMenuPosition) {
      this.closeSessionSortMenu();
      return;
    }
    const menuWidth = 200;
    const menuMaxHeight = 280;
    const rect = trigger.getBoundingClientRect();
    this.closeCustomizeMenu();
    this.closeMoreMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closeAgentMenu();
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

  private toggleAgentMenu(trigger: HTMLElement) {
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
    // Right-aligned to the toggle so the menu stays over the sidebar column.
    this.agentMenuPosition = {
      x: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 4),
    };
  }

  private closeAgentMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.agentMenuTrigger;
    this.agentMenuTrigger = null;
    this.agentMenuPosition = null;
    this.agentMenuFilter = "";
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  private activeChipAgent() {
    const agents = this.context?.agents.state.agentsList?.agents ?? [];
    const activeId = this.expandedAgentId();
    const agent = agents.find((entry) => normalizeAgentId(entry.id) === activeId);
    return { activeId, agent, agents };
  }

  /** Newest visible session for an agent; the chip menu's agent switch resumes here. */
  private latestAgentSessionRow(agentId: string): SessionsListResult["sessions"][number] | null {
    const normalized = normalizeAgentId(agentId);
    const rows =
      normalized === normalizeAgentId(this.sessionsAgentId ?? "")
        ? (this.sessionsResult?.sessions ?? [])
        : (this.sessionRowsByAgent[normalized] ?? []);
    // Unprefixed keys belong to the system default agent (the filter's
    // contract); keeping them for other agents would resume the wrong agent's
    // session because resume navigates with the raw key.
    const visible = filterVisibleSessionRows(rows, {
      agentId: normalized,
      defaultAgentId: resolveUiDefaultAgentId({
        agentsList: this.context?.agents.state.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      }),
      filterByAgent: true,
    });
    return visible.toSorted(compareSessionRowsByUpdatedAt)[0] ?? null;
  }

  private agentResumeKey(agentId: string): string {
    const latest = this.latestAgentSessionRow(agentId);
    if (latest) {
      return latest.key;
    }
    return buildAgentMainSessionKey({
      agentId,
      mainKey: resolveUiConfiguredMainKey({
        agentsList: this.context?.agents.state.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      }),
    });
  }

  /** Offline routes to Settings (connection) instead of a dead chat load. */
  private openAgentConversation(agentId: string) {
    if (!this.connected) {
      this.onNavigate?.("config");
      return;
    }
    this.selectSession(this.agentResumeKey(agentId));
  }

  private agentChipSubtitle(agentId: string): string {
    if (!this.connected) {
      return t("common.offline");
    }
    const latest = this.latestAgentSessionRow(agentId);
    if (latest?.hasActiveRun) {
      return t("agentChip.working");
    }
    if (latest) {
      const label = resolveSessionDisplayName(latest.key, latest);
      const meta = formatSidebarTimestamp(latest.updatedAt);
      return meta ? `${label} · ${meta}` : label;
    }
    return t("agentChip.ready");
  }

  private switchChipAgent(agentId: string) {
    this.closeAgentMenu();
    this.expandAgent(agentId);
    this.openAgentConversation(agentId);
  }

  private askAgentCapabilities(agentId: string) {
    this.closeAgentMenu();
    if (!this.connected) {
      return;
    }
    const key = this.agentResumeKey(agentId);
    const draft = encodeURIComponent(t("chat.welcome.suggestions.whatCanYouDo"));
    this.context?.gateway.setSessionKey(key);
    this.onNavigate?.("chat", { search: `${searchForSession(key)}&draft=${draft}` });
  }

  private knownSessionGroups(): string[] {
    const catalog = this.context?.sessions.state.groups ?? [];
    const catalogSet = new Set(catalog);
    const discovered = (this.sessionsResult?.sessions ?? [])
      .map((row) => normalizeOptionalString(row.category))
      .filter((name): name is string => typeof name === "string" && !catalogSet.has(name))
      .toSorted((a, b) => a.localeCompare(b));
    return [...catalog, ...new Set(discovered)];
  }

  private async rememberSessionGroup(
    name: string,
    scope: SidebarSessionMutationScope,
  ): Promise<SidebarSessionMutationResult> {
    const groups = this.knownSessionGroups();
    if (groups.includes(name)) {
      return "completed";
    }
    try {
      await scope.sessions.groupsPut([...groups, name]);
      return this.isSessionMutationScopeCurrent(scope) ? "completed" : "stale";
    } catch (error) {
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      this.publishSessionMutationError(scope, error);
      return "failed";
    }
  }

  private renameSession(session: SidebarRecentSession) {
    const nextLabel = window.prompt(t("sessionsView.renameSessionPrompt"), session.label);
    if (nextLabel === null) {
      return;
    }
    void this.patchSession(session, { label: normalizeOptionalString(nextLabel) ?? null });
  }

  private createSessionGroup(sessions: readonly SidebarRecentSession[] = []) {
    const name = window.prompt(t("sessionsView.newGroupPrompt"))?.trim();
    if (!name) {
      return;
    }
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      if ((await this.rememberSessionGroup(name, scope)) !== "completed") {
        return;
      }
      if (sessions.length > 0) {
        await this.patchSessions(sessions, { category: name }, scope);
      } else if (this.isSessionMutationScopeCurrent(scope)) {
        // Header-created groups start empty; re-render so the section shows up.
        this.requestUpdate();
      }
    })();
  }

  private renameSessionGroupFromMenu(group: string) {
    const next = window.prompt(t("sessionsView.renameGroupPrompt"), group)?.trim();
    if (!next || next === group) {
      return;
    }
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    // Collapse keys follow only a confirmed Gateway rename. A stale completion
    // must not rewrite storage owned by the replacement connection.
    void (async () => {
      try {
        const outcome = await scope.sessions.groupsRename(group, next);
        if (outcome !== "completed" || !this.isSessionMutationScopeCurrent(scope)) {
          return;
        }
        const from = `category:${group}`;
        if (this.collapsedSessionSections.has(from)) {
          const collapsed = new Set(this.collapsedSessionSections);
          collapsed.delete(from);
          collapsed.add(`category:${next}`);
          this.saveCollapsedSessionSections(collapsed);
        }
        this.requestUpdate();
      } catch (error) {
        this.publishSessionMutationError(scope, error);
      }
    })();
  }

  private deleteSessionGroupFromMenu(group: string) {
    if (!window.confirm(t("sessionsView.deleteGroupConfirm", { group }))) {
      return;
    }
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      try {
        const outcome = await scope.sessions.groupsDelete(group);
        if (outcome !== "completed" || !this.isSessionMutationScopeCurrent(scope)) {
          return;
        }
        const collapsed = new Set(this.collapsedSessionSections);
        collapsed.delete(`category:${group}`);
        this.saveCollapsedSessionSections(collapsed);
        this.requestUpdate();
      } catch (error) {
        this.publishSessionMutationError(scope, error);
      }
    })();
  }

  private saveCollapsedSessionSections(sections: ReadonlySet<string>) {
    this.collapsedSessionSections = new Set(sections);
    try {
      getSafeLocalStorage()?.setItem(
        SIDEBAR_SESSION_COLLAPSED_SECTIONS_STORAGE_KEY,
        JSON.stringify([...sections]),
      );
    } catch {
      // Group membership and ordering remain usable without local persistence.
    }
  }

  private toggleSessionSection(sectionId: string) {
    const collapsed = new Set(this.collapsedSessionSections);
    if (collapsed.has(sectionId)) {
      collapsed.delete(sectionId);
    } else {
      collapsed.add(sectionId);
    }
    this.saveCollapsedSessionSections(collapsed);
  }

  private reorderSessionGroup(source: string, target: string, position: "before" | "after") {
    const groups = reorderSessionCustomGroups(this.knownSessionGroups(), source, target, position);
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      try {
        await scope.sessions.groupsPut(groups);
        if (this.isSessionMutationScopeCurrent(scope)) {
          this.requestUpdate();
        }
      } catch (error) {
        this.publishSessionMutationError(scope, error);
      }
    })();
  }

  private assignSessionCategory(
    session: SidebarRecentSession,
    category: string | null,
    patch: { pinned?: boolean } = {},
  ) {
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      if (category && (await this.rememberSessionGroup(category, scope)) !== "completed") {
        return;
      }
      await this.patchSession(session, { category, ...patch }, scope);
    })();
  }

  private handleSessionSectionDragOver(event: DragEvent, sectionId: string, category?: string) {
    const dataTransfer = event.dataTransfer;
    if (
      category &&
      sessionGroupDragActive(dataTransfer) &&
      this.draggingSessionGroup !== category
    ) {
      event.preventDefault();
      if (dataTransfer) {
        dataTransfer.dropEffect = "move";
      }
      const target = event.currentTarget as HTMLElement;
      const bounds = target.getBoundingClientRect();
      const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      this.sessionGroupDropTarget = { group: category, position };
      this.sessionDropTarget = null;
      return;
    }
    if (!sessionDragActive(dataTransfer) || sectionId === "pinned") {
      return;
    }
    event.preventDefault();
    if (dataTransfer) {
      dataTransfer.dropEffect = "move";
    }
    this.sessionDropTarget = sectionId;
    this.sessionGroupDropTarget = null;
  }

  private handleSessionSectionDragLeave(event: DragEvent, sectionId: string, category?: string) {
    const current = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
      return;
    }
    if (this.sessionDropTarget === sectionId) {
      this.sessionDropTarget = null;
    }
    if (category && this.sessionGroupDropTarget?.group === category) {
      this.sessionGroupDropTarget = null;
    }
  }

  private findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined {
    const navigationState = this.getSessionNavigationState();
    const active = navigationState.visibleSessions.find(
      (candidate) => candidate.key === sessionKey,
    );
    if (active) {
      return active;
    }
    for (const rows of Object.values(this.sessionRowsByAgent)) {
      const row = rows.find((candidate) => candidate.key === sessionKey);
      if (row) {
        return navigationState.toSidebarSession(row);
      }
    }
    return undefined;
  }

  private handleSessionSectionDrop(event: DragEvent, category?: string) {
    event.preventDefault();
    const sourceGroup = readSessionGroupDragData(event.dataTransfer);
    if (sourceGroup && category && sourceGroup !== category) {
      const position =
        this.sessionGroupDropTarget?.group === category
          ? this.sessionGroupDropTarget.position
          : "before";
      this.reorderSessionGroup(sourceGroup, category, position);
    } else {
      const sessionKey = readSessionDragData(event.dataTransfer);
      // Rows can be dragged out of a browsed (non-active) agent section, so the
      // lookup must cover every agent's cached rows, not just the active scope.
      const session = sessionKey ? this.findSidebarSessionByKey(sessionKey) : undefined;
      const nextCategory = category ?? null;
      if (session && (session.category !== nextCategory || session.pinned)) {
        this.assignSessionCategory(session, nextCategory, session.pinned ? { pinned: false } : {});
      }
    }
    this.draggingSessionKey = null;
    this.draggingSessionGroup = null;
    this.sessionDropTarget = null;
    this.sessionGroupDropTarget = null;
  }

  private setSessionsGrouping(grouping: SidebarSessionsGrouping) {
    this.sessionsGrouping = grouping;
    try {
      getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_GROUPING_STORAGE_KEY, grouping);
    } catch {
      // ignore storage failures
    }
  }

  private setSessionsShowCron(show: boolean) {
    this.sessionsShowCron = show;
    try {
      getSafeLocalStorage()?.setItem(SIDEBAR_SESSION_SHOW_CRON_STORAGE_KEY, String(show));
    } catch {
      // ignore storage failures
    }
  }

  private async forkSession(session: SidebarRecentSession) {
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
    try {
      const key = await scope.sessions.create({
        parentSessionKey: session.key,
        fork: true,
        agentId,
      });
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return;
      }
      if (key) {
        this.selectSession(key);
      } else {
        this.publishSessionMutationError(
          scope,
          scope.sessions.state.error ?? t("newSession.createFailed"),
        );
      }
    } catch (error) {
      this.publishSessionMutationError(scope, error);
    }
  }

  private async deleteSession(session: SidebarRecentSession) {
    if (!window.confirm(t("sessionsView.deleteSessionConfirm", { session: session.label }))) {
      return;
    }
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
    try {
      const outcome = await scope.sessions.delete(session.key, {
        agentId,
        deleteTranscript: true,
      });
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return;
      }
      // Dirty/unpushed checkouts survive the delete; offer an explicit force
      // removal instead of silently orphaning them under the state dir.
      if (outcome.worktreePreserved) {
        const preserved = outcome.worktreePreserved;
        if (
          window.confirm(
            t("sessionsView.deletePreservedWorktreeConfirm", { branch: preserved.branch }),
          )
        ) {
          if (!this.isSessionMutationScopeCurrent(scope)) {
            return;
          }
          try {
            await scope.client.request("worktrees.remove", {
              id: preserved.id,
              force: true,
            });
          } catch (error) {
            this.publishSessionMutationError(scope, error);
          }
          if (!this.isSessionMutationScopeCurrent(scope)) {
            return;
          }
        }
      }
      if (!outcome.deleted || !session.active) {
        return;
      }
      this.replaceCurrentSession(
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: scope.context.agents.state.agentsList,
            hello: scope.gateway.snapshot.hello,
          }),
        }),
      );
    } catch (error) {
      this.publishSessionMutationError(scope, error);
    }
  }

  private renderCustomizeMenu() {
    const position = this.customizeMenuPosition;
    const trigger = this.customizeMenuTrigger;
    return renderSidebarCustomizeMenu({
      position,
      pinnedRoutes: this.sidebarPinnedRoutes,
      isRouteEnabled: (routeId) => this.isRouteEnabled(routeId),
      onTabAway: () => trigger?.focus(),
      onClose: (restoreFocus) => {
        if (this.customizeMenuPosition !== position) {
          return;
        }
        this.closeCustomizeMenu({ restoreFocus });
      },
      onToggleRoute: (routeId) => {
        const pinned = this.sidebarPinnedRoutes;
        const next = pinned.includes(routeId)
          ? pinned.filter((route) => route !== routeId)
          : [...pinned, routeId];
        this.onUpdatePinnedRoutes?.(next);
      },
      onReset: () => {
        this.onUpdatePinnedRoutes?.([...DEFAULT_SIDEBAR_PINNED_ROUTES]);
        this.closeCustomizeMenu({ restoreFocus: true });
      },
    });
  }

  private renderAgentMenu() {
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
      onFilterChange: (next) => {
        this.agentMenuFilter = next;
      },
      onSwitchAgent: (agentId) => this.switchChipAgent(agentId),
      onAskCapabilities: (agentId) => this.askAgentCapabilities(agentId),
      onOpenNewSession: (agentId) => this.onOpenNewSession?.(agentId),
      onTabAway: () => trigger?.focus(),
      onClose: (restoreFocus) => {
        // An old Web Awesome menu can finish hiding after its replacement opens.
        // Only the render that owns the current position may close it.
        if (this.agentMenuPosition !== position) {
          return;
        }
        this.closeAgentMenu({ restoreFocus });
      },
      onNavigate: (routeId, options) => this.onNavigate?.(routeId, options),
      onPairMobile: () => this.onPairMobile?.(),
    });
  }

  private renderSessionMenu() {
    const menu = this.sessionMenu;
    if (!menu) {
      return nothing;
    }
    const { session } = menu;
    const context = this.context;
    const mainKey = resolveUiConfiguredMainKey({
      agentsList: context?.agents.state.agentsList,
      hello: context?.gateway.snapshot.hello,
    });
    // Batch mode only when the menu's row is part of a multi-selection; the
    // menu then acts on the selection and shows aggregated unread/category.
    const selection = this.selectedVisibleSessions();
    const batchRows =
      selection.length > 1 && selection.some((row) => row.key === session.key) ? selection : null;
    const rows = batchRows ?? [session];
    const archiveAllowed = rows.every((row) => canArchiveSessionRow(row, mainKey));
    const allUnread = rows.every((row) => row.unread);
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
            pinned: session.pinned,
            unread: batchRows ? allUnread : session.unread,
            archived: false,
            category: batchRows ? sharedCategory : (session.category ?? null),
          }}
          .selectionCount=${rows.length}
          .anchor=${menu}
          .trigger=${this.sessionMenuTrigger}
          .disabled=${!this.connected}
          .forkDisabled=${this.sessionsLoading || session.modelSelectionLocked}
          .archiveAllowed=${archiveAllowed}
          .groups=${this.knownSessionGroups()}
          .canOpenChat=${true}
          .work=${batchRows ? null : this.sessionMenuWork}
          .workboard=${null}
          .onClose=${() => {
            // A removed Web Awesome menu can finish hiding after its replacement
            // opens. Ignore that stale close or the new menu disappears too.
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
                window.open(action.url, "_blank", "noopener");
                break;
              case "open-in":
                // A custom-scheme window hands off to the OS without navigating this page.
                window.open(editorOpenUrl(action.editor, action.path));
                break;
              case "toggle-pin":
                void this.patchSession(session, { pinned: !session.pinned });
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
                void this.patchSession(session, { archived: true });
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

  private renderSessionGroupMenu() {
    const menu = this.sessionGroupMenu;
    const trigger = this.sessionGroupMenuTrigger;
    if (!menu) {
      return nothing;
    }
    return keyed(
      menu,
      html`
        <openclaw-menu-surface>
          <wa-dropdown
            class="session-menu sidebar-session-group-menu"
            .open=${true}
            placement="bottom-start"
            .distance=${0}
            aria-label=${t("sessionsView.groupMenu", { group: menu.group })}
            @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
              event.preventDefault();
              const value = event.detail.item.value;
              this.closeSessionGroupMenu({ restoreFocus: true });
              switch (value) {
                case "rename-group":
                  this.renameSessionGroupFromMenu(menu.group);
                  break;
                case "new-group":
                  this.createSessionGroup();
                  break;
                case "delete-group":
                  this.deleteSessionGroupFromMenu(menu.group);
                  break;
                case undefined:
                  break;
              }
            }}
            @keydown=${(event: KeyboardEvent) =>
              trackDropdownKeyboardDismissal(event, () => trigger?.focus())}
            @wa-after-hide=${(event: Event) => {
              if (this.sessionGroupMenu && this.sessionGroupMenu !== menu) {
                return;
              }
              this.closeSessionGroupMenu({
                restoreFocus: consumeDropdownKeyboardDismissal(event),
              });
            }}
          >
            <button
              slot="trigger"
              type="button"
              tabindex="-1"
              aria-hidden="true"
              aria-label=${t("sessionsView.groupMenu", { group: menu.group })}
              style="position: fixed; left: ${menu.x}px; top: ${menu.y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
            ></button>
            <wa-dropdown-item
              class="session-menu__item"
              value="rename-group"
              ?disabled=${!this.connected}
            >
              <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.edit}</span>
              <span class="session-menu__text">${t("sessionsView.renameGroupMenu")}</span>
            </wa-dropdown-item>
            <wa-dropdown-item class="session-menu__item" value="new-group">
              <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.folder}</span>
              <span class="session-menu__text">${t("sessionsView.newGroup")}</span>
            </wa-dropdown-item>
            <div class="session-menu__separator" role="separator"></div>
            <wa-dropdown-item
              class="session-menu__item session-menu__item--destructive"
              value="delete-group"
              variant="danger"
              ?disabled=${!this.connected}
            >
              <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.trash}</span>
              <span class="session-menu__text">${t("sessionsView.deleteGroupMenu")}</span>
            </wa-dropdown-item>
          </wa-dropdown>
        </openclaw-menu-surface>
      `,
    );
  }

  private renderSessionSortMenu() {
    const position = this.sessionSortMenuPosition;
    const trigger = this.sessionSortMenuTrigger;
    if (!position) {
      return nothing;
    }
    const groupingOptions = [
      { grouping: "category", label: t("sessionsView.groupByCategory") },
      { grouping: "none", label: t("sessionsView.groupByNone") },
    ] as const satisfies ReadonlyArray<{ grouping: SidebarSessionsGrouping; label: string }>;
    return keyed(
      position,
      html`
        <openclaw-menu-surface>
          <wa-dropdown
            class="sidebar-session-sort-menu"
            .open=${true}
            placement="bottom-start"
            .distance=${0}
            aria-label=${t("chat.sidebar.sortSessions")}
            @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
              event.preventDefault();
              const value = event.detail.item.value;
              if (value?.startsWith("grouping:")) {
                this.setSessionsGrouping(
                  value.slice("grouping:".length) as SidebarSessionsGrouping,
                );
              } else if (value?.startsWith("sort:")) {
                this.sessionSortMode = value.slice("sort:".length) as SidebarSessionSortMode;
              } else if (value === "show-cron") {
                this.setSessionsShowCron(!this.sessionsShowCron);
              }
              this.closeSessionSortMenu({ restoreFocus: true });
            }}
            @keydown=${(event: KeyboardEvent) =>
              trackDropdownKeyboardDismissal(event, () => trigger?.focus())}
            @wa-after-hide=${(event: Event) => {
              if (this.sessionSortMenuPosition !== position) {
                return;
              }
              this.closeSessionSortMenu({
                restoreFocus: consumeDropdownKeyboardDismissal(event),
              });
            }}
          >
            <button
              slot="trigger"
              type="button"
              tabindex="-1"
              aria-hidden="true"
              aria-label=${t("chat.sidebar.sortSessions")}
              style="position: fixed; left: ${position.x}px; top: ${position.y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
            ></button>
            <div class="sidebar-session-sort-menu__title">${t("sessionsView.groupBy")}</div>
            ${groupingOptions.map(
              (option) => html`
                <wa-dropdown-item
                  class="sidebar-session-sort-menu__item"
                  value=${`grouping:${option.grouping}`}
                  role="menuitemradio"
                  aria-checked=${String(this.sessionsGrouping === option.grouping)}
                  ${ref((element) =>
                    syncDropdownItemRadio(element, this.sessionsGrouping === option.grouping),
                  )}
                >
                  <span slot="details" class="session-menu__check" aria-hidden="true"
                    >${this.sessionsGrouping === option.grouping ? icons.check : nothing}</span
                  >
                  <span class="session-menu__text">${option.label}</span>
                </wa-dropdown-item>
              `,
            )}
            <div class="session-menu__separator" role="separator"></div>
            <div class="sidebar-session-sort-menu__title">${t("chat.sidebar.sortBy")}</div>
            ${SIDEBAR_SESSION_SORT_OPTIONS.map(
              (option) => html`
                <wa-dropdown-item
                  class="sidebar-session-sort-menu__item"
                  value=${`sort:${option.mode}`}
                  role="menuitemradio"
                  aria-checked=${String(this.sessionSortMode === option.mode)}
                  ${ref((element) =>
                    syncDropdownItemRadio(element, this.sessionSortMode === option.mode),
                  )}
                >
                  <span slot="details" class="session-menu__check" aria-hidden="true"
                    >${this.sessionSortMode === option.mode ? icons.check : nothing}</span
                  >
                  <span class="session-menu__text">${t(option.labelKey)}</span>
                </wa-dropdown-item>
              `,
            )}
            <div class="session-menu__separator" role="separator"></div>
            <wa-dropdown-item
              class="sidebar-session-sort-menu__item"
              type="checkbox"
              value="show-cron"
              .checked=${this.sessionsShowCron}
            >
              <span class="session-menu__text">${t("sessionsView.showCronSessions")}</span>
            </wa-dropdown-item>
          </wa-dropdown>
        </openclaw-menu-surface>
      `,
    );
  }

  private renderRoute(routeId: NavigationRouteId) {
    // Disabled routes (e.g. Workboard with the plugin off) stay hidden rather
    // than rendering an inert nav item.
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
      active: isSidebarRouteActive(this.activeRouteId, routeId),
      onNavigate: () => {
        this.onNavigate?.(routeId, chatSearch ? { search: chatSearch } : undefined);
      },
      onPreload: (event, immediate) => this.preloadRoute(routeId, event, immediate),
      onCancelPreload: this.cancelPreload,
    });
  }

  private renderRecentSession(
    session: SidebarRecentSession,
    display?: CatalogBackingSessionDisplay,
  ) {
    const label = display?.label ?? session.label;
    const subtitle = display
      ? display.subtitle
      : session.subtitle && session.workSession && session.subtitle !== session.label
        ? session.subtitle
        : undefined;
    const meta = display?.meta ?? session.meta;
    const rowClass = [
      "sidebar-recent-session",
      "session-row-host",
      session.visuallyActive ? "sidebar-recent-session--active" : "",
      this.selectedSessionKeys.has(session.key) ? "sidebar-recent-session--selected" : "",
      session.pinned ? "session-row-host--pinned" : "",
      session.hasActiveRun ? "session-row-host--running" : "",
      this.draggingSessionKey === session.key ? "sidebar-recent-session--dragging" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const row = html`
      <div
        class=${rowClass}
        data-session-key=${session.key}
        draggable="true"
        @dragstart=${(event: DragEvent) => {
          if (event.dataTransfer) {
            writeSessionDragData(event.dataTransfer, session.key);
            this.draggingSessionKey = session.key;
          }
        }}
        @dragend=${() => {
          this.draggingSessionKey = null;
          this.sessionDropTarget = null;
        }}
        @contextmenu=${(event: MouseEvent) => {
          event.preventDefault();
          this.openSessionMenuForRow(session, event.clientX, event.clientY);
        }}
        @mouseenter=${(event: MouseEvent) => startHoverMarquee(event.currentTarget as HTMLElement)}
        @mouseleave=${(event: MouseEvent) => stopHoverMarquee(event.currentTarget as HTMLElement)}
      >
        <a
          href=${session.href}
          class="sidebar-recent-session__link"
          draggable="false"
          title=${display?.title ?? `${session.label} · ${session.key}`}
          @click=${(event: MouseEvent) => this.handleSessionRowClick(event, session)}
        >
          ${session.hasActiveRun
            ? html`<span
                class="session-run-spinner sidebar-recent-session__state"
                role="img"
                aria-label=${t("sessionsView.activeRun")}
                title=${t("sessionsView.activeRun")}
              ></span>`
            : session.unread
              ? html`<span
                  class="session-unread-dot sidebar-recent-session__unread"
                  role="img"
                  aria-label=${t("sessionsView.unread")}
                ></span>`
              : nothing}
          <span class="sidebar-recent-session__text">
            <span class="sidebar-recent-session__name hover-marquee">${label}</span>
            ${subtitle
              ? html`<span class="sidebar-recent-session__subtitle">${subtitle}</span>`
              : nothing}
          </span>
          ${session.worktreeId || session.hasAutomation
            ? html`<span class="session-row-badges">
                ${session.worktreeId
                  ? html`<span
                      class="session-row-badge"
                      role="img"
                      aria-label=${t("sessionsView.worktreeSession")}
                      title=${t("sessionsView.worktreeSession")}
                      >${icons.gitBranch}</span
                    >`
                  : nothing}
                ${session.hasAutomation
                  ? html`<span
                      class="session-row-badge"
                      role="img"
                      aria-label=${t("sessionsView.automationAttached")}
                      title=${t("sessionsView.automationAttached")}
                      >${icons.clock}</span
                    >`
                  : nothing}
              </span>`
            : nothing}
        </a>
        <span class="sidebar-recent-session__aside session-row-aside">
          <span class="session-row-trail">${meta}</span>
          <span class="session-row-actions">
            <button
              class="session-action session-action--pin"
              data-sidebar-session-pin="true"
              type="button"
              title=${session.pinned
                ? t("sessionsView.unpinSession")
                : t("sessionsView.pinSession")}
              aria-label=${session.pinned
                ? t("sessionsView.unpinSession")
                : t("sessionsView.pinSession")}
              ?disabled=${!this.connected}
              @click=${() => void this.patchSession(session, { pinned: !session.pinned })}
            >
              ${icons.pin}
            </button>
            <button
              class="session-action"
              data-session-menu="true"
              type="button"
              title=${t("chat.sidebar.openSessionMenu")}
              aria-label=${t("chat.sidebar.openSessionMenu")}
              aria-haspopup="menu"
              aria-expanded=${String(this.sessionMenu?.session.key === session.key)}
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                if (this.sessionMenu?.session.key === session.key) {
                  this.closeSessionMenu();
                  return;
                }
                const trigger = event.currentTarget as HTMLElement;
                const rect = trigger.getBoundingClientRect();
                this.openSessionMenuForRow(session, rect.right, rect.bottom + 4, trigger);
              }}
            >
              ${icons.moreHorizontal}
            </button>
          </span>
        </span>
      </div>
    `;
    // Hover marquee state mutates the row DOM. Keying prevents that state from
    // leaking when Lit reuses this slot for another session after navigation.
    return keyed(session.key, row);
  }

  private renderSessionSection(
    section: {
      id: string;
      category?: string;
      channel?: string;
      work?: boolean;
      rows: SidebarRecentSession[];
    },
    showFallback = false,
  ) {
    const group = section.category;
    const isPinned = section.id === "pinned";
    const showHeader = isPinned || this.sessionsGrouping === "category";
    const collapsed = showHeader && this.collapsedSessionSections.has(section.id);
    const label = isPinned
      ? t("sessionsView.pinned")
      : section.channel
        ? channelDisplayLabel(section.channel)
        : section.work
          ? t("chat.sidebar.workSessions")
          : group
            ? group
            : t("chat.sidebar.chats");
    // Smart channel/work sections classify rows automatically; only custom
    // groups and Chats accept manual drops (a drop means category assignment).
    // Custom group headers drag as a whole (mirroring whole-row session drags);
    // the dot handle inside is a pure visual affordance.
    const acceptsSessions =
      !isPinned &&
      this.sessionsGrouping === "category" &&
      (section.id === "ungrouped" || Boolean(group));
    const sectionClass = [
      "sidebar-recent-sessions__group",
      collapsed ? "sidebar-recent-sessions__group--collapsed" : "",
      group && this.draggingSessionGroup === group
        ? "sidebar-recent-sessions__group--dragging"
        : "",
      this.sessionDropTarget === section.id ? "sidebar-recent-sessions__group--session-drop" : "",
      group && this.sessionGroupDropTarget?.group === group
        ? `sidebar-recent-sessions__group--group-drop-${this.sessionGroupDropTarget.position}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`
      <div
        class=${sectionClass}
        data-session-section=${section.id}
        @dragover=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDragOver(event, section.id, group)
          : nothing}
        @dragleave=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDragLeave(event, section.id, group)
          : nothing}
        @drop=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDrop(event, group)
          : nothing}
      >
        ${showHeader
          ? html`
              <div
                class="sidebar-recent-sessions__head ${group
                  ? "sidebar-recent-sessions__head--draggable"
                  : ""}"
                draggable=${group ? "true" : "false"}
                @dragstart=${group
                  ? (event: DragEvent) => {
                      if (event.dataTransfer) {
                        writeSessionGroupDragData(event.dataTransfer, group);
                        this.draggingSessionGroup = group;
                      }
                    }
                  : nothing}
                @dragend=${group
                  ? () => {
                      this.draggingSessionGroup = null;
                      this.sessionGroupDropTarget = null;
                    }
                  : nothing}
                @contextmenu=${group
                  ? (event: MouseEvent) => {
                      event.preventDefault();
                      this.openSessionGroupMenu(group, event.clientX, event.clientY, null);
                    }
                  : nothing}
              >
                ${group
                  ? html`
                      <span class="sidebar-session-group-drag-handle" aria-hidden="true"></span>
                    `
                  : nothing}
                <button
                  type="button"
                  class="sidebar-session-group-toggle"
                  aria-expanded=${String(!collapsed)}
                  aria-label=${label}
                  @click=${() => this.toggleSessionSection(section.id)}
                >
                  <span class="sidebar-session-group-toggle__icon" aria-hidden="true"
                    >${collapsed ? icons.chevronRight : icons.chevronDown}</span
                  >
                  <span class="sidebar-recent-sessions__label-text">${label}</span>
                  <span class="sidebar-session-group-count">${section.rows.length}</span>
                </button>
                ${group
                  ? html`
                      <button
                        type="button"
                        class="sidebar-session-group-actions"
                        title=${t("sessionsView.groupMenu", { group })}
                        aria-label=${t("sessionsView.groupMenu", { group })}
                        aria-haspopup="menu"
                        aria-expanded=${String(this.sessionGroupMenu?.group === group)}
                        @click=${(event: MouseEvent) => {
                          event.stopPropagation();
                          const trigger = event.currentTarget as HTMLElement;
                          const rect = trigger.getBoundingClientRect();
                          this.openSessionGroupMenu(group, rect.right, rect.bottom + 4, trigger);
                        }}
                      >
                        ${icons.moreHorizontal}
                      </button>
                    `
                  : nothing}
              </div>
            `
          : nothing}
        ${collapsed
          ? nothing
          : html`
              <div class="sidebar-recent-sessions__list">
                ${showFallback
                  ? this.renderChatFallback()
                  : section.rows.map((session) => this.renderRecentSession(session))}
              </div>
            `}
      </div>
    `;
  }

  /** The list follows the chip-selected agent. While route and loaded result
      agree with it (every settled online state), keep the navigation rows and
      their pinned-active semantics; mid-switch or offline, fall back to that
      agent's loaded/cached raw rows instead of flashing empty or stale. */
  private selectedAgentSessionRows(
    navigationState: ReturnType<AppSidebar["getSessionNavigationState"]>,
  ): SidebarRecentSession[] {
    // Adopted catalog sessions render inside their catalog group; hiding them
    // here keeps one selectable row per session instead of a duplicate that
    // jumps to the top of the regular list.
    const adopted = adoptedCatalogSessionKeys(this.sessionCatalogs);
    const selected = this.expandedAgentId();
    const loadedAgentId = normalizeAgentId(this.sessionsAgentId ?? "");
    const routeAgentId = normalizeAgentId(navigationState.selectedAgentId);
    if (selected === routeAgentId && selected === loadedAgentId) {
      return navigationState.visibleSessions.filter((row) => !adopted.has(row.key));
    }
    const rows =
      selected === loadedAgentId
        ? (this.sessionsResult?.sessions ?? [])
        : (this.sessionRowsByAgent[selected] ?? []);
    return filterVisibleSessionRows(rows, {
      agentId: selected,
      defaultAgentId: resolveUiDefaultAgentId({
        agentsList: this.context?.agents.state.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      }),
      filterByAgent: true,
      showCron: this.sessionsShowCron,
    })
      .toSorted(this.compareSidebarSessionRows)
      .filter((row) => !adopted.has(row.key))
      .map(navigationState.toSidebarSession);
  }

  private agentUnreadCount(agentId: string): number {
    const rows = this.sessionRowsByAgent[normalizeAgentId(agentId)] ?? [];
    return rows.filter((row) => row.unread === true && row.archived !== true).length;
  }

  private renderDraftSessionRow() {
    return html`
      <div class="sidebar-recent-session sidebar-recent-session--draft">
        <span class="sidebar-recent-session__link">
          <span class="sidebar-recent-session__text">
            <span class="sidebar-recent-session__name">${t("newSession.draftRow")}</span>
          </span>
        </span>
      </div>
    `;
  }

  private renderSessionListBody(
    rows: SidebarRecentSession[],
    options: { showDraft: boolean; showFallback: boolean },
  ) {
    const visibleRows = limitSidebarSessionRows(rows, this.visibleSessionLimit);
    const sections = groupSidebarSessionRows(visibleRows, {
      grouping: this.sessionsGrouping,
      // Stored-but-empty groups stay visible as sections so a freshly created
      // group is usable as a move target before its first session arrives.
      knownGroups: this.sessionsGrouping === "category" ? this.knownSessionGroups() : undefined,
    });
    return html`
      ${options.showDraft ? this.renderDraftSessionRow() : nothing}
      ${sections.map((section) =>
        this.renderSessionSection(
          section,
          options.showFallback && rows.length === 0 && section.id === "ungrouped",
        ),
      )}
      ${this.renderSessionPagination(rows, visibleRows.length)}
    `;
  }

  private renderSessionPagination(rows: SidebarRecentSession[], visible: number) {
    const canShowMore = visible < rows.length;
    const collapsedVisible = limitSidebarSessionRows(rows, SIDEBAR_SESSION_PAGE_SIZE).length;
    const canShowLess = visible > SIDEBAR_SESSION_SEE_LESS_THRESHOLD && visible > collapsedVisible;
    if (!canShowMore && !canShowLess) {
      return nothing;
    }
    return html`
      <div class="sidebar-session-pagination">
        ${canShowMore
          ? html`<button
              type="button"
              class="sidebar-session-pagination__button"
              aria-label=${t("chat.selectors.loadMoreSessions")}
              @click=${() => {
                this.visibleSessionLimit = visible + SIDEBAR_SESSION_PAGE_SIZE;
              }}
            >
              ${t("chat.selectors.loadMoreSessions")}
            </button>`
          : nothing}
        ${canShowLess
          ? html`<button
              type="button"
              class="sidebar-session-pagination__button"
              aria-label=${t("usage.details.collapse")}
              @click=${() => {
                this.clearSessionSelection();
                this.visibleSessionLimit = SIDEBAR_SESSION_PAGE_SIZE;
              }}
            >
              ${t("usage.details.collapse")}
            </button>`
          : nothing}
      </div>
    `;
  }

  private renderSessions() {
    const navigationState = this.getSessionNavigationState();
    const { newSessionDisabled, newSessionTitle } = navigationState;
    const visibleSessions = this.selectedAgentSessionRows(navigationState);
    const expandedAgentId = this.expandedAgentId();
    return html`
      <section class="sidebar-sessions">
        ${this.sessionMutationError
          ? html`
              <div
                class="sidebar-session-error callout danger callout--dismissible"
                role="alert"
                data-sidebar-session-error
              >
                <span class="callout__content">${this.sessionMutationError}</span>
                <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
                  <button
                    class="callout__dismiss"
                    type="button"
                    @click=${() => {
                      this.sessionMutationError = null;
                    }}
                    aria-label=${t("chat.actions.dismissError")}
                  >
                    ${icons.x}
                  </button>
                </openclaw-tooltip>
              </div>
            `
          : nothing}
        <div
          class="sidebar-recent-sessions sidebar-recent-sessions--scroll-${this
            .sessionsScrollState}"
          aria-label=${titleForRoute("sessions")}
          @scroll=${(event: Event) =>
            this.updateSessionsScrollState(event.currentTarget as HTMLElement)}
        >
          <div class="sidebar-recent-sessions__head sidebar-recent-sessions__head--root">
            <span class="sidebar-recent-sessions__label-text">${t("sessionsView.title")}</span>
            <button
              type="button"
              class="sidebar-session-sort"
              title=${t("chat.sidebar.sortSessions")}
              aria-label=${t("chat.sidebar.sortSessions")}
              aria-haspopup="menu"
              aria-expanded=${String(this.sessionSortMenuPosition !== null)}
              @click=${(event: MouseEvent) => {
                const trigger = event.currentTarget as HTMLElement;
                this.toggleSessionSortMenu(trigger);
              }}
            >
              ${icons.listFilter}
            </button>
            <button
              type="button"
              class="sidebar-session-sort sidebar-session-new"
              title=${newSessionTitle}
              aria-label=${t("chat.runControls.newSession")}
              ?disabled=${newSessionDisabled}
              @click=${() => this.onOpenNewSession?.(expandedAgentId)}
            >
              ${icons.plus}
            </button>
          </div>
          ${this.renderSessionListBody(visibleSessions, {
            showDraft:
              Boolean(this.draftSessionAgentId) &&
              normalizeAgentId(this.draftSessionAgentId) === expandedAgentId,
            showFallback: true,
          })}
          ${this.renderSessionCatalogs(navigationState)}
        </div>
      </section>
    `;
  }

  // Catalog groups render inside the shared sessions scroller. Sibling
  // .sidebar-sessions sections would form a second scroll-less region that
  // flex-squeezes under the shell body's overflow clip and paints rows over
  // the following section.
  private renderSessionCatalogs(
    navigationState: ReturnType<AppSidebar["getSessionNavigationState"]>,
  ) {
    return renderSessionCatalogGroups({
      catalogs: this.sessionCatalogs,
      connected: this.connected,
      basePath: this.basePath,
      routeSessionKey: this.activeRouteId === "chat" ? this.getRouteSessionKey() : "",
      newSessionAgentId: this.expandedAgentId(),
      collapsedSections: this.collapsedSessionSections,
      loadingMoreCatalogIds: this.loadingMoreSessionCatalogIds,
      liveRows: [
        ...(this.sessionsResult?.sessions ?? []),
        ...Object.values(this.sessionRowsByAgent).flat(),
      ],
      renderLiveRow: (row, display) =>
        this.renderRecentSession(navigationState.toSidebarSession(row), display),
      onToggleSection: (sectionId) => this.toggleSessionSection(sectionId),
      onLoadMore: (catalogId) => void this.loadMoreSessionCatalog(catalogId),
      onOpenNewSession: this.onOpenNewSession,
      onNavigate: this.onNavigate,
    });
  }

  private renderMoreRow() {
    return renderSidebarMoreRow({
      open: this.moreMenuPosition !== null,
      active: sidebarMoreMenuHoldsActiveRoute({
        activeRouteId: this.activeRouteId,
        pinnedRoutes: this.sidebarPinnedRoutes,
        isRouteEnabled: (routeId) => this.isRouteEnabled(routeId),
      }),
      onToggle: (trigger) => this.toggleMoreMenu(trigger),
    });
  }

  private renderMoreMenu() {
    const position = this.moreMenuPosition;
    const trigger = this.moreMenuTrigger;
    return renderSidebarMoreMenu({
      position,
      basePath: this.basePath,
      activeRouteId: this.activeRouteId,
      activePluginTabId: this.activePluginTabId,
      pinnedRoutes: this.sidebarPinnedRoutes,
      pluginTabs: sidebarPluginTabs(this.context?.gateway.snapshot.hello?.controlUiTabs),
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
      onNavigatePluginTab: (search) => {
        this.closeMoreMenu({ restoreFocus: true });
        this.onNavigate?.("plugin", { search });
      },
      onPreloadRoute: (routeId, event) => this.preloadRoute(routeId, event),
      onCancelPreload: this.cancelPreload,
      onEditPinnedItems: () => {
        // Hand the durable More row over as the pin editor's trigger so
        // Escape restores focus there once this menu is gone.
        const customizePosition = this.moreMenuPosition;
        const customizeTrigger = this.moreMenuTrigger;
        if (customizePosition) {
          this.openCustomizeMenu(customizePosition.x, customizePosition.y, customizeTrigger);
        }
      },
    });
  }

  private renderChatFallback() {
    return html`
      <a
        href=${pathForRoute("chat", this.basePath)}
        class="sidebar-recent-session ${this.activeRouteId === "chat"
          ? "sidebar-recent-session--active"
          : ""}"
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          this.onNavigate?.("chat");
        }}
      >
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__name">${t("nav.chat")}</span>
        </span>
      </a>
    `;
  }

  override render() {
    const gatewayStatus = t("chat.gatewayStatus", {
      status: this.connected ? t("common.online") : t("common.offline"),
    });
    const { activeId: chipAgentId, agent: chipAgent, agents: chipAgents } = this.activeChipAgent();
    const chipMenuUnread = chipAgents.some((entry) => {
      const agentId = normalizeAgentId(entry.id);
      return agentId !== chipAgentId && this.agentUnreadCount(agentId) > 0;
    });
    const chipName = chipAgent ? normalizeAgentLabel(chipAgent) : chipAgentId;
    const chipAvatarText =
      (chipAgent ? resolveAgentTextAvatar(chipAgent) : null) ??
      (chipName || chipAgentId).slice(0, 1).toUpperCase();
    return html`
      <aside class="sidebar">
        <!-- The Mac app reserves this padding strip for the titlebar; presses
             on the bare inset ask the host to move the window (the native
             drag region that used to float here is gone). -->
        <div class="sidebar-shell" @mousedown=${beginNativeWindowDragFromTopInset}>
          ${this.renderBrand()}
          <div class="sidebar-shell__body">
            <nav class="sidebar-nav" @contextmenu=${this.openCustomizeMenuFromContext}>
              <div class="nav-section__items">
                ${this.sidebarPinnedRoutes.map((routeId) => this.renderRoute(routeId))}
                ${this.renderMoreRow()}
              </div>
            </nav>
            ${this.renderSessions()}
          </div>
          <div class="sidebar-shell__footer">
            <openclaw-sidebar-attention
              .onNavigate=${(routeId: NavigationRouteId) => this.onNavigate?.(routeId)}
            ></openclaw-sidebar-attention>
            <openclaw-sidebar-update-card
              .updateAvailable=${this.updateAvailable}
              .updateRunning=${this.updateRunning}
              .onUpdate=${this.onUpdate}
            ></openclaw-sidebar-update-card>
            <openclaw-lobster-pet
              .seed=${lobsterPetSeed(this.sessionKey)}
              .mode=${resolveLobsterPetMode(this.connected, this.sessionsResult?.sessions)}
              .runOutcome=${resolveLobsterRunOutcome(this.sessionsResult?.sessions)}
              .visitsEnabled=${this.lobsterPetVisits}
              .soundsEnabled=${this.lobsterPetSounds}
              .gatewayVersion=${this.gatewayVersion}
            ></openclaw-lobster-pet>
            ${this.devGitBranch
              ? html`<div class="sidebar-footer-branch" title=${this.devGitBranch}>
                  <span class="sidebar-footer-branch__icon" aria-hidden="true"
                    >${icons.gitBranch}</span
                  >
                  <span class="sidebar-footer-branch__name">${this.devGitBranch}</span>
                </div>`
              : nothing}
            <openclaw-sidebar-agent-chip
              .agentName=${chipName}
              .avatarUrl=${chipAgent ? resolveAgentAvatarUrl(chipAgent) : null}
              .avatarText=${chipAvatarText}
              .connected=${this.connected}
              .statusLabel=${gatewayStatus}
              .subtitle=${this.agentChipSubtitle(chipAgentId)}
              .menuOpen=${this.agentMenuPosition !== null}
              .menuUnread=${chipMenuUnread}
              .newSessionDisabled=${!this.connected}
              .onNewSession=${() => this.onOpenNewSession?.(chipAgentId)}
              .onToggleMenu=${(trigger: HTMLElement) => this.toggleAgentMenu(trigger)}
            ></openclaw-sidebar-agent-chip>
          </div>
        </div>
        ${this.renderCustomizeMenu()} ${this.renderMoreMenu()} ${this.renderAgentMenu()}
        ${this.renderSessionMenu()} ${this.renderSessionGroupMenu()} ${this.renderSessionSortMenu()}
      </aside>
    `;
  }
}

if (!customElements.get("openclaw-app-sidebar")) {
  customElements.define("openclaw-app-sidebar", AppSidebar);
}
