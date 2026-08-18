import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PropertyValues } from "lit";
import { state } from "lit/decorators.js";
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
import {
  adoptedCatalogSessionKeys,
  visibleSessionCatalogProjection,
} from "./app-sidebar-session-catalogs.ts";
import {
  applySidebarSessionOwnerFilter,
  buildReconciledSidebarZone,
  buildSidebarSessionNavigationState,
  collectPromotedMainChildRows,
  compareSidebarSessionRowsByMode,
  collectKnownSidebarSessionCatalogIds,
  collectKnownSidebarSessionGroups,
  extendSidebarSessionSelection,
  findSidebarMainSessionRow,
  findProjectedSidebarSession,
  mergeAdoptedSessionPullRequestRows,
  partitionSidebarVisibleSections,
  promoteSidebarSessionCreatedOrder,
  resolveSidebarAgentChipSubtitle,
  resolveActiveSidebarAgent,
  resolveSidebarHomeAttention,
  resolveLatestSidebarAgentSession,
  resolveSidebarAgentResumeKey,
  resolveSidebarMainSessionKey,
  toggleSidebarSessionSelection,
  type SidebarSessionNavigationState,
  type SidebarVisibleSections,
} from "./app-sidebar-session-navigation-logic.ts";
import { SessionPullRequestIndicatorsController } from "./app-sidebar-session-pr-indicators.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarSessionSortMode,
  loadStoredSidebarSessionStatusFilter,
  loadStoredSidebarSessionsGrouping,
  loadStoredSidebarSessionsShowCron,
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
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";

/** Session-row projection, selection, sorting, and agent scope navigation. */
export class AppSidebarSessionNavigationElement extends AppSidebarBase {
  @state() sessionSortMode: SidebarSessionSortMode = loadStoredSidebarSessionSortMode();

  readonly sessionData = new SessionDataController(this);
  private readonly sessionPullRequestIndicators = new SessionPullRequestIndicatorsController(this, {
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
      createdOrder: this.sessionData.sessionCreatedOrder,
    });

  private sessionPeopleSortCapability(): boolean | undefined {
    return this.context?.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities;
  }

  sessionPeopleSortAvailable(): boolean {
    return this.sessionPeopleSortCapability() === true;
  }

  effectiveSessionSortMode(): SidebarSessionSortMode {
    // A reconnect can temporarily hide the capability. Render Created without
    // discarding People until an authoritative single-identity hello arrives.
    return resolveSidebarSessionSortMode(this.sessionSortMode, this.sessionPeopleSortAvailable());
  }

  setSessionSortMode(mode: SidebarSessionSortMode) {
    this.sessionSortMode = storeSidebarSessionSortMode(mode, this.sessionPeopleSortCapability());
  }

  @state() sessionOwnerFilterId: string | null = null;
  @state() sessionInvolvingMeFilterActive = false;

  sessionOwnerOptions: readonly SessionOwnerOption[] = [];
  protected activeSessionOwnerId: string | null = null;
  get sessionOwnerFilterActive() {
    return this.activeSessionOwnerId !== null;
  }
  sessionOwnershipVisible = false;

