import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import type {
  FsListDirResult,
  WorktreeRepositoryStatus,
  WorktreesBranchesResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { isSessionRouteId, pathForRoute } from "../app-route-paths.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { t } from "../i18n/index.ts";
import "./session-menu.ts";
import "./sidebar-agent-card.ts";
import "./sidebar-attention.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";
import type { CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import { showToast } from "../lib/toast.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { SETTINGS_ROUTE_TARGETS } from "../pages/config/route-data.ts";
import "../styles/app-sidebar.css";
import { sidebarPluginTabs } from "./app-sidebar-nav-menus.ts";
import {
  renderAppSidebarBrand,
  renderAppSidebarFooterBar,
  renderAppSidebarHomeRow,
  renderAppSidebarOnline,
  renderAppSidebarPagesHead,
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
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import {
  renderSessionTree,
  type SessionListHost,
  visibleSessionChildren,
} from "./app-sidebar-session-row-render.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarCatalogGrouping,
  SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
  SIDEBAR_SESSION_PAGE_SIZE,
  setStoredSessionCatalogHidden,
  storeSidebarCatalogGrouping,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import {
  COMMUNITY_INVITE_KEY,
  dismissCommunityInvite as persistCommunityInviteDismissal,
  isCommunityInviteEligible,
} from "./community-invite-state.ts";
import { icons } from "./icons.ts";
import {
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
} from "./lobster-pet-contract.ts";
import { renderPanelRefreshStatus } from "./panel-refresh-status.ts";
import { SessionOrganizerController } from "./session-organizer-controller.ts";
import { SidebarMenusController } from "./sidebar-menus-controller.ts";
import { SidebarPeopleController } from "./sidebar-people-controller.ts";
// The shared loader retries transient chunk failures online; a deploy-pruned
// chunk still stays off until reload when that retry fails, by design.
const lobsterPetImport = createIdleImport(() => import("./lobster-pet.runtime.ts"));

class AppSidebar extends AppSidebarSessionNavigationElement implements SessionListHost {
  @state() override sidebarNarrationLines: ReadonlyMap<string, string> = new Map();
  @state() override sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest> = new Map();

  override readonly sessionOrganizer = new SessionOrganizerController(this);
  override readonly sidebarMenus = new SidebarMenusController(this);
  private readonly people = new SidebarPeopleController(this);

  sessionGroupDefaults(name: string) {
    if (this.context?.sessions.groupsStatus() !== "ready") {
      return null;
    }
    const group = this.context?.sessions.state.groupSettings.find((entry) => entry.name === name);
    return group ? { cwd: group.cwd ?? "", worktree: group.worktree === true } : null;
  }

  async listSessionGroupFolders(path?: string): Promise<FsListDirResult> {
    const sessions = this.context?.sessions;
    const scope = sessions?.captureConnectionScope();
    if (!sessions || !scope) {
      throw new Error(t("sessionsView.groupDefaultsStale"));
    }
    const result = await scope.client.request<FsListDirResult>("fs.listDir", path ? { path } : {});
    if (this.context?.sessions !== sessions || !sessions.isConnectionScopeCurrent(scope)) {
      throw new Error(t("sessionsView.groupDefaultsStale"));
    }
    return result;
  }

  async inspectSessionGroupRepository(path?: string): Promise<WorktreeRepositoryStatus> {
    const requestedPath = path?.trim() || this.activeChipAgent().agent?.workspace?.trim();
    if (!requestedPath) {
      return "unavailable";
    }
    const sessions = this.context?.sessions;
    const scope = sessions?.captureConnectionScope();
    if (!sessions || !scope) {
      throw new Error(t("sessionsView.groupDefaultsStale"));
    }
    const result = await scope.client.request<WorktreesBranchesResult>("worktrees.branches", {
      repoRoot: requestedPath,
      includeRepositoryStatus: true,
    });
    if (this.context?.sessions !== sessions || !sessions.isConnectionScopeCurrent(scope)) {
      throw new Error(t("sessionsView.groupDefaultsStale"));
    }
    return result.repositoryStatus === "git" || result.repositoryStatus === "not_git"
      ? result.repositoryStatus
      : "unavailable";
  }

  // Lazy: the controller pulls core token-suppression modules that must stay
  // out of the startup chunk (QA smoke startup-JS budget). It loads on the
  // first update with the preference enabled; earlier events are safely
  // dropped because the controller aligns from cumulative snapshots.
  private narration: SidebarSessionNarrationController | null = null;
  private narrationLoad: Promise<void> | null = null;
  private sessionNavigationState: SidebarSessionNavigationState | undefined;
  private projectedSessionRows: SidebarRecentSession[] | undefined;
  private projectedSessionSections: SidebarVisibleSections = {
    sections: [],
    expandedRows: [],
    visibleRows: [],
  };
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => gateway.subscribeEvents((event) => this.narration?.handleEvent(event)),
    )
    .watch(
      () => this.context?.agentIdentity,
      (agentIdentity, notify) => agentIdentity.subscribe(notify),
    )
    .watch(
      () => this.context?.config,
      (config, notify) => config.subscribe(notify),
      () => this.syncCommunityInviteState(),
    );
  private readonly nativeGatewaysChanged = () => this.sidebarMenus.closeSessionMenu();
  private readonly refreshAppearanceSettings = () => this.context?.theme.refresh();
  private readonly hiddenSessionCatalogsChanged = () => {
    this.hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
  };
  @state() private communityInviteEligible = false;
  @state() private communityInviteCardLoaded = false;
  private readonly communityInviteCardImport = createIdleImport(
    () => import("./community-invite-card.ts"),
    () => {
      this.communityInviteCardLoaded = true;
    },
  );
  private readonly communityInviteStorageChanged = (event: StorageEvent) => {
    if (event.key === COMMUNITY_INVITE_KEY || event.key === null) {
      this.syncCommunityInviteState();
    }
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
  @state() catalogProjectGrouping = loadStoredSidebarCatalogGrouping();

  constructor() {
    super();
    void this.subscriptions;
  }

  override dismissTransientMenus(): boolean {
    const hadPersonCard = this.people.dismiss();
    return super.dismissTransientMenus() || hadPersonCard;
  }

  override disconnectedCallback() {
    window.removeEventListener("openclaw:native-gateways-changed", this.nativeGatewaysChanged);
    window.removeEventListener(
      SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
      this.hiddenSessionCatalogsChanged,
    );
    this.narration?.disconnect();
    this.catalogRendererImport.dispose();
    this.communityInviteCardImport.dispose();
    window.removeEventListener("storage", this.communityInviteStorageChanged);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    super.willUpdate(changed);
    const currentResult = this.sessionData.sessionsResult;
    this.sessionProjection.observeRows([
      ...(currentResult ? [currentResult] : []),
      ...Object.values(this.sessionData.sessionResultsByAgent),
    ]);
    this.sessionNavigationState = super.getSessionNavigationState();
    this.projectedSessionRows = super.selectedAgentSessionRows(this.sessionNavigationState);
    this.projectedSessionSections = super.zonedVisibleSections(this.projectedSessionRows);
    // An open switcher tracks roster/reconnect updates; otherwise only hydrate
    // the active card and avoid background RPCs for every configured agent.
    const identityIds =
      this.sidebarMenus.agentMenuPosition === null
        ? [this.expandedAgentId()]
        : this.activeChipAgent().agents.map((agent) => agent.id);
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

  protected override zonedVisibleSections(_rows: SidebarRecentSession[]): SidebarVisibleSections {
    return this.projectedSessionSections;
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
          fullyShown: this.isSessionChildrenFullyShown(session.key),
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
    window.addEventListener("storage", this.communityInviteStorageChanged);
    this.syncCommunityInviteState();
    // The decorative pet's large module stays out of startup and upgrades in place.
    // Its first visit is at least 15 seconds after load, so idle loading cannot miss one.
    lobsterPetImport.schedule();
    this.catalogRendererImport.schedule();
  }

  private syncCommunityInviteState() {
    this.communityInviteEligible =
      this.context?.config.current.communityInvite === true && isCommunityInviteEligible();
    if (this.communityInviteEligible) {
      this.communityInviteCardImport.schedule();
    } else {
      this.communityInviteCardImport.dispose();
    }
  }

  private readonly dismissCommunityInvite = () => {
    const result = persistCommunityInviteDismissal();
    this.syncCommunityInviteState();
    if (!result.ok) {
      showToast({ message: t("communityInvite.dismissFailed") });
    }
  };

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
    if (!this.collapsedSessionSections.has(sectionId)) {
      this.sessionProjection.resetMembership(sectionId);
    }
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

  setVisibleSessionLimit(sectionId: string, limit: number): void {
    const previousLimit =
      this.sessionData.visibleSessionLimits.get(sectionId) ?? SIDEBAR_SESSION_PAGE_SIZE;
    if (limit < previousLimit) {
      this.sessionProjection.resetMembership(sectionId);
    }
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
    const recovery = SETTINGS_ROUTE_TARGETS.appearanceSidebar;
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

  openCatalogMenu(
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger?: HTMLElement,
  ): void {
    this.sidebarMenus.catalogMenu.open(request, x, y, trigger);
  }

  retargetCatalogMenuTrigger(key: CatalogSessionKey, element: Element | undefined): void {
    this.sidebarMenus.catalogMenu.retargetTrigger(key, element);
  }

  renderPinnedSidebarSession(session: SidebarRecentSession): TemplateResult {
    // Pinned sessions live in the navigation zone, not a session list.
    return renderSessionTree({ host: this, session, listItem: false });
  }

  private renderSessions() {
    const navigationState = this.getSessionNavigationState();
    const visibleSessions = this.selectedAgentSessionRows(navigationState);
    const expandedAgentId = this.expandedAgentId();
    const liveRows = [
      ...(this.sessionData.sessionsResult?.sessions ?? []),
      ...Object.values(this.sessionData.sessionResultsByAgent).flatMap((result) => result.sessions),
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
        basePath: this.basePath,
        routeSessionKey: isSessionRouteId(this.activeRouteId) ? this.getRouteSessionKey() : "",
        newSessionAgentId: expandedAgentId,
        mainKey: this.sessionMainKey(),
        loadingMoreCatalogIds: this.sessionData.loadingMoreSessionCatalogIds,
        projectGrouping: this.catalogProjectGrouping,
        liveRows,
        toSidebarSession: navigationState.toSidebarSession,
        ownerId: this.activeSessionOwnerId,
        catalogOpenTarget: this.catalogOpenTarget,
        terminalAvailable: this.terminalAvailable,
      },
    });
  }

  override render() {
    const sidebarZone = this.reconciledSidebarZone();
    const occupiedPluginPlacements = new Set(
      sidebarZone.entries.flatMap((entry) =>
        entry.type === "route" ? [`route:${entry.route}`] : [],
      ),
    );
    return html`
      <aside
        class="sidebar"
        @contextmenu=${(event: MouseEvent) => {
          // Editable controls keep the platform editing menu; all other sidebar chrome is owned here.
          if (!(event.target as Element).closest("input, textarea, [contenteditable]")) {
            event.preventDefault();
          }
        }}
      >
        <div class="sidebar-shell" @mousedown=${beginNativeWindowDragFromTopInset}>
          ${renderAppSidebarBrand(this)}
          <div class="sidebar-shell__content">
            <div
              class="sidebar-shell__body sidebar-shell__body--scroll-${this.sessionData
                .sessionsScrollState}"
              @scroll=${(event: Event) =>
                this.sessionData.updateSessionsScrollState(event.currentTarget as HTMLElement)}
            >
              <nav
                class="sidebar-nav"
                @contextmenu=${this.sidebarMenus.openCustomizeMenuFromContext}
              >
                ${renderAppSidebarPagesHead(this)}
                <div
                  class="nav-section__items"
                  @dragover=${(event: DragEvent) =>
                    this.sessionOrganizer.handleSidebarZoneDragOver(event)}
                  @dragleave=${(event: DragEvent) =>
                    this.sessionOrganizer.handleSidebarZoneDragLeave(event)}
                  @drop=${(event: DragEvent) => this.sessionOrganizer.handleSidebarZoneDrop(event)}
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
                  ${sidebarPluginTabs(this.context?.gateway.snapshot.hello?.controlUiTabs)
                    .filter((tab) => !tab.placement || !occupiedPluginPlacements.has(tab.placement))
                    .map((tab) => renderAppSidebarPluginTabEntry(this, tab))}
                </div>
              </nav>
              ${renderAppSidebarOnline(this)} ${this.renderSessions()}
            </div>
            ${this.sessionsStatusFilter === "archived"
              ? nothing
              : renderPanelRefreshStatus({
                  status: this.sessionData.sessionCatalogRefreshStatus,
                  onRetry: () => void this.sessionData.refreshSessionCatalogs(),
                  className: "sidebar-session-error sidebar-session-catalog-error",
                })}
          </div>
          <div class="sidebar-shell__invite">
            ${this.communityInviteEligible && this.communityInviteCardLoaded
              ? html`<openclaw-community-invite-card
                  .onDismiss=${this.dismissCommunityInvite}
                ></openclaw-community-invite-card>`
              : nothing}
            <openclaw-lobster-pet
              .seed=${lobsterPetSeed(this.sessionKey)}
              .mode=${resolveLobsterPetMode(
                !this.offline,
                this.sessionData.sessionsResult?.sessions,
              )}
              .runOutcome=${resolveLobsterRunOutcome(this.sessionData.sessionsResult?.sessions)}
              .visitsEnabled=${this.lobsterPetVisits}
              .soundsEnabled=${this.lobsterPetSounds}
              .gatewayVersion=${this.gatewayVersion}
              .onVisitsDisabled=${this.refreshAppearanceSettings}
            ></openclaw-lobster-pet>
          </div>
          <div class="sidebar-shell__footer">
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
          </div>
        </div>
        ${this.sidebarMenus.renderCustomizeMenu()} ${this.sidebarMenus.renderMoreMenu()}
        ${this.sidebarMenus.renderAgentMenu()} ${this.sidebarMenus.renderIdentityMenu()}
        ${this.sidebarMenus.renderSessionMenu()} ${this.sidebarMenus.catalogMenu.render()}
        ${this.sidebarMenus.renderSessionGroupMenu()} ${this.sidebarMenus.renderSessionSortMenu()}
        ${this.sidebarMenus.renderCatalogViewMenu()}
      </aside>
    `;
  }
}

if (!customElements.get("openclaw-app-sidebar")) {
  customElements.define("openclaw-app-sidebar", AppSidebar);
}
