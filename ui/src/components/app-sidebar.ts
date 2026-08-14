import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { parseSidebarEntry } from "../app-navigation.ts";
import { isSessionRouteId, pathForRoute } from "../app-route-paths.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { t } from "../i18n/index.ts";
import { BoardAvailabilityController } from "../lib/board/availability-controller.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import "./menu-surface.ts";
import "./session-menu.ts";
import "./sidebar-agent-card.ts";
import "./sidebar-attention.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import "./sidebar-update-card.ts";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import { writeSessionDragData } from "../lib/sessions/drag.ts";
import { showToast } from "../lib/toast.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { SETTINGS_SEARCH_TARGETS } from "../pages/config/settings-targets.ts";
import {
  buildSidebarCustomizerEntries,
  buildSidebarCustomizerSections,
  renderSidebarCustomizer,
  type SidebarCustomizerItem,
} from "./app-sidebar-customizer.ts";
import { sidebarPluginTabs } from "./app-sidebar-nav-menus.ts";
import {
  renderAppSidebarAttention,
  renderAppSidebarBrand,
  renderAppSidebarFooterBar,
  renderAppSidebarHomeRow,
  renderAppSidebarMoreRow,
  renderAppSidebarPluginTabEntry,
  renderAppSidebarZoneEntry,
} from "./app-sidebar-render.ts";
import type { SessionCatalogGroupsRenderer } from "./app-sidebar-session-catalog-render.ts";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import { renderSessionList } from "./app-sidebar-session-list-render.ts";
import type {
  SidebarNarrationSyncInput,
  SidebarSessionNarrationController,
} from "./app-sidebar-session-narration.ts";
import type { SidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import {
  renderSessionTree,
  type SessionListHost,
  visibleSessionChildren,
} from "./app-sidebar-session-row-render.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarCatalogGrouping,
  SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
  setStoredSessionCatalogHidden,
  storeSidebarCatalogGrouping,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
} from "./lobster-pet-contract.ts";
import { SessionOrganizerController } from "./session-organizer-controller.ts";
import { type SidebarAutomationAttentionChangeDetail } from "./sidebar-attention.ts";
import { SidebarMenusController } from "./sidebar-menus-controller.ts";
// The shared loader retries transient chunk failures online; a deploy-pruned
// chunk still stays off until reload when that retry fails, by design.
const sidebarChromeImport = createIdleImport(() =>
  Promise.all([
    customElements.get("openclaw-lobster-pet") ? undefined : import("./lobster-pet.ts"),
    customElements.get("openclaw-viewer-facepile") ? undefined : import("./viewer-facepile.ts"),
  ]),
);

class AppSidebar extends AppSidebarSessionNavigationElement implements SessionListHost {
  @state() sidebarNarrationLines: ReadonlyMap<string, string> = new Map();
  @state() sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest> = new Map();
  @state() private sidebarScrolling = false;
  @state() automationAttention = {
    count: 0,
    severity: null as "danger" | "warning" | null,
  };
  @state() private sidebarCustomizerOpen = false;
  @state() private sidebarCustomizerDirty = false;
  @state() private sidebarCustomizerError: string | null = null;

  private sidebarCustomizerReturnFocus: HTMLElement | null = null;
  private sidebarCustomizerSnapshot: {
    sidebarEntries: readonly string[];
    hiddenCatalogIds: ReadonlySet<string>;
    groups: readonly string[];
    sectionOrder: readonly string[];
  } | null = null;

  override readonly sessionOrganizer = new SessionOrganizerController(this);
  override readonly sidebarMenus = new SidebarMenusController(this);

  private readonly handleAutomationAttentionChange = (
    event: CustomEvent<SidebarAutomationAttentionChangeDetail>,
  ) => {
    event.stopPropagation();
    const next = event.detail.automationAttention;
    if (
      next.count !== this.automationAttention.count ||
      next.severity !== this.automationAttention.severity
    ) {
      this.automationAttention = next;
    }
  };