  @state() selectedSessionKeys: ReadonlySet<string> = new Set();
  @state() protected expandedChildSessionKeys: ReadonlySet<string> = new Set();
  @state() protected collapsedActiveChildSessionKeys: ReadonlySet<string> = new Set();
  @state() fullyShownChildSessionKeys: ReadonlySet<string> = new Set();
  @state() sessionsGrouping: SidebarSessionsGrouping = loadStoredSidebarSessionsGrouping();
  @state() sessionsShowCron = loadStoredSidebarSessionsShowCron();
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
  private collapsedActiveRouteKey: string | null = null;
  private readonly runtimeSampledAtByRow = new WeakMap<GatewaySessionRow, number>();
  private readonly attention = new SessionAttentionController(this);

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
    if (promoteSidebarSessionCreatedOrder(this.sessionData.sessionCreatedOrder, sessionKey)) {
      this.requestUpdate();
    }
  }

  sessionPullRequestIndicatorState(sessionKey: string, worktreeId: string) {
    return this.sessionPullRequestIndicators.state(sessionKey, worktreeId);
  }

  override updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    const selectedId = this.sessionOwnerFilterId;
    const selectedResult = this.selectedAgentSessionResult();
    const owners = selectedResult?.owners;
    const hasParticipants = selectedResult?.sessions.some(
      (session) => (session.participantCount ?? 0) > 0,
    );
    if (this.sessionSortMode === "people" && this.sessionPeopleSortCapability() === false) {
      this.setSessionSortMode("created");
    }
    if (
      selectedId &&
      owners &&
      ((!hasParticipants && owners.length < 2) || !owners.some((owner) => owner.id === selectedId))
    ) {
      this.sessionOwnerFilterId = null;
      void this.context?.sessions.setOwnerFilter(null);
    }
    const activeRouteKey = isSessionRouteId(this.activeRouteId) ? this.getRouteSessionKey() : "";
    if (activeRouteKey !== this.collapsedActiveRouteKey) {
      this.collapsedActiveRouteKey = activeRouteKey;
      if (this.collapsedActiveChildSessionKeys.size > 0) {
        this.collapsedActiveChildSessionKeys = new Set();
      }
    }
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
        this.isSessionChildrenExpanded(session) &&
        !this.sessionData.loadedChildSessionKeys.has(session.key) &&
        !this.sessionData.failedChildSessionKeys.has(session.key) &&
        !this.sessionData.loadingChildSessionKeys.has(session.key)
      ) {
        void this.sessionData.loadChildSessions(session.key);
      }
    }
    const mainRow = this.mainSessionRow();
    if (
      mainRow &&
      (mainRow.childSessions?.length ?? 0) > 0 &&
      !this.sessionData.loadedChildSessionKeys.has(mainRow.key) &&
      !this.sessionData.failedChildSessionKeys.has(mainRow.key) &&
      !this.sessionData.loadingChildSessionKeys.has(mainRow.key)
    ) {
      void this.sessionData.loadChildSessions(mainRow.key);
    }
  }

  protected applySessionOwnerFilter(
    projected: SidebarRecentSession[],
    ownerFacet: SessionsListResult["owners"],
  ): SidebarRecentSession[] {
    const result = applySidebarSessionOwnerFilter({
      projected,
      ownerFacet,
      selectedOwnerId: this.sessionOwnerFilterId,
    });
    this.sessionOwnerOptions = result.ownerOptions;
    this.sessionOwnershipVisible = result.ownershipVisible;
    this.activeSessionOwnerId = result.activeOwnerId;
    return result.rows;
  }

  public getRouteSessionKey(): string {
    return this.sessionKey.trim() || this.context?.gateway.snapshot.sessionKey.trim() || "";
  }

  private activeLineageRow(sessionKey: string): GatewaySessionRow | undefined {
    return [
      this.sessionData.activeSessionLineageSelectedRow,
      this.sessionData.activeSessionLineageRoot,
      ...Object.values(this.sessionData.childSessionRowsByParent).flat(),
    ].find(
      (row): row is GatewaySessionRow =>
        row != null && areUiSessionKeysEquivalent(row.key, sessionKey),
    );
  }

  getSessionNavigationState(): SidebarSessionNavigationState {
    const routeSessionKey = this.getRouteSessionKey();
    return buildSidebarSessionNavigationState({
      context: this.context,
      routeSessionKey,
      sessionsResult: this.sessionData.sessionsResult,
      activeSession: this.activeLineageRow(routeSessionKey),
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
    const face = resolveSessionPreferredFace(this.findSidebarSessionByKey(sessionKey));
    const target = sessionNavigationTarget({
      face,
      sessionKey,
      fallbackAgentId: this.selectedAgentIdForSessions(),
      basePath: this.basePath,
      row: this.findSidebarSessionByKey(sessionKey),
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
    return partitionSidebarVisibleSections({
      rows,
      grouping: this.sessionsGrouping,
      knownGroups: this.sessionsGrouping === "category" ? this.knownSessionGroups() : [],
      // Normalize gateway order without dropping catalog-lagging categories.
      sectionOrder: this.knownSectionOrder(),
      catalogIds:
        this.sessionsStatusFilter === "archived"
          ? []
          : this.sessionData.sessionCatalogs.map((catalog) => catalog.id),
      collapsedSections: this.collapsedSessionSections,
      hideEmptyOwnerFilteredGroup: (category, rowCount) =>
        this.sessionOwnerFilterActive && Boolean(category) && rowCount === 0,
      visibleSessionLimits: this.sessionData.visibleSessionLimits,
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
    const pinnedByKey = new Map(rows.filter((row) => row.pinned).map((row) => [row.key, row]));
    const pinnedRows = this.reconciledSidebarZone().entries.flatMap((entry) =>
      entry.type === "session"
        ? pinnedByKey.get(entry.key)
          ? [pinnedByKey.get(entry.key)!]
          : []
        : [],
    );
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

  readonly replaceCurrentSession = (sessionKey: string) => {
    const face = resolveSessionPreferredFace(this.findSidebarSessionByKey(sessionKey));
    const target = sessionNavigationTarget({
      face,
      sessionKey,
      fallbackAgentId: this.selectedAgentIdForSessions(),
      basePath: this.basePath,
      row: this.findSidebarSessionByKey(sessionKey),
      mainKey: this.sessionMainKey(),
      preferenceDerivedFace: true,
    });
    this.setApplicationSession(sessionKey, this.selectedAgentIdForSessions());
    if (isSessionRouteId(this.activeRouteId)) {
      this.onNavigate?.(face, target.options);
    }
  };

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
    this.expandedChildSessionKeys = new Set();
    this.sessionData.visibleSessionLimits.clear();
    context.agentSelection.set(nextAgentId);
    void this.sessionData.refreshSidebarSessions(nextAgentId);
  };

  expandedAgentId(): string {
    const selected = normalizeOptionalString(this.context?.agentSelection.state.selectedId);
    return selected
      ? normalizeAgentId(selected)
      : normalizeAgentId(this.getSessionNavigationState().selectedAgentId);
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
    return resolveSidebarAgentResumeKey(
      this.latestAgentSessionRow(agentId),
      agentId,
      this.sessionMainKey(),
    );
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

  /** The list follows the chip-selected agent without flashing stale rows mid-switch. */
  protected selectedAgentSessionRows(
    navigationState: SidebarSessionNavigationState,
  ): SidebarRecentSession[] {
    const adopted = adoptedCatalogSessionKeys(this.visibleSessionCatalogs());
    const selected = this.expandedAgentId();
    const loadedAgentId = normalizeAgentId(this.sessionData.sessionsAgentId ?? "");
    const routeAgentId = normalizeAgentId(navigationState.selectedAgentId);
    const rows =
      selected === loadedAgentId
        ? (this.sessionData.sessionsResult?.sessions ?? [])
        : (this.sessionData.sessionResultsByAgent[selected]?.sessions ?? []);
    const rowsByKey = new Map(rows.map((row) => [row.key, row]));
    const rootRows =
      selected === routeAgentId && selected === loadedAgentId
        ? navigationState.visibleSessionRows.flatMap((session) => {
            const row = rowsByKey.get(session.key);
            return row ? [row] : [];
          })
        : filterVisibleSessionRows(rows, {
            agentId: selected,
            defaultAgentId: resolveUiDefaultAgentId({
              agentsList: this.context?.agents.state.agentsList,
              hello: this.context?.gateway.snapshot.hello,
            }),
            filterByAgent: true,
            showCron: this.sessionsShowCron,
            showSystem: this.sessionsShowSystem,
            archivedFilter: this.sessionsStatusFilter,
          }).toSorted(this.compareSidebarSessionRows);
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
    const lineageSelected = Boolean(
      lineageRoot && areUiSessionKeysEquivalent(lineageRoot.key, navigationState.routeSessionKey),
    );
    if (
      lineageRoot &&
      (lineageSelected || sessionMatchesArchivedFilter(lineageRoot, this.sessionsStatusFilter)) &&
      (lineageAgentId === selected || lineageRouteAgentId === selected) &&
      !adopted.has(lineageRoot.key) &&
      !areUiSessionKeysEquivalent(lineageRoot.key, mainSessionKey) &&
      !scopedRootRows.some((row) => row.key === lineageRoot.key)
    ) {
      scopedRootRows.push(lineageRoot);
    }
    const scopedRootKeys = new Set(scopedRootRows.map((row) => row.key));
    const promotedRows = collectPromotedMainChildRows({
      rows,
      childRowsByParent: this.sessionData.childSessionRowsByParent,
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
      promotedRows.length > 0
        ? scopedRootRows.toSorted(this.compareSidebarSessionRows)
        : scopedRootRows;
    // `adopted` holds only catalog-bound keys (adoptedCatalogSessionKeys), not
    // fetched child rows: a catalog-adopted promoted child intentionally
    // renders as its live row inside the Coding catalog, never as a thread.
    const projected = projectSessionTree({
      roots: orderedRootRows.filter((row) => !adopted.has(row.key)),
      agentRows: rows,
      childRowsByParent: this.sessionData.childSessionRowsByParent,
      loadingChildKeys: this.sessionData.loadingChildSessionKeys,
      knownSessionAttention: this.attention.knownSessionAttention(),
      toSidebarSession: navigationState.toSidebarSession,
    });
    if (selectedFallback) {
      const projectedRows = [...projected];
      let selectedAlreadyProjected = false;
      while (projectedRows.length > 0) {
        const row = projectedRows.pop();
        if (row?.key === selectedFallback.key) {
          selectedAlreadyProjected = true;
          break;
        }
        if (row) {
          projectedRows.push(...row.children);
        }
      }
      if (!selectedAlreadyProjected) {
        projected.unshift(navigationState.toSidebarSession(selectedFallback));
      }
    }
    const ownerFacet =
      selected === loadedAgentId
        ? this.sessionData.sessionsResult?.owners
        : this.sessionData.sessionResultsByAgent[selected]?.owners;
    return this.applySessionOwnerFilter(projected, ownerFacet);
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
    return (
      this.expandedChildSessionKeys.has(session.key) ||
      (session.containsActiveDescendant && !this.collapsedActiveChildSessionKeys.has(session.key))
    );
  }

  toggleSessionChildren(session: SidebarRecentSession) {
    const next = new Set(this.expandedChildSessionKeys);
    const collapsedActive = new Set(this.collapsedActiveChildSessionKeys);
    const fullyShown = new Set(this.fullyShownChildSessionKeys);
    if (this.isSessionChildrenExpanded(session)) {
      next.delete(session.key);
      fullyShown.delete(session.key);
      if (session.containsActiveDescendant) {
        collapsedActive.add(session.key);
      }
      this.sessionData.discardEmptyChildSessionSnapshot(session.key);
    } else {
      next.add(session.key);
      collapsedActive.delete(session.key);
      this.sessionData.retryChildSessions(session.key);
    }
    this.expandedChildSessionKeys = next;
    this.collapsedActiveChildSessionKeys = collapsedActive;
    this.fullyShownChildSessionKeys = fullyShown;
  }

  showMoreChildren(sessionKey: string) {
    this.fullyShownChildSessionKeys = new Set(this.fullyShownChildSessionKeys).add(sessionKey);
  }

  agentUnreadCount(agentId: string): number {
    const rows = this.sessionData.sessionResultsByAgent[normalizeAgentId(agentId)]?.sessions ?? [];
    return rows.filter((row) => row.unread === true && row.archived !== true).length;
  }
}
