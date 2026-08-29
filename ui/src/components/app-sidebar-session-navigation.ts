import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { serializeSidebarEntry } from "../app-navigation.ts";
import { isSessionRouteId } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import { filterVisibleSessionRows, sessionMatchesArchivedFilter } from "../lib/sessions/index.ts";
import { runSessionNavigationIntent } from "../lib/sessions/navigation-handoff.ts";
import {
  composerDraftSearch,
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { AppSidebarBase } from "./app-sidebar-base.ts";
import { projectSidebarArchiveVisibility } from "./app-sidebar-session-archive-visibility.ts";
import {
  adoptedCatalogSessionKeys,
  visibleSessionCatalogProjection,
} from "./app-sidebar-session-catalogs.ts";
import {
  findActiveSidebarLineageRow,
  findSidebarHovercardRow,
  mergeAdoptedSessionPullRequestRows,
} from "./app-sidebar-session-lookup.ts";
import {
  applySidebarSessionOwnerFilter,
  buildReconciledSidebarZone,
  buildSidebarSessionNavigationState,
  collectCategorizedChildRootRows,
  collectPromotedMainChildRows,
  collectSidebarSessionCandidateRows,
  compareSidebarSessionRowsByMode,
  collectKnownSidebarSessionCatalogIds,
  collectKnownSidebarSessionGroups,
  extendSidebarSessionSelection,
  findSidebarMainSessionRow,
  findProjectedSidebarSession,
  someSidebarSessionInTree,
  resolveSidebarAgentChipSubtitle,
  resolveActiveSidebarAgent,
  resolveSidebarHomeAttention,
  resolveLatestSidebarAgentSession,
  resolveSidebarAgentResumeKey,
  resolveSidebarMainSessionKey,
  toggleSidebarSessionSelection,
  type SidebarSessionNavigationState,
} from "./app-sidebar-session-navigation-logic.ts";
import { SessionPullRequestIndicatorsController } from "./app-sidebar-session-pr-indicators.ts";
import {
  SidebarSessionProjection,
  type SidebarVisibleSections,
} from "./app-sidebar-session-projection.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarSessionSortMode,
  loadStoredSidebarSessionStatusFilter,
  loadStoredSidebarSessionsGrouping,
  loadStoredSidebarSessionsShowCron,
  loadStoredSidebarSessionsShowPreview,
  loadStoredSidebarSessionsShowSystem,
  resolveSidebarSessionSortMode,
  storeSidebarSessionSortMode,
  type SidebarRecentSession,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { SessionAttentionController } from "./session-attention-controller.ts";
import { SessionDataController } from "./session-data-controller.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";
import { SessionOwnerFilterController } from "./session-owner-filter-controller.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";

/** Session-row projection, selection, sorting, and agent scope navigation. */
export class AppSidebarSessionNavigationElement extends AppSidebarBase {
  @state() sessionSortMode: SidebarSessionSortMode = loadStoredSidebarSessionSortMode();

  readonly sessionProjection = new SidebarSessionProjection();
  readonly sessionData = new SessionDataController(this);
  readonly sessionPullRequests = new SessionPullRequestIndicatorsController(this, {
    getConnected: () => this.connected,
    getRows: () =>
      mergeAdoptedSessionPullRequestRows({
        rows: this.visibleSessionRowsInOrder(),
        adopted: adoptedCatalogSessionKeys(this.visibleSessionCatalogs()),
        sessionsResult: this.sessionData.sessionsResult,
        sessionResultsByAgent: this.sessionData.sessionResultsByAgent,
        navigationState: this.getSessionNavigationState(),
      }),
    getSelectedAgentId: () => this.selectedAgentIdForSessions(),
    getGateway: () => this.context?.gateway,
    getSessions: () => this.context?.sessions,
  });

  protected readonly compareSidebarSessionRows = (
    a: SessionsListResult["sessions"][number],
    b: SessionsListResult["sessions"][number],
  ) =>
    compareSidebarSessionRowsByMode({
      a,
      b,
      sortMode: this.effectiveSessionSortMode(),
      owners: this.selectedAgentSessionResult()?.owners,
      createdOrder: this.sessionProjection.createdOrder,
    });

  private sessionPeopleSortCapability(): boolean | undefined {
    const owners = this.selectedAgentSessionResult()?.owners;
    return owners ? owners.length >= 2 : undefined;
  }

  sessionPeopleSortAvailable(): boolean {
    return this.sessionPeopleSortCapability() === true;
  }

  effectiveSessionSortMode(): SidebarSessionSortMode {
    // A refresh can temporarily invalidate the owner facet. Render Created
    // without discarding People until an authoritative single-owner list arrives.
    return resolveSidebarSessionSortMode(this.sessionSortMode, this.sessionPeopleSortAvailable());
  }

  effectiveSessionsGrouping(): SidebarSessionsGrouping {
    // Refreshes can temporarily invalidate the owner facet; retain the Person
    // preference so it returns with the authoritative multi-owner list.
    const grouping = this.sessionsGrouping;
    return grouping === "person" && !this.sessionPeopleSortAvailable() ? "category" : grouping;
  }

  setSessionSortMode(mode: SidebarSessionSortMode) {
    this.sessionSortMode = storeSidebarSessionSortMode(mode, this.sessionPeopleSortCapability());
  }

  private readonly sessionOwnerFilter = new SessionOwnerFilterController(this, () => this.context);

  sidebarSessionOwnerFilter() {
    return this.sessionOwnerFilter;
  }

  get sessionOwnerFilterId(): string | null {
    return this.sessionOwnerFilter.ownerId;
  }

  get sessionInvolvingMeFilterActive(): boolean {
    return this.sessionOwnerFilter.involvingMe;
  }

  sessionOwnerOptions: readonly SessionOwnerOption[] = [];
  protected activeSessionOwnerId: string | null = null;
  get sessionOwnerFilterActive() {
    return this.sessionOwnerFilter.ownerId !== null;
  }
  sessionOwnershipVisible = false;

  @state() selectedSessionKeys: ReadonlySet<string> = new Set();
  @state() sessionsGrouping: SidebarSessionsGrouping = loadStoredSidebarSessionsGrouping();
  @state() sessionsShowCron = loadStoredSidebarSessionsShowCron();
  @state() sessionsShowPreview = loadStoredSidebarSessionsShowPreview();
  @state() sessionsShowSystem = loadStoredSidebarSessionsShowSystem();
  @state() sessionsStatusFilter: SidebarSessionStatusFilter =
    loadStoredSidebarSessionStatusFilter();
  @state() hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();

  visibleSessionCatalogs = () =>
    visibleSessionCatalogProjection(
      this.sessionData.sessionCatalogs,
      this.hiddenSessionCatalogIds,
      this.sessionsStatusFilter === "archived",
    );

  private sessionSelectionAnchor: string | null = null;
  private readonly runtimeSampledAtByRow = new WeakMap<GatewaySessionRow, number>();
  private readonly attention = new SessionAttentionController(this);

  declare readonly sidebarNarrationLines: ReadonlyMap<string, string>;
  declare readonly sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest>;
  declare readonly sessionOrganizer: SessionOrganizerController;
  declare readonly sidebarMenus: SidebarMenusController;

  get sessionAttentionContext() {
    return this.context;
  }

  get sessionDataContext() {
    return this.context;
  }

  get collapsedSessionSections(): ReadonlySet<string> {
    return this.sessionOrganizer.collapsedSessionSections;
  }

  dismissTransientMenus(): boolean {
    return this.sidebarMenus.dismissTransientMenus();
  }

  protected closeAgentMenu(options?: { restoreFocus?: boolean }): void {
    this.sidebarMenus.closeAgentMenu(options);
  }

  promoteCreatedSession(sessionKey: string) {
    if (this.sessionProjection.promoteCreatedSession(sessionKey)) {
      this.requestUpdate();
    }
  }

  override updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    if (this.sessionSortMode === "people" && this.sessionPeopleSortCapability() === false) {
      this.setSessionSortMode("created");
    }
    const activeRouteKey = isSessionRouteId(this.activeRouteId) ? this.getRouteSessionKey() : "";
    if (isSessionRouteId(this.activeRouteId)) {
      void this.sessionData.loadActiveSessionLineage(activeRouteKey);
    }
    const pending = [...this.visibleSessionRowsInOrder()];
    while (pending.length > 0) {
      const session = pending.shift();
      if (!session) {
        continue;
      }
      pending.push(...session.children);
      if (
        session.childSessionKeys.length > 0 &&
        (session.visuallyActive || this.isSessionChildrenExpanded(session)) &&
        !this.sessionData.loadedChildSessionKeys.has(session.key) &&
        !this.sessionData.childSessionErrorsByParent.has(session.key) &&
        !this.sessionData.loadingChildSessionKeys.has(session.key)
      ) {
        // Selected collapsed rows need child liveness so delegated work does not look finished.
        void this.sessionData.loadChildSessions(session.key);
      }
    }
    const mainRow = this.mainSessionRow();
    if (
      mainRow &&
      (mainRow.childSessions?.length ?? 0) > 0 &&
      !this.sessionData.loadedChildSessionKeys.has(mainRow.key) &&
      !this.sessionData.childSessionErrorsByParent.has(mainRow.key) &&
      !this.sessionData.loadingChildSessionKeys.has(mainRow.key)
    ) {
      void this.sessionData.loadChildSessions(mainRow.key);
    }
  }

  setSessionOwnerFilter = (ownerId: string | null, involvingMe = false) =>
    this.sessionOwnerFilter.set(ownerId, involvingMe);

  protected applySessionOwnerFilter(
    projected: SidebarRecentSession[],
    ownerFacet: SessionsListResult["owners"],
  ): SidebarRecentSession[] {
    const result = applySidebarSessionOwnerFilter({
      projected,
      ownerFacet,
      selectedOwnerId: this.sessionOwnerFilterId,
      self: this.context?.gateway.snapshot.selfUser,
    });
    this.sessionOwnerFilter.observeOwnerFacet(ownerFacet !== undefined, result.ownerOptions);
    this.sessionOwnerOptions = result.ownerOptions;
    this.sessionOwnershipVisible = result.ownershipVisible;
    this.activeSessionOwnerId = result.activeOwnerId;
    return result.rows;
  }

  public getRouteSessionKey(): string {
    return this.sessionKey.trim() || this.context?.gateway.snapshot.sessionKey.trim() || "";
  }

  getSessionNavigationState(): SidebarSessionNavigationState {
    const routeSessionKey = this.getRouteSessionKey();
    return buildSidebarSessionNavigationState({
      context: this.context,
      routeSessionKey,
      sessionsResult: this.sessionData.sessionsResult,
      activeSession: findActiveSidebarLineageRow(this.sessionData, routeSessionKey),
      sessionsAgentId: this.sessionData.sessionsAgentId,
      showCron: this.sessionsShowCron,
      showSystem: this.sessionsShowSystem,
      statusFilter: this.sessionsStatusFilter,
      compareSessions: this.compareSidebarSessionRows,
      highlightCurrentSession: isSessionRouteId(this.activeRouteId),
      runtimeSampledAtByRow: this.runtimeSampledAtByRow,
      loadingChildSessionKeys: this.sessionData.loadingChildSessionKeys,
      outboxAttentionCountForSessionKey: this.outboxAttentionCountForSession,
      hasSessionDraft: (sessionKey) => this.hasSessionDraft(sessionKey),
      resolveAttention: (row) => this.attention.resolveSessionAttention(row),
      resolveAgentStatusNote: (row) => this.attention.resolveSessionAgentStatus(row)?.note,
    });
  }

  selectedAgentIdForSessions(): string {
    return this.getSessionNavigationState().selectedAgentId;
  }

  sidebarSessionStatusFilter(): SidebarSessionStatusFilter {
    return this.sessionsStatusFilter;
  }

  readonly selectSession = (sessionKey: string) => {
    const navigationState = this.getSessionNavigationState();
    const sessionResultsByAgent = this.sessionData.sessionResultsByAgent;
    const row = findProjectedSidebarSession({ sessionKey, navigationState, sessionResultsByAgent });
    const face = resolveSessionPreferredFace(row);
    const target = sessionNavigationTarget({
      face,
      sessionKey,
      fallbackAgentId: navigationState.selectedAgentId,
      basePath: this.basePath,
      row,
      mainKey: this.sessionMainKey(),
      preferenceDerivedFace: true,
      navigationKey: sessionKey,
    });
    runSessionNavigationIntent(this, {
      commit: () => {
        this.prepareSessionNavigation(sessionKey, target.options.pathname);
        this.onNavigate?.(face, target.options);
        this.bindLiteralSession(sessionKey, this.selectedAgentIdForSessions(), target.options);
        return true;
      },
      face,
      sessionKey,
    });
  };

  /** Collapsed zones keep full rows for true header counts and status dots. */
  protected zonedVisibleSections(rows: SidebarRecentSession[]): SidebarVisibleSections {
    const grouping = this.effectiveSessionsGrouping();
    return this.sessionProjection.project({
      rows,
      grouping,
      knownGroups: grouping === "category" ? this.knownSessionGroups() : [],
      selfOwnerId: this.context?.gateway.snapshot.selfUser?.id ?? null,
      // Normalize gateway order without dropping catalog-lagging categories.
      sectionOrder: this.knownSectionOrder(),
      catalogIds:
        this.sessionsStatusFilter === "archived"
          ? []
          : this.visibleSessionCatalogs().map((catalog) => catalog.id),
      collapsedSections: this.collapsedSessionSections,
      hideEmptyOwnerFilteredGroup: (category, rowCount) =>
        this.sessionOwnerFilterActive && Boolean(category) && rowCount === 0,
      visibleSessionLimits: this.sessionData.visibleSessionLimits,
      sortMode: this.effectiveSessionSortMode(),
      statusFilter: this.sessionsStatusFilter,
      agentId: this.expandedAgentId(),
      connectionIdentity:
        this.context?.gateway.snapshot.phase === "connected"
          ? (this.context.gateway.snapshot.client ?? null)
          : null,
      listSource: this.context?.sessions ?? null,
      subtitle: {
        sidebarLiveActivity: this.sidebarLiveActivity,
        showPreview: this.sessionsShowPreview,
        narrationLines: this.sidebarNarrationLines,
        observerDigests: this.sidebarObserverDigests,
      },
    });
  }

  reconciledSidebarZone() {
    const navigationState = this.getSessionNavigationState();
    const rows = this.selectedAgentSessionRows(navigationState);
    return buildReconciledSidebarZone({
      sidebarEntries: this.sidebarEntries,
      rows,
      workboardBoards: this.workboardBoards,
      enabledRouteIds: this.enabledRouteIds,
      workboardBoardsReady: this.workboardBoardsReady,
      controlUiTabs: this.context?.gateway.snapshot.hello?.controlUiTabs,
    });
  }

  /**
   * Drop one session entry from the persisted zone order (raw list, no
   * reconcile-pruning). Only sidebar-driven unpins call this; other surfaces
   * (e.g. the Sessions page) rely on reconcileSidebarZone's known-unpinned
   * pruning at the next canonical write, which keeps the slot hidden meanwhile.
   */
  pruneSidebarSessionEntry(key: string) {
    const serialized = serializeSidebarEntry({ type: "session", key });
    if (!this.sidebarEntries.includes(serialized)) {
      return;
    }
    this.onUpdateSidebarEntries?.(this.sidebarEntries.filter((entry) => entry !== serialized));
  }

  /** Rows in on-screen order; shift ranges and batch actions share this ordering. */
  protected visibleSessionRowsInOrder(): SidebarRecentSession[] {
    const navigationState = this.getSessionNavigationState();
    const rows = this.selectedAgentSessionRows(navigationState);
    const { visibleRows } = this.zonedVisibleSections(rows);
    const { entries, sessionRows } = this.reconciledSidebarZone();
    const pinnedRows = entries.flatMap((entry) => {
      const row = entry.type === "session" ? sessionRows.get(entry.key) : undefined;
      return row ? [row] : [];
    });
    return [...pinnedRows, ...visibleRows];
  }

  selectedVisibleSessions(): SidebarRecentSession[] {
    if (this.selectedSessionKeys.size === 0) {
      return [];
    }
    return this.visibleSessionRowsInOrder().filter((row) => this.selectedSessionKeys.has(row.key));
  }

  handleSessionRowClick(event: MouseEvent, session: SidebarRecentSession) {
    if (session.isChild && shouldHandleNavigationClick(event)) {
      event.preventDefault();
      this.clearSessionSelection();
      this.selectSession(session.key);
      return;
    }
    if (session.isChild || event.defaultPrevented || event.button !== 0) {
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      this.extendSessionSelection(session.key);
      return;
    }
    if (event.altKey) {
      event.preventDefault();
      this.toggleSessionSelected(session.key);
      return;
    }
    event.preventDefault();
    this.clearSessionSelection();
    this.selectSession(session.key);
  }

  private toggleSessionSelected(key: string) {
    const selection = toggleSidebarSessionSelection(this.selectedSessionKeys, key);
    this.sessionSelectionAnchor = selection.anchor;
    this.selectedSessionKeys = selection.selectedKeys;
  }

  private extendSessionSelection(key: string) {
    const selection = extendSidebarSessionSelection({
      rows: this.visibleSessionRowsInOrder(),
      anchor: this.sessionSelectionAnchor,
      key,
    });
    this.sessionSelectionAnchor = selection.anchor;
    this.selectedSessionKeys = selection.selectedKeys;
  }

  clearSessionSelection() {
    this.sessionSelectionAnchor = null;
    if (this.selectedSessionKeys.size > 0) {
      this.selectedSessionKeys = new Set();
    }
  }

  /** Chip switching selects the agent and refreshes its session list. */
  protected readonly expandAgent = (agentId: string) => {
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
    this.sessionProjection.resetMembership();
    this.sessionData.visibleSessionLimits.clear();
    context.agentSelection.set(nextAgentId);
    void this.sessionData.refreshSidebarSessions(nextAgentId);
  };

  expandedAgentId(): string {
    const selected = normalizeOptionalString(this.context?.agentSelection.state.selectedId);
    return normalizeAgentId(selected || this.getSessionNavigationState().selectedAgentId);
  }

  activeChipAgent() {
    return resolveActiveSidebarAgent({
      activeId: this.expandedAgentId(),
      roster: this.context?.agents.state.agentsList?.agents ?? [],
      identities: this.context?.agentIdentity.entries() ?? [],
    });
  }

  /** Newest visible session for an agent; the chip menu resumes here. */
  private latestAgentSessionRow(agentId: string): SessionsListResult["sessions"][number] | null {
    return resolveLatestSidebarAgentSession({
      agentId,
      sessionData: this.sessionData,
      context: this.context,
    });
  }

  private agentResumeKey(agentId: string): string {
    const latest = this.latestAgentSessionRow(agentId);
    return resolveSidebarAgentResumeKey(latest, agentId, this.sessionMainKey());
  }

  /** Offline routes to Settings instead of a dead chat load. */
  private openAgentConversation(agentId: string) {
    if (!this.connected) {
      this.onNavigate?.("appearance");
      return;
    }
    this.selectSession(this.agentResumeKey(agentId));
  }

  agentChipSubtitle(agentId: string): string {
    return resolveSidebarAgentChipSubtitle(this.latestAgentSessionRow(agentId));
  }

  switchChipAgent(agentId: string) {
    this.closeAgentMenu();
    this.expandAgent(agentId);
    this.openAgentConversation(agentId);
  }

  askAgentCapabilities(agentId: string) {
    this.closeAgentMenu();
    if (!this.connected) {
      return;
    }
    const key = this.agentResumeKey(agentId);
    const target = sessionNavigationTarget({
      face: "chat",
      sessionKey: key,
      fallbackAgentId: agentId,
      basePath: this.basePath,
      row: this.findSidebarSessionByKey(key),
      mainKey: this.sessionMainKey(),
    });
    this.setApplicationSession(key, this.selectedAgentIdForSessions());
    this.onNavigate?.("chat", {
      ...target.options,
      search: composerDraftSearch(t("chat.welcome.suggestions.whatCanYouDo")),
    });
  }

  knownSessionGroups(): string[] {
    return collectKnownSidebarSessionGroups(
      this.context?.sessions.state.groups ?? [],
      this.sessionData.sessionsResult?.sessions ?? [],
    );
  }

  readonly knownSectionOrder = () => [...(this.context?.sessions.state.sectionOrder ?? [])];

  knownSessionCatalogIds(): string[] {
    return collectKnownSidebarSessionCatalogIds({
      loadedCatalogIds: this.sessionData.sessionCatalogs.map((catalog) => catalog.id),
      hasLoaded: this.sessionData.sessionCatalogRefreshStatus.hasLoaded,
      sectionOrder: this.knownSectionOrder(),
    });
  }

  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined {
    const navigationState = this.getSessionNavigationState();
    return findProjectedSidebarSession({
      sessionKey,
      navigationState,
      sessionResultsByAgent: this.sessionData.sessionResultsByAgent,
    });
  }

  findSidebarHovercardRowByKey(sessionKey: string) {
    return findSidebarHovercardRow(this, sessionKey);
  }

  /** The list follows the chip-selected agent without flashing stale rows mid-switch. */
  protected selectedAgentSessionRows(
    navigationState: SidebarSessionNavigationState,
  ): SidebarRecentSession[] {
    const adopted = adoptedCatalogSessionKeys(this.visibleSessionCatalogs());
    const selected = this.expandedAgentId();
    const loadedAgentId = normalizeAgentId(this.sessionData.sessionsAgentId ?? "");
    const routeAgentId = normalizeAgentId(navigationState.selectedAgentId);
    const visibilityOptions = {
      agentId: selected,
      defaultAgentId: resolveUiDefaultAgentId({
        agentsList: this.context?.agents.state.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      }),
      filterByAgent: true,
      showCron: this.sessionsShowCron,
      showSystem: this.sessionsShowSystem,
      archivedFilter: this.sessionsStatusFilter,
    } as const;
    const { childSessionRowsByParent, isSessionHidden, rows } = projectSidebarArchiveVisibility({
      sessionData: this.sessionData,
      selectedAgentId: selected,
      statusFilter: this.sessionsStatusFilter,
      deletionState: (key, agentId) => this.context?.sessions.deletionState(key, agentId),
      archiveVisibility: (key) => this.context?.sessions.archiveVisibility(key),
    });
    const rowsByKey = new Map(rows.map((row) => [row.key, row]));
    const rootRows =
      selected === routeAgentId && selected === loadedAgentId
        ? navigationState.visibleSessionRows.flatMap((session) => {
            const row = rowsByKey.get(session.key);
            return row ? [row] : [];
          })
        : filterVisibleSessionRows(rows, visibilityOptions).toSorted(
            this.compareSidebarSessionRows,
          );
    // The identity card replaces the main row; promote children under all equivalent aliases.
    const mainSessionKey = this.selectedAgentMainSessionKey(selected);
    const lineageRoot = this.sessionData.activeSessionLineageRoot;
    const lineageAgentId = normalizeAgentId(
      parseAgentSessionKey(lineageRoot?.key ?? "")?.agentId ?? "",
    );
    // Adopted catalog keys render as live rows inside the Coding catalog;
    // re-inserting one here would show the selected session twice.
    const selectedFallback = navigationState.visibleSessionRows.find(
      (session) =>
        (selected === routeAgentId || lineageAgentId === selected) &&
        session.key === navigationState.activeRowKey &&
        !isSessionHidden(session.key) &&
        !adopted.has(session.key) &&
        !areUiSessionKeysEquivalent(session.key, mainSessionKey),
    );
    const mainSessionKeys = new Set<string>([mainSessionKey]);
    const scopedRootRows = rootRows.filter((row) => {
      if (areUiSessionKeysEquivalent(row.key, mainSessionKey)) {
        mainSessionKeys.add(row.key);
        return false;
      }
      return true;
    });
    const lineageRouteAgentId = normalizeAgentId(
      parseAgentSessionKey(navigationState.routeSessionKey)?.agentId ?? "",
    );
    if (
      lineageRoot &&
      !isSessionHidden(lineageRoot.key) &&
      (areUiSessionKeysEquivalent(lineageRoot.key, navigationState.routeSessionKey) ||
        sessionMatchesArchivedFilter(lineageRoot, this.sessionsStatusFilter)) &&
      (lineageAgentId === selected || lineageRouteAgentId === selected) &&
      !adopted.has(lineageRoot.key) &&
      !areUiSessionKeysEquivalent(lineageRoot.key, mainSessionKey) &&
      !scopedRootRows.some((row) => row.key === lineageRoot.key)
    ) {
      scopedRootRows.push(lineageRoot);
    }
    const sessionCandidateRows = collectSidebarSessionCandidateRows({
      rows,
      childRowsByParent: childSessionRowsByParent,
    });
    const categorizedChildRows = collectCategorizedChildRootRows({
      rows: sessionCandidateRows,
      scopedRoots: scopedRootRows,
      visibilityOptions,
    });
    scopedRootRows.push(...categorizedChildRows);
    const scopedRootKeys = new Set(scopedRootRows.map((row) => row.key));
    const promotedRows = collectPromotedMainChildRows({
      rows: sessionCandidateRows,
      mainSessionKeys,
      scopedRootKeys,
      showCron: this.sessionsShowCron,
      showSystem: this.sessionsShowSystem,
    });
    for (const row of promotedRows) {
      if (!scopedRootKeys.has(row.key)) {
        scopedRootKeys.add(row.key);
        scopedRootRows.push(row);
      }
    }
    const orderedRootRows =
      promotedRows.length > 0 || categorizedChildRows.length > 0
        ? scopedRootRows.toSorted(this.compareSidebarSessionRows)
        : scopedRootRows;
    // `adopted` holds only catalog-bound keys (adoptedCatalogSessionKeys), not
    // fetched child rows: a catalog-adopted promoted child intentionally
    // renders as its live row inside the Coding catalog, never as a thread.
    const projected = projectSessionTree({
      roots: orderedRootRows.filter((row) => !adopted.has(row.key)),
      agentRows: rows,
      childRowsByParent: childSessionRowsByParent,
      loadingChildKeys: this.sessionData.loadingChildSessionKeys,
      knownSessionAttention: this.attention.knownSessionAttention(),
      toSidebarSession: navigationState.toSidebarSession,
    });
    if (
      selectedFallback &&
      !someSidebarSessionInTree(projected, (row) => row.key === selectedFallback.key)
    ) {
      projected.unshift(navigationState.toSidebarSession(selectedFallback));
    }
    return this.applySessionOwnerFilter(projected, this.selectedAgentSessionResult()?.owners);
  }

  private selectedAgentSessionResult(): SessionsListResult | null {
    const selected = this.expandedAgentId();
    return selected === normalizeAgentId(this.sessionData.sessionsAgentId ?? "")
      ? this.sessionData.sessionsResult
      : (this.sessionData.sessionResultsByAgent[selected] ?? null);
  }

  /** Canonical main-session key for the selected (or given) agent. */
  selectedAgentMainSessionKey(agentId?: string): string {
    return resolveSidebarMainSessionKey({
      agentId: agentId ?? this.expandedAgentId(),
      agentsList: this.context?.agents.state.agentsList,
      hello: this.context?.gateway.snapshot.hello,
    });
  }

  resolveHomeSessionAttention(sessionKey: string, row: GatewaySessionRow | null) {
    return resolveSidebarHomeAttention(this.attention, sessionKey, row);
  }

  /** Gateway row backing the identity card (unread/running state), if loaded. */
  mainSessionRow(agentId?: string): GatewaySessionRow | null {
    const normalized = normalizeAgentId(agentId ?? this.expandedAgentId());
    const mainKey = this.selectedAgentMainSessionKey(normalized);
    const rows =
      normalized === normalizeAgentId(this.sessionData.sessionsAgentId ?? "")
        ? (this.sessionData.sessionsResult?.sessions ?? [])
        : (this.sessionData.sessionResultsByAgent[normalized]?.sessions ?? []);
    return findSidebarMainSessionRow(rows, mainKey);
  }

  /** Identity-card click: the agent's rolling main session, or Settings offline. */
  readonly openMainSession = (agentId: string) => {
    if (!this.connected) {
      this.onNavigate?.("appearance");
      return;
    }
    this.clearSessionSelection();
    this.selectSession(this.selectedAgentMainSessionKey(normalizeAgentId(agentId)));
  };

  isSessionChildrenExpanded(session: SidebarRecentSession): boolean {
    return this.sessionProjection.isChildrenExpanded(session.key);
  }

  isSessionChildrenFullyShown(sessionKey: string): boolean {
    return this.sessionProjection.isChildrenFullyShown(sessionKey);
  }

  toggleSessionChildren(session: SidebarRecentSession) {
    if (!this.sessionProjection.toggleChildren(session).expanded) {
      this.sessionData.discardEmptyChildSessionSnapshot(session.key);
    } else {
      this.sessionData.retryChildSessions(session.key);
    }
    this.requestUpdate();
  }

  showMoreChildren(sessionKey: string) {
    this.sessionProjection.showMoreChildren(sessionKey);
    this.requestUpdate();
  }

  agentUnreadCount(agentId: string): number {
    const rows = this.sessionData.sessionResultsByAgent[normalizeAgentId(agentId)]?.sessions ?? [];
    return rows.filter((row) => row.unread === true && row.archived !== true).length;
  }
}