  // Lazy: the controller pulls core token-suppression modules that must stay
  // out of the startup chunk (QA smoke startup-JS budget). It loads on the
  // first update with the preference enabled; earlier events are safely
  // dropped because the controller aligns from cumulative snapshots.
  private narration: SidebarSessionNarrationController | null = null;
  private narrationLoad: Promise<void> | null = null;
  private sidebarScrollIdleTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private sessionNavigationState: SidebarSessionNavigationState | undefined;
  private projectedSessionRows: SidebarRecentSession[] | undefined;
  private readonly narrationSubscriptions = this.createNarrationSubscriptions();
  private readonly nativeGatewaysChanged = () => this.requestUpdate();
  private readonly refreshAppearanceSettings = () => this.context?.theme.refresh();
  private readonly hiddenSessionCatalogsChanged = () => {
    this.hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
  };

  // Catalog rows are non-startup content. Load their renderer through the same
  // idle boundary as other sidebar chrome, then repaint when the chunk arrives.
  private catalogRenderer: SessionCatalogGroupsRenderer | null = null;
  private readonly catalogRendererImport = createIdleImport(
    () => import("./app-sidebar-session-catalog-render.ts"),
    (module) => {
      this.catalogRenderer = module.renderSessionCatalogGroups;
      if (this.isConnected) {
        this.requestUpdate();
      }
    },
  );
  private readonly agentIdentitySubscriptions = new SubscriptionsController(this).watch(
    () => this.context?.agentIdentity,
    (agentIdentity, notify) => agentIdentity.subscribe(notify),
  );

  @state() catalogProjectGrouping = loadStoredSidebarCatalogGrouping();

  constructor() {
    super();
    void this.narrationSubscriptions;
    void this.agentIdentitySubscriptions;
    void new BoardAvailabilityController(
      this,
      () => {
        const mainKey = this.selectedAgentMainSessionKey(this.activeChipAgent().activeId);
        return [
          mainKey,
          ...this.visibleSessionRowsInOrder()
            .filter((session) => !session.isChild)
            .map((session) => session.key),
        ];
      },
      undefined,
      () => {
        const snapshot = this.context?.gateway.snapshot;
        const client = snapshot?.client;
        const availabilityClient =
          client &&
          typeof client.request === "function" &&
          typeof client.addEventListener === "function"
            ? client
            : null;
        return {
          client: availabilityClient,
          connected: snapshot?.phase === "connected",
          available: snapshot ? isGatewayMethodAdvertised(snapshot, "board.get") !== false : false,
          key: `${this.context?.gateway.connection?.gatewayUrl ?? ""}\u0000${
            snapshot?.hello?.server?.version ?? ""
          }`,
        };
      },
    );
  }

  private createNarrationSubscriptions(): SubscriptionsController {
    const subscriptions = new SubscriptionsController(this);
    subscriptions.effect(
      () => this.context?.gateway,
      (gateway) => gateway.subscribeEvents((event) => this.narration?.handleEvent(event)),
    );
    return subscriptions;
  }

  override disconnectedCallback() {
    window.removeEventListener("openclaw:native-gateways-changed", this.nativeGatewaysChanged);
    window.removeEventListener(
      SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
      this.hiddenSessionCatalogsChanged,
    );
    this.narration?.disconnect();
    this.catalogRendererImport.dispose();
    if (this.sidebarScrollIdleTimer) {
      globalThis.clearTimeout(this.sidebarScrollIdleTimer);
      this.sidebarScrollIdleTimer = null;
    }
    super.disconnectedCallback();
  }

  private handleSidebarScroll(element: HTMLElement) {
    this.sessionData.updateSessionsScrollState(element);
    this.sidebarScrolling = true;
    if (this.sidebarScrollIdleTimer) {
      globalThis.clearTimeout(this.sidebarScrollIdleTimer);
    }
    // Keep the otherwise-hidden thumb visible through a scroll gesture, then
    // return it to rest without leaving a permanent rail beside the divider.
    this.sidebarScrollIdleTimer = globalThis.setTimeout(() => {
      this.sidebarScrollIdleTimer = null;
      this.sidebarScrolling = false;
    }, 500);
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    super.willUpdate(changed);
    this.sessionNavigationState = super.getSessionNavigationState();
    this.projectedSessionRows = super.selectedAgentSessionRows(this.sessionNavigationState);
    const chip = this.activeChipAgent();
    // An open switcher tracks roster/reconnect updates; otherwise only hydrate
    // the active card and avoid background RPCs for every configured agent.
    const identityIds =
      this.sidebarMenus.agentMenuPosition === null
        ? [chip.activeId]
        : chip.agents.map((agent) => agent.id);
    this.ensureAgentIdentities(identityIds);
  }

  ensureAgentIdentities(agentIds: readonly string[]): void {
    if (this.connected) {
      void this.context?.agentIdentity.ensure(agentIds);
    }
  }

  override getSessionNavigationState(): SidebarSessionNavigationState {
    return this.sessionNavigationState ?? super.getSessionNavigationState();
  }

  protected override selectedAgentSessionRows(
    navigationState: SidebarSessionNavigationState,
  ): SidebarRecentSession[] {
    return this.projectedSessionRows ?? super.selectedAgentSessionRows(navigationState);
  }

  override updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    if (!this.narration) {
      if (this.sidebarLiveActivity) {
        this.ensureNarrationController();
      }
    } else {
      this.narration.sync(this.narrationSyncInput());
    }
    this.sessionNavigationState = undefined;
    this.projectedSessionRows = undefined;
  }

  private visibleNarrationRowsInOrder(): SidebarRecentSession[] {
    const rows: SidebarRecentSession[] = [];
    const append = (session: SidebarRecentSession) => {
      rows.push(session);
      if (this.isSessionChildrenExpanded(session)) {
        visibleSessionChildren({
          session,
          fullyShownChildSessionKeys: this.fullyShownChildSessionKeys,
        }).forEach(append);
      }
    };
    this.visibleSessionRowsInOrder().forEach(append);
    return rows;
  }

  private narrationSyncInput(): SidebarNarrationSyncInput {
    const gateway = this.context?.gateway.snapshot;
    return {
      enabled: this.sidebarLiveActivity,
      connected: this.connected && gateway?.phase === "connected",
      connectionIdentity: gateway?.client ?? null,
      source: this.context?.sessions ?? null,
      rows: this.visibleNarrationRowsInOrder(),
      openSessionKey: isSessionRouteId(this.activeRouteId) ? this.getRouteSessionKey() : "",
      agentId: this.selectedAgentIdForSessions(),
    };
  }

  private ensureNarrationController(): void {
    if (this.narration || this.narrationLoad) {
      return;
    }
    this.narrationLoad = import("./app-sidebar-session-narration.ts").then((module) => {
      this.narrationLoad = null;
      // The element may have left the DOM while the chunk loaded.
      if (!this.isConnected) {
        return;
      }
      this.narration = new module.SidebarSessionNarrationController(
        (lines) => {
          this.sidebarNarrationLines = lines;
        },
        (digests) => {
          this.sidebarObserverDigests = digests;
        },
      );
      this.narration.sync(this.narrationSyncInput());
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("openclaw:native-gateways-changed", this.nativeGatewaysChanged);
    this.hiddenSessionCatalogsChanged();
    window.addEventListener(
      SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
      this.hiddenSessionCatalogsChanged,
    );
    // The decorative pet's large module stays out of startup and upgrades in place.
    // Its first visit is at least 15 seconds after load, so idle loading cannot miss one.
    sidebarChromeImport.schedule();
    this.catalogRendererImport.schedule();
  }

  protected override firstUpdated() {
    requestAnimationFrame(() => requestAnimationFrame(() => this.classList.add("sidebar-r")));
  }

  startSessionDrag(session: SidebarRecentSession): void {
    this.sessionOrganizer.startSessionDrag(session);
  }

  finishSessionDrag(): void {
    this.sessionOrganizer.finishSessionDrag();
  }

  toggleSessionPin(session: SidebarRecentSession): void {
    void this.sessionOrganizer.patchSession(session, { pinned: !session.pinned });
  }

  toggleSessionMenu(session: SidebarRecentSession, trigger: HTMLElement): void {
    if (this.sidebarMenus.sessionMenu?.session.key === session.key) {
      this.sidebarMenus.closeSessionMenu();
      return;
    }
    const rect = trigger.getBoundingClientRect();
    this.sidebarMenus.openSessionMenu(session, rect.right, rect.bottom + 4, trigger);
  }

  startSidebarSectionDrag(sectionId: string): void {
    this.sessionOrganizer.startSidebarSectionDrag(sectionId);
  }

  finishSidebarSectionDrag(): void {
    this.sessionOrganizer.finishSidebarSectionDrag();
  }

  sectionDragOver(event: DragEvent, sectionId: string, group?: string): void {
    this.sessionOrganizer.sectionDragOver(event, sectionId, group);
  }

  sectionDragLeave(event: DragEvent, sectionId: string, group?: string): void {
    this.sessionOrganizer.sectionDragLeave(event, sectionId, group);
  }

  sectionDrop(event: DragEvent, sectionId: string, group?: string): void {
    this.sessionOrganizer.sectionDrop(event, sectionId, group);
  }

  toggleSection(sectionId: string): void {
    this.sessionOrganizer.toggleSection(sectionId);
  }

  handleSessionListDragOver(event: DragEvent): void {
    this.sessionOrganizer.handleSessionListDragOver(event);
  }

  handleSessionListDragLeave(event: DragEvent): void {
    this.sessionOrganizer.handleSessionListDragLeave(event);
  }

  handleSessionListDrop(event: DragEvent): void {
    this.sessionOrganizer.handleSessionListDrop(event);
  }

  openNewSession(): void {
    this.requestOpenNewSession(this.expandedAgentId());
  }

  setVisibleSessionLimit(sectionId: string, limit: number): void {
    this.sessionData.setVisibleSessionLimit(sectionId, limit);
  }

  loadMoreSidebarSessions(): Promise<void> {
    return this.sessionData.loadMoreSidebarSessions();
  }

  dismissSessionMutationError(): void {
    this.sessionData.dismissSessionMutationError();
  }

  preloadCatalogRenderer() {
    return this.catalogRendererImport.load();
  }

  setCatalogProjectGrouping(next: CatalogProjectGrouping): void {
    storeSidebarCatalogGrouping(next);
    this.catalogProjectGrouping = next;
  }

  hideSessionCatalog(catalogId: string): void {
    const label =
      this.sessionData.sessionCatalogs.find((catalog) => catalog.id === catalogId)?.label ??
      catalogId;
    setStoredSessionCatalogHidden(catalogId, true);
    // Reuse the settings-search destination for the Sidebar preferences block so the
    // toast opens the same place the rest of the app calls "Appearance > Sidebar".
    const recovery = SETTINGS_SEARCH_TARGETS.appearanceSidebar;
    const recoveryHref =
      pathForRoute(recovery.routeId, this.basePath) + recovery.search + recovery.hash;
    // The section disappears instantly and its only standing recovery lives on another
    // page, so the outcome is announced where the action happened: undo here, plus a
    // link that opens the re-enable block for after the toast is gone. Longer than the
    // 6s default because that text is a recovery instruction, not an acknowledgement.
    showToast({
      message: html`${t("chat.sidebar.sectionHidden", { section: label })}
        <a
          class="session-link"
          href=${recoveryHref}
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.onNavigate?.(recovery.routeId, { search: recovery.search, hash: recovery.hash });
          }}
          >${t("chat.sidebar.sectionHiddenRecovery")}</a
        >`,
      actionLabel: t("common.undo"),
      onAction: () => setStoredSessionCatalogHidden(catalogId, false),
      durationMs: 12_000,
    });
  }

  openSidebarCustomizer(trigger: HTMLElement | null = null): void {
    this.sidebarMenus.dismissTransientMenus();
    this.sidebarCustomizerReturnFocus = trigger;
    this.sidebarCustomizerSnapshot = {
      sidebarEntries: [...this.reconciledSidebarZone().sidebarEntries],
      hiddenCatalogIds: new Set(this.hiddenSessionCatalogIds),
      groups: [...(this.context?.sessions.state.groups ?? [])],
      sectionOrder: this.knownSectionOrder(),
    };
    this.sidebarCustomizerDirty = false;
    this.sidebarCustomizerError = null;
    this.sidebarCustomizerOpen = true;
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>(".sidebar-customizer button:not([disabled])")?.focus(),
    );
  }

  private closeSidebarCustomizer(): void {
    this.sidebarCustomizerOpen = false;
    this.sidebarCustomizerDirty = false;
    this.sidebarCustomizerError = null;
    this.sidebarCustomizerSnapshot = null;
    const returnFocus = this.sidebarCustomizerReturnFocus;
    this.sidebarCustomizerReturnFocus = null;
    void this.updateComplete.then(() => {
      if (returnFocus?.isConnected) {
        returnFocus.focus();
      } else {
        this.querySelector<HTMLElement>(".sidebar-nav__more")?.focus();
      }
    });
  }

  private reportSidebarCustomizerError(
    key: "nav.customizeMutationError" | "nav.customizeRestoreError",
  ): void {
    this.sidebarCustomizerError = t(key);
    showToast({ message: this.sidebarCustomizerError });
  }

  private async discardSidebarCustomizerChanges(): Promise<void> {
    const snapshot = this.sidebarCustomizerSnapshot;
    if (!snapshot || !this.sidebarCustomizerDirty) {
      this.closeSidebarCustomizer();
      return;
    }
    let failed = false;
    const updateSidebarEntries = this.onUpdateSidebarEntries;
    try {
      if (updateSidebarEntries) {
        updateSidebarEntries([...snapshot.sidebarEntries]);
      } else {
        failed = true;
      }
    } catch {
      failed = true;
    }
    const catalogIds = new Set([...this.hiddenSessionCatalogIds, ...snapshot.hiddenCatalogIds]);
    for (const catalogId of catalogIds) {
      try {
        setStoredSessionCatalogHidden(catalogId, snapshot.hiddenCatalogIds.has(catalogId));
      } catch {
        failed = true;
      }
    }
    const sessions = this.context?.sessions;
    if (sessions) {
      try {
        await sessions.groupsPut([...snapshot.groups], [...snapshot.sectionOrder]);
      } catch {
        failed = true;
      }
    } else {
      failed = true;
    }
    if (failed) {
      this.reportSidebarCustomizerError("nav.customizeRestoreError");
    } else {
      this.closeSidebarCustomizer();
    }
  }

  private markSidebarCustomizerDirty(): void {
    this.sidebarCustomizerDirty = true;
    this.sidebarCustomizerError = null;
  }

  private toggleSidebarCustomizerItem(item: SidebarCustomizerItem): void {
    if (item.kind === "entry" && item.entry) {
      if (!this.onUpdateSidebarEntries) {
        this.reportSidebarCustomizerError("nav.customizeMutationError");
        return;
      }
      const canonical = this.reconciledSidebarZone().sidebarEntries;
      const next = canonical.includes(item.entry)
        ? canonical.filter((candidate) => candidate !== item.entry)
        : [...canonical, item.entry];
      this.onUpdateSidebarEntries(next);
      this.markSidebarCustomizerDirty();
      return;
    }
    if (item.id.startsWith("catalog:")) {
      try {
        setStoredSessionCatalogHidden(item.id.slice("catalog:".length), item.visible);
        this.markSidebarCustomizerDirty();
      } catch {
        this.reportSidebarCustomizerError("nav.customizeMutationError");
      }
    }
  }

  private removeSidebarCustomizerItem(item: SidebarCustomizerItem): void {
    if (!item.sessionKey) {
      return;
    }
    const session = this.reconciledSidebarZone().sessionRows.get(item.sessionKey);
    if (session) {
      void this.sessionOrganizer.patchSession(session, { pinned: false });
    }
  }

  private sidebarCustomizerEntries(): SidebarCustomizerItem[] {
    const sidebarZone = this.reconciledSidebarZone();
    return buildSidebarCustomizerEntries({
      canonical: sidebarZone.sidebarEntries,
      enabledRouteIds: this.enabledRouteIds,
      pinnedSessions: sidebarZone.sessionRows,
      workboards: this.workboardBoards,
    });
  }

  private sidebarCustomizerSections(): SidebarCustomizerItem[] {
    const navigationState = this.getSessionNavigationState();
    const visibleSessions = this.selectedAgentSessionRows(navigationState);
    const { sections } = this.zonedVisibleSections(visibleSessions);
    return buildSidebarCustomizerSections({
      sections,
      catalogLabels: new Map(
        this.sessionData.sessionCatalogs.map((catalog) => [catalog.id, catalog.label]),
      ),
      hiddenCatalogIds: this.hiddenSessionCatalogIds,
    });
  }

  private renderSidebarCustomizer() {
    return renderSidebarCustomizer({
      entries: this.sidebarCustomizerEntries(),
      sections: this.sidebarCustomizerSections(),
      dirty: this.sidebarCustomizerDirty,
      error: this.sidebarCustomizerError,
      onToggle: (item) => this.toggleSidebarCustomizerItem(item),
      onRemove: (item) => this.removeSidebarCustomizerItem(item),
      onDone: () => this.closeSidebarCustomizer(),
      onBack: () => void this.discardSidebarCustomizerChanges(),
      onEntryDragStart: (event, item) => {
        const entry = item.entry ? parseSidebarEntry(item.entry) : null;
        if (entry?.type === "route") {
          this.sessionOrganizer.startSidebarRouteDrag(event, entry.route);
        } else if (entry?.type === "workboard") {
          this.sessionOrganizer.startSidebarWorkboardDrag(event, entry.boardId);
        } else if (entry?.type === "session") {
          const session = this.reconciledSidebarZone().sessionRows.get(entry.key);
          if (session && event.dataTransfer) {
            writeSessionDragData(event.dataTransfer, session.key);
            this.sessionOrganizer.startSessionDrag(session);
          }
        }
      },
      onEntryDragOver: (event, entry) =>
        this.sessionOrganizer.handleSidebarZoneDragOver(event, entry),
      onEntryDragLeave: (event) => this.sessionOrganizer.handleSidebarZoneDragLeave(event),
      onEntryDrop: (event, entry) => {
        this.markSidebarCustomizerDirty();
        this.sessionOrganizer.handleSidebarZoneDrop(event, entry);
      },
      onSectionDragStart: (sectionId) => this.startSidebarSectionDrag(sectionId),
      onSectionDragOver: (event, sectionId, category) =>
        this.sectionDragOver(event, sectionId, category),
      onSectionDragLeave: (event, sectionId, category) =>
        this.sectionDragLeave(event, sectionId, category),
      onSectionDrop: (event, sectionId, category) => {
        this.markSidebarCustomizerDirty();
        this.sectionDrop(event, sectionId, category);
      },
      onDragEnd: (kind) => {
        if (kind === "section") {
          this.finishSidebarSectionDrag();
        } else {
          this.sessionOrganizer.finishSidebarEntryDrag();
        }
      },
    });
  }

  openCatalogMenu(
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger?: HTMLElement,
  ): void {
    this.sidebarMenus.catalogMenu.open(request, x, y, trigger);
  }

  renderPinnedSidebarSession(session: SidebarRecentSession): TemplateResult {
    // Pinned sessions live in the navigation zone, not a session list, so they
    // carry a chat glyph to match the icon-led Pages entries beside them.
    return renderSessionTree({
      host: this,
      session,
      listItem: false,
      lead: icons.botMessageSquare,
    });
  }

  private renderSessions() {
    const navigationState = this.getSessionNavigationState();
    const visibleSessions = this.selectedAgentSessionRows(navigationState);
    const expandedAgentId = this.expandedAgentId();
    const liveRows = [
      ...(this.sessionData.sessionsResult?.sessions ?? []),
      ...Object.values(this.sessionData.sessionRowsByAgent).flat(),
    ];
    const { sections: allSections } = this.zonedVisibleSections(visibleSessions);
    const catalogs = this.visibleSessionCatalogs();
    const visibleCatalogIds = new Set(catalogs.map((catalog) => catalog.id));
    const sections = allSections.filter(
      (section) => !section.id.startsWith("catalog:") || visibleCatalogIds.has(section.id.slice(8)),
    );
    if (
      !this.catalogRenderer &&
      (catalogs.length > 0 || this.sessionData.sessionCatalogRefreshStatus.error !== null)
    ) {
      void this.preloadCatalogRenderer().catch(() => undefined);
    }
    return renderSessionList({
      host: this,
      empty: visibleSessions.length === 0,
      sections,
      nativeSessionsHaveMore: this.sessionData.sessionsResult?.hasMore === true,
      catalogRenderer: this.catalogRenderer,
      catalogs: {
        catalogs,
        refreshStatus: this.sessionData.sessionCatalogRefreshStatus,
        basePath: this.basePath,
        routeSessionKey: isSessionRouteId(this.activeRouteId) ? this.getRouteSessionKey() : "",
        newSessionAgentId: expandedAgentId,
        mainKey: this.sessionMainKey(),
        loadingMoreCatalogIds: this.sessionData.loadingMoreSessionCatalogIds,
        projectGrouping: this.catalogProjectGrouping,
        liveRows,
        toSidebarSession: navigationState.toSidebarSession,
        creatorId: this.activeSessionCreatorId,
        catalogOpenTarget: this.catalogOpenTarget,
        terminalAvailable: this.terminalAvailable,
      },
    });
  }

  override render() {
    const sidebarZone = this.reconciledSidebarZone();
    return html`
      <aside
        class="sidebar"
        ?data-hover-suppressed=${this.sidebarMenus.sessionMenu !== null}
        @sidebar-automation-attention-change=${this.handleAutomationAttentionChange}
        @contextmenu=${(event: MouseEvent) => {
          // Editable controls keep the platform editing menu; all other sidebar chrome is owned here.
          if (!(event.target as Element).closest("input, textarea, [contenteditable]")) {
            event.preventDefault();
          }
        }}
      >
        <div class="sidebar-shell" @mousedown=${beginNativeWindowDragFromTopInset}>
          ${this.sidebarCustomizerOpen
            ? html`<div class="sidebar-customizer__brand" inert>${renderAppSidebarBrand(this)}</div>
                ${this.renderSidebarCustomizer()}`
            : html`${renderAppSidebarBrand(this)}
                <div
                  class="sidebar-shell__body sidebar-shell__body--scroll-${this.sessionData
                    .sessionsScrollState} ${this.sidebarScrolling
                    ? "sidebar-shell__body--scrolling"
                    : ""}"
                  @scroll=${(event: Event) =>
                    this.handleSidebarScroll(event.currentTarget as HTMLElement)}
                >
                  <nav
                    class="sidebar-nav"
                    @contextmenu=${this.sidebarMenus.openSidebarCustomizerFromContext}
                  >
                    <div
                      class="nav-section__items"
                      @dragover=${(event: DragEvent) =>
                        this.sessionOrganizer.handleSidebarZoneDragOver(event)}
                      @dragleave=${(event: DragEvent) =>
                        this.sessionOrganizer.handleSidebarZoneDragLeave(event)}
                      @drop=${(event: DragEvent) =>
                        this.sessionOrganizer.handleSidebarZoneDrop(event)}
                    >
                      ${renderAppSidebarHomeRow(this)}
                      ${sidebarZone.entries.map((entry) =>
                        renderAppSidebarZoneEntry(
                          this,
                          entry,
                          sidebarZone.sessionRows,
                          sidebarZone.workboardRows,
                        ),
                      )}
                      ${sidebarPluginTabs(this.context?.gateway.snapshot.hello?.controlUiTabs).map(
                        (tab) => renderAppSidebarPluginTabEntry(this, tab),
                      )}
                      ${renderAppSidebarMoreRow(this)}
                    </div>
                  </nav>
                  ${this.renderSessions()}
                </div>
                <div class="sidebar-shell__footer">
                  ${renderAppSidebarAttention(this)}
                  <openclaw-sidebar-update-card
                    .updateAvailable=${this.updateAvailable}
                    .updateSchedule=${this.updateSchedule}
                    .heldUpdateCampaignId=${this.heldUpdateCampaignId}
                    .updateBusy=${this.updateBusy}
                    .statusBanner=${this.updateStatusBanner}
                    .watchUpdateProgress=${this.watchUpdateProgress}
                    .canUpdate=${this.canUpdate}
                    .canHoldUpdate=${this.canHoldUpdate}
                    .onUpdate=${this.onUpdate}
                    .refreshRequired=${this.refreshRequired}
                    .onRefresh=${this.onRefresh}
                    .onHoldUpdate=${this.onHoldUpdate}
                  ></openclaw-sidebar-update-card>
                  <openclaw-lobster-pet
                    .seed=${lobsterPetSeed(this.sessionKey)}
                    .mode=${resolveLobsterPetMode(
                      !this.offline,
                      this.sessionData.sessionsResult?.sessions,
                    )}
                    .runOutcome=${resolveLobsterRunOutcome(
                      this.sessionData.sessionsResult?.sessions,
                    )}
                    .visitsEnabled=${this.lobsterPetVisits}
                    .soundsEnabled=${this.lobsterPetSounds}
                    .gatewayVersion=${this.gatewayVersion}
                    .onVisitsDisabled=${this.refreshAppearanceSettings}
                  ></openclaw-lobster-pet>
                  ${this.devGitBranch
                    ? html`<openclaw-tooltip .content=${this.devGitBranch}>
                        <div class="sidebar-footer-branch">
                          <span class="sidebar-footer-branch__icon" aria-hidden="true"
                            >${icons.gitBranch}</span
                          >
                          <span class="sidebar-footer-branch__name">${this.devGitBranch}</span>
                        </div>
                      </openclaw-tooltip>`
                    : nothing}
                  ${renderAppSidebarFooterBar(this)}
                </div>`}
        </div>
        ${this.sidebarMenus.renderMoreMenu()} ${this.sidebarMenus.renderAgentMenu()}
        ${this.sidebarMenus.renderIdentityMenu()} ${this.sidebarMenus.renderSessionMenu()}
        ${this.sidebarMenus.catalogMenu.render()} ${this.sidebarMenus.renderSessionGroupMenu()}
        ${this.sidebarMenus.renderSessionSortMenu()} ${this.sidebarMenus.renderCatalogViewMenu()}
      </aside>
    `;
  }
}

if (!customElements.get("openclaw-app-sidebar")) {
  customElements.define("openclaw-app-sidebar", AppSidebar);
}
