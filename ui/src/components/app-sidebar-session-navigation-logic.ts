import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { SIDEBAR_NAV_ROUTES, type NavigationRouteId } from "../app-navigation.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import {
  isCronSessionKey,
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkSubtitle,
} from "../lib/session-display.ts";
import { isSessionRunActive } from "../lib/session-run-state.ts";
import {
  groupSidebarSessionRows,
  sidebarSectionHasHeader,
  type SidebarSessionSection,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import {
  compareSessionRowsByUpdatedAt,
  filterVisibleSessionRows,
  isSystemCreatedSessionRow,
  resolveSessionNavigation,
} from "../lib/sessions/index.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  isAcpSessionKey,
  isUiGlobalScopeConfigured,
  normalizeAgentId,
  resolveUiCanonicalMainSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiSessionNavigationParentKey,
} from "../lib/sessions/session-key.ts";
import { reconcileSidebarZone } from "../lib/sidebar-zone.ts";
import {
  limitSidebarSessionRows,
  SIDEBAR_SESSION_NO_ATTENTION,
  SIDEBAR_SESSION_PAGE_SIZE,
  type SidebarRecentSession,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SidebarWorkboardBoard } from "./app-sidebar-workboard.ts";
import { resolveCloudWorkerStopAction } from "./cloud-worker-stop.ts";
import type { SessionAttentionController } from "./session-attention-controller.ts";
import {
  listSessionCreators,
  type SessionCreatedActor,
  type SessionCreatorOption,
} from "./session-owner-chip.ts";

type SessionRow = SessionsListResult["sessions"][number];

export function resolveSidebarHomeAttention(
  attention: SessionAttentionController,
  sessionKey: string,
  row: GatewaySessionRow | null,
) {
  const known = attention
    .knownSessionAttention()
    .find((entry) => areUiSessionKeysEquivalent(entry.sessionKey, sessionKey));
  return (
    known?.attention ??
    (row ? attention.resolveSessionAttention(row) : SIDEBAR_SESSION_NO_ATTENTION)
  );
}

export function compareSidebarSessionRowsByMode(input: {
  a: SessionRow;
  b: SessionRow;
  sortMode: SidebarSessionSortMode;
  creators: SessionsListResult["creators"];
  createdOrder: ReadonlyMap<string, number>;
}): number {
  const { a, b } = input;
  if (input.sortMode !== "people") {
    return input.sortMode === "updated"
      ? compareSessionRowsByUpdatedAt(a, b)
      : compareSidebarSessionRowsByCreatedAt(a, b, input.createdOrder);
  }
  const creators = input.creators ?? [];
  const idA = a.createdActor?.id?.trim() ?? "";
  const idB = b.createdActor?.id?.trim() ?? "";
  if (idA !== idB) {
    const creatorA = creators.find((candidate) => candidate.id === idA);
    const creatorB = creators.find((candidate) => candidate.id === idB);
    const labelA = creatorA?.label?.trim() || a.createdActor?.label?.trim() || idA;
    const labelB = creatorB?.label?.trim() || b.createdActor?.label?.trim() || idB;
    const byCreator = labelA.localeCompare(labelB) || idA.localeCompare(idB);
    if (byCreator !== 0) {
      return byCreator;
    }
  }
  return compareSidebarSessionRowsByCreatedAt(a, b, input.createdOrder);
}

function compareSidebarSessionRowsByCreatedAt(
  a: SessionRow,
  b: SessionRow,
  createdOrder: ReadonlyMap<string, number>,
): number {
  const createdAtA =
    typeof a.createdAt === "number" && Number.isFinite(a.createdAt) && a.createdAt >= 0
      ? a.createdAt
      : null;
  const createdAtB =
    typeof b.createdAt === "number" && Number.isFinite(b.createdAt) && b.createdAt >= 0
      ? b.createdAt
      : null;
  if (createdAtA !== null || createdAtB !== null) {
    if (createdAtA === null) {
      return 1;
    }
    if (createdAtB === null) {
      return -1;
    }
    const byCreatedAt = createdAtB - createdAtA;
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }
  }
  const byObservedOrder =
    (createdOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
    (createdOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER);
  return byObservedOrder || a.key.localeCompare(b.key);
}

function isSidebarDraftOwnedBySelf(
  row: Pick<SessionRow, "createdActor" | "sharingRole" | "visibility">,
  selfUserId: string | undefined,
): boolean {
  return (
    row.visibility === "draft" &&
    (row.sharingRole === "owner" || Boolean(selfUserId && row.createdActor?.id === selfUserId))
  );
}

export type SidebarSessionNavigationState = {
  routeSessionKey: string;
  selectedAgentId: string;
  activeRowKey: string | null;
  visibleSessionRows: GatewaySessionRow[];
  toSidebarSession: (row: SessionRow, isChild?: boolean) => SidebarRecentSession;
};

export function buildSidebarSessionNavigationState(input: {
  context: ApplicationContext<RouteId> | undefined;
  routeSessionKey: string;
  sessionsResult: SessionsListResult | null;
  activeSession?: GatewaySessionRow | null;
  sessionsAgentId: string | null;
  showCron: boolean;
  showSystem: boolean;
  statusFilter: SidebarSessionStatusFilter;
  compareSessions: (a: SessionRow, b: SessionRow) => number;
  highlightCurrentSession: boolean;
  runtimeSampledAtByRow: WeakMap<GatewaySessionRow, number>;
  loadingChildSessionKeys: ReadonlySet<string>;
  outboxAttentionCountForSessionKey: (sessionKey: string) => number;
  hasSessionDraft: (sessionKey: string) => boolean;
  resolveAttention: (row: GatewaySessionRow) => SidebarRecentSession["attention"];
  resolveAgentStatusNote: (row: GatewaySessionRow) => string | undefined;
}): SidebarSessionNavigationState {
  const { context } = input;
  const mainKey = context
    ? resolveUiConfiguredMainKey({
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
      })
    : undefined;
  const navigation = resolveSessionNavigation({
    result: input.sessionsResult,
    activeSession: input.activeSession,
    resultAgentId: input.sessionsAgentId,
    sessionKey: input.routeSessionKey,
    assistantAgentId:
      context?.agentSelection.state.selectedId ?? context?.gateway.snapshot.assistantAgentId,
    hello: context?.gateway.snapshot.hello,
    showCron: input.showCron,
    showSystem: input.showSystem,
    archivedFilter: input.statusFilter,
    compareSessions: input.compareSessions,
  });
  const toSidebarSession = (row: SessionRow, isChild = false): SidebarRecentSession => {
    const channelInfo = resolveChannelSessionInfo(row.key, row.channel);
    let runtimeSampledAt = row.runtimeSampledAt;
    if (row.runtimeMs != null && runtimeSampledAt == null) {
      runtimeSampledAt = input.runtimeSampledAtByRow.get(row);
      if (runtimeSampledAt == null) {
        runtimeSampledAt = Date.now();
        input.runtimeSampledAtByRow.set(row, runtimeSampledAt);
      }
    }
    return {
      key: row.key,
      sessionId: row.sessionId,
      displayName: row.displayName,
      incognito: row.incognito === true,
      createdActor: row.createdActor,
      archivedBy: row.archivedBy,
      // The sidebar's zone structure already says what forked from what;
      // a "Subagent:" prefix on named threads is noise (other surfaces keep it).
      label: resolveSessionDisplayName(row.key, row, { includeSubagentPrefix: false }),
      userLabel: row.label,
      subtitle: resolveSessionWorkSubtitle(row),
      href: sessionNavigationTarget({
        face: resolveSessionPreferredFace(row),
        sessionKey: row.key,
        fallbackAgentId: navigation.selectedAgentId,
        basePath: context?.basePath ?? "",
        row,
        mainKey,
        preferenceDerivedFace: true,
      }).href,
      active: row.key === navigation.activeRowKey,
      visuallyActive: input.highlightCurrentSession && row.key === navigation.currentSessionKey,
      // Normalize optional gateway state before collapsing it to the sidebar's required fact.
      hasActiveRun: row.archived !== true && isSessionRunActive(row),
      gatewayHasActiveRun: row.hasActiveRun,
      activeRunIds: row.archived === true ? undefined : row.activeRunIds,
      modelSelectionLocked: row.modelSelectionLocked === true,
      kind: row.kind,
      pinned: row.pinned === true,
      archived: row.archived === true,
      visibility: row.visibility,
      draftOwnedBySelf: isSidebarDraftOwnedBySelf(row, context?.gateway.snapshot.selfUser?.id),
      category: normalizeOptionalString(row.category),
      icon: normalizeOptionalString(row.icon),
      boardFace: row.boardFace,
      channel: channelInfo.channel,
      channelSession: channelInfo.channelSession,
      workSession:
        Boolean(row.worktree || row.execNode) ||
        context?.sessions.isPreparedWorkSession(row.key) === true,
      acpSession: isAcpSessionKey(row.key),
      worktreeId: row.worktree?.id,
      placementState: row.placement?.state,
      diskSpaceStatus:
        row.placement?.state === "active" ? row.placement.diskSpace?.status : undefined,
      workspaceConflictCount:
        row.placement && "workspaceResultConflict" in row.placement
          ? Math.max(
              row.placement.workspaceResultConflict?.paths.length ?? 0,
              row.placement.workspaceResultConflict?.totalCount ?? 0,
            ) || undefined
          : undefined,
      cloudWorkerStopAction: resolveCloudWorkerStopAction(row.placement),
      hasAutomation: row.hasAutomation === true,
      pullRequest: context?.sessions.pullRequestSummary(row.key),
      outboxAttentionCount: input.outboxAttentionCountForSessionKey(row.key),
      hasComposerDraft: input.hasSessionDraft(row.key),
      unread: row.archived !== true && row.unread === true,
      lastMessagePreview: normalizeOptionalString(row.lastMessagePreview),
      lastReadAt: row.lastReadAt,
      attention: row.archived === true ? SIDEBAR_SESSION_NO_ATTENTION : input.resolveAttention(row),
      agentStatusNote: input.resolveAgentStatusNote(row),
      observerDigest: row.observerDigest,
      spawnedBy: row.spawnedBy,
      forkSource: row.forkSource,
      status: row.status,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      endedAt: row.endedAt,
      runtimeMs: row.runtimeMs,
      runtimeSampledAt,
      childSessionKeys: row.archived === true ? [] : (row.childSessions ?? []),
      children: [],
      isChild,
      loadingChildren: input.loadingChildSessionKeys.has(row.key),
      containsActiveDescendant: false,
      runningChildCount: 0,
      failedChildCount: 0,
    };
  };
  return {
    routeSessionKey: navigation.currentSessionKey,
    selectedAgentId: navigation.selectedAgentId,
    activeRowKey: navigation.activeRowKey,
    visibleSessionRows: navigation.visibleSessions,
    toSidebarSession,
  };
}

export type SidebarVisibleSections = {
  sections: (SidebarSessionSection<SidebarRecentSession> & {
    totalRowCount: number;
    visibleRowCount: number;
    visibleLimit: number;
    collapsedVisibleRowCount: number;
  })[];
  expandedRows: SidebarRecentSession[];
  visibleRows: SidebarRecentSession[];
};

export function partitionSidebarVisibleSections(input: {
  rows: SidebarRecentSession[];
  grouping: SidebarSessionsGrouping;
  knownGroups: string[] | undefined;
  catalogIds?: readonly string[];
  sectionOrder?: readonly string[];
  collapsedSections: ReadonlySet<string>;
  hideEmptyCreatorFilteredGroup: (category: string | undefined, rowCount: number) => boolean;
  visibleSessionLimits: ReadonlyMap<string, number>;
}): SidebarVisibleSections {
  const isCollapsed = (sectionId: string) =>
    sidebarSectionHasHeader(sectionId, input.grouping) && input.collapsedSections.has(sectionId);
  const sections = groupSidebarSessionRows(input.rows, {
    grouping: input.grouping,
    knownGroups: input.knownGroups,
    sectionOrder: input.sectionOrder,
    catalogIds: input.catalogIds,
  }).filter(
    (section) =>
      section.id !== "pinned" &&
      !input.hideEmptyCreatorFilteredGroup(section.category, section.rows.length),
  );
  const expandedRows: SidebarRecentSession[] = [];
  const visibleRows: SidebarRecentSession[] = [];
  // totalRowCount is the pre-pagination size: headers and empty-zone
  // checks must not mistake a page-filtered section for an empty one.
  const limitedSections: SidebarVisibleSections["sections"] = [];
  for (const section of sections) {
    const totalRowCount = section.rows.length;
    const visibleLimit = input.visibleSessionLimits.get(section.id) ?? SIDEBAR_SESSION_PAGE_SIZE;
    const collapsedVisibleRowCount = limitSidebarSessionRows(
      section.rows,
      SIDEBAR_SESSION_PAGE_SIZE,
    ).length;
    let visibleRowCount = 0;
    if (!isCollapsed(section.id)) {
      expandedRows.push(...section.rows);
      section.rows = limitSidebarSessionRows(section.rows, visibleLimit);
      visibleRows.push(...section.rows);
      visibleRowCount = section.rows.length;
    }
    limitedSections.push(
      Object.assign(section, {
        totalRowCount,
        visibleRowCount,
        visibleLimit,
        collapsedVisibleRowCount,
      }),
    );
  }
  return { sections: limitedSections, expandedRows, visibleRows };
}

export function buildReconciledSidebarZone(input: {
  sidebarEntries: readonly string[];
  rows: SidebarRecentSession[];
  workboardBoards: readonly SidebarWorkboardBoard[];
  enabledRouteIds: readonly NavigationRouteId[] | undefined;
  workboardBoardsReady: boolean;
}) {
  const pinnedRows = input.rows.filter((row) => row.pinned);
  // Only loaded rows count as authoritative unpinned state; entries for
  // other agents' sessions must survive canonical writes untouched.
  const knownUnpinnedKeys = new Set(input.rows.filter((row) => !row.pinned).map((row) => row.key));
  const reconciled = reconcileSidebarZone(
    input.sidebarEntries,
    pinnedRows,
    SIDEBAR_NAV_ROUTES,
    knownUnpinnedKeys,
    input.workboardBoards,
    input.enabledRouteIds?.includes("workboard") ?? true,
    input.workboardBoardsReady,
  );
  return {
    ...reconciled,
    sessionRows: new Map(pinnedRows.map((row) => [row.key, row])),
    workboardRows: new Map(input.workboardBoards.map((board) => [board.id, board])),
  };
}

type SidebarSessionSelection = {
  selectedKeys: ReadonlySet<string>;
  anchor: string | null;
};

export function toggleSidebarSessionSelection(
  selectedKeys: ReadonlySet<string>,
  key: string,
): SidebarSessionSelection {
  const next = new Set(selectedKeys);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return { selectedKeys: next, anchor: next.has(key) ? key : null };
}

export function extendSidebarSessionSelection(input: {
  rows: readonly SidebarRecentSession[];
  anchor: string | null;
  key: string;
}): SidebarSessionSelection {
  const anchor =
    input.anchor ?? input.rows.find((row) => row.visuallyActive || row.active)?.key ?? input.key;
  const anchorIndex = input.rows.findIndex((row) => row.key === anchor);
  const targetIndex = input.rows.findIndex((row) => row.key === input.key);
  if (anchorIndex === -1 || targetIndex === -1) {
    return { selectedKeys: new Set([input.key]), anchor: input.key };
  }
  const [start, end] =
    anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  return {
    selectedKeys: new Set(input.rows.slice(start, end + 1).map((row) => row.key)),
    anchor,
  };
}

export function latestVisibleAgentSessionRow(input: {
  agentId: string;
  sessionsAgentId: string | null;
  sessionsResult: SessionsListResult | null;
  sessionRowsByAgent: Readonly<Record<string, SessionsListResult["sessions"]>>;
  defaultAgentId: string;
}): SessionRow | null {
  const normalized = normalizeAgentId(input.agentId);
  const rows =
    normalized === normalizeAgentId(input.sessionsAgentId ?? "")
      ? (input.sessionsResult?.sessions ?? [])
      : (input.sessionRowsByAgent[normalized] ?? []);
  // Unprefixed keys belong to the system default agent. Keeping them for
  // another agent would resume the wrong conversation with the raw key.
  const visible = filterVisibleSessionRows(rows, {
    agentId: normalized,
    defaultAgentId: input.defaultAgentId,
    filterByAgent: true,
    archivedFilter: "active",
  });
  return visible.toSorted(compareSessionRowsByUpdatedAt)[0] ?? null;
}

/**
 * Promote the hidden main session's children to top-level threads, with the
 * same visibility rules as ordinary roots so archived, cron, or
 * system-created children cannot sneak in and pagination stays deterministic.
 */
export function collectPromotedMainChildRows(input: {
  rows: readonly GatewaySessionRow[];
  childRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>;
  mainSessionKeys: ReadonlySet<string>;
  scopedRootKeys: ReadonlySet<string>;
  showCron: boolean;
  showSystem: boolean;
}): GatewaySessionRow[] {
  return [...input.rows, ...Object.values(input.childRowsByParent).flat()].filter((row) => {
    const parentKey = resolveUiSessionNavigationParentKey(row);
    return (
      parentKey != null &&
      input.mainSessionKeys.has(parentKey) &&
      !input.scopedRootKeys.has(row.key) &&
      !row.archived &&
      (input.showCron || !isCronSessionKey(row.key)) &&
      (input.showSystem || !isSystemCreatedSessionRow(row))
    );
  });
}

export function resolveSidebarAgentResumeKey(
  latest: SessionRow | null,
  agentId: string,
  mainKey: string,
): string {
  return latest?.key ?? buildAgentMainSessionKey({ agentId, mainKey });
}

export function resolveSidebarAgentChipSubtitle(latest: SessionRow | null): string {
  if (latest?.hasActiveRun) {
    return t("agentChip.working");
  }
  return latest ? resolveSessionDisplayName(latest.key, latest) : t("agentChip.ready");
}

export function collectKnownSidebarSessionCatalogIds(input: {
  loadedCatalogIds: readonly string[];
  hasLoaded: boolean;
  sectionOrder: readonly string[];
}): string[] {
  if (input.hasLoaded) {
    return [...input.loadedCatalogIds];
  }
  // Until the first authoritative list completes, progressive rows are only
  // a partial view. Preserve stored slots so an unrelated drag cannot erase them.
  const storedCatalogIds = input.sectionOrder.flatMap((sectionId) =>
    sectionId.startsWith("catalog:") ? [sectionId.slice("catalog:".length)] : [],
  );
  return [...new Set([...input.loadedCatalogIds, ...storedCatalogIds])];
}

export function resolveSidebarMainSessionKey(input: {
  agentId: string;
  agentsList: ApplicationContext<RouteId>["agents"]["state"]["agentsList"] | undefined;
  hello: ApplicationContext<RouteId>["gateway"]["snapshot"]["hello"] | undefined;
}): string {
  const host = { agentsList: input.agentsList, hello: input.hello };
  // Global-scope gateways advertise the canonical main session as the
  // literal "global" key; a synthesized agent key would never match it.
  if (isUiGlobalScopeConfigured(host)) {
    return resolveUiCanonicalMainSessionKey(host);
  }
  return buildAgentMainSessionKey({
    agentId: input.agentId,
    mainKey: resolveUiConfiguredMainKey(host),
  });
}

export function findSidebarMainSessionRow(
  rows: readonly GatewaySessionRow[],
  mainKey: string,
): GatewaySessionRow | null {
  return rows.find((row) => areUiSessionKeysEquivalent(row.key, mainKey)) ?? null;
}

export function collectKnownSidebarSessionGroups(
  catalog: readonly string[],
  rows: readonly GatewaySessionRow[],
): string[] {
  const catalogSet = new Set(catalog);
  const discovered = rows
    .map((row) => normalizeOptionalString(row.category))
    .filter((name): name is string => typeof name === "string" && !catalogSet.has(name))
    .toSorted((a, b) => a.localeCompare(b));
  return [...catalog, ...new Set(discovered)];
}

export function findProjectedSidebarSession(input: {
  sessionKey: string;
  navigationState: SidebarSessionNavigationState;
  sessionRowsByAgent: Readonly<Record<string, SessionsListResult["sessions"]>>;
}): SidebarRecentSession | undefined {
  const active = input.navigationState.visibleSessionRows.find(
    (candidate) => candidate.key === input.sessionKey,
  );
  if (active) {
    return input.navigationState.toSidebarSession(active);
  }
  for (const rows of Object.values(input.sessionRowsByAgent)) {
    const row = rows.find((candidate) => candidate.key === input.sessionKey);
    if (row) {
      return input.navigationState.toSidebarSession(row);
    }
  }
  return undefined;
}

export function promoteSidebarSessionCreatedOrder(
  createdOrder: Map<string, number>,
  sessionKey: string,
): boolean {
  const currentOrder = createdOrder.get(sessionKey);
  if (currentOrder === 0) {
    return false;
  }
  for (const [key, order] of createdOrder) {
    if (key !== sessionKey && (currentOrder === undefined || order < currentOrder)) {
      createdOrder.set(key, order + 1);
    }
  }
  createdOrder.set(sessionKey, 0);
  return true;
}

export function applySidebarSessionCreatorFilter(input: {
  projected: readonly SidebarRecentSession[];
  creatorRows: readonly { createdActor?: SessionCreatedActor }[];
  creatorFacet: readonly { id: string; label?: string; avatarUrl?: string }[] | undefined;
  selectedCreatorId: string | null;
}): {
  rows: SidebarRecentSession[];
  creatorOptions: readonly SessionCreatorOption[];
  ownershipVisible: boolean;
  activeCreatorId: string | null;
} {
  const flattened: SidebarRecentSession[] = [];
  const pending = [...input.projected];
  while (pending.length > 0) {
    const row = pending.shift();
    if (row) {
      flattened.push(row);
      pending.push(...row.children);
    }
  }
  const creatorOptions = listSessionCreators([
    ...(input.creatorFacet ?? []).map((creator) => ({
      createdActor: { type: "human" as const, ...creator },
    })),
    ...flattened,
    ...input.creatorRows,
  ]);
  const ownershipVisible = creatorOptions.length >= 2;
  const activeCreatorId = ownershipVisible
    ? creatorOptions.some((creator) => creator.id === input.selectedCreatorId)
      ? input.selectedCreatorId
      : null
    : null;
  if (!activeCreatorId) {
    return { rows: [...input.projected], creatorOptions, ownershipVisible, activeCreatorId };
  }
  const filterTree = (treeRows: readonly SidebarRecentSession[]): SidebarRecentSession[] => {
    const filtered: SidebarRecentSession[] = [];
    for (const row of treeRows) {
      const children = filterTree(row.children);
      if (row.createdActor?.id === activeCreatorId) {
        filtered.push({ ...row, children });
      } else {
        for (const child of children) {
          filtered.push({ ...child, isChild: false });
        }
      }
    }
    return filtered;
  };
  return {
    rows: filterTree(input.projected),
    creatorOptions,
    ownershipVisible,
    activeCreatorId,
  };
}

/** Merge adopted catalog sessions into the visible PR-indicator rows so an
    adopted session hidden from the regular list still surfaces its PR state. */
export function mergeAdoptedSessionPullRequestRows(input: {
  rows: SidebarRecentSession[];
  adopted: ReadonlySet<string>;
  sessionsResult: SessionsListResult | null;
  sessionRowsByAgent: Record<string, GatewaySessionRow[]>;
  navigationState: SidebarSessionNavigationState;
}): SidebarRecentSession[] {
  if (input.adopted.size === 0) {
    return input.rows;
  }
  const byKey = new Map(input.rows.map((row) => [row.key, row]));
  const liveRows = [
    ...(input.sessionsResult?.sessions ?? []),
    ...Object.values(input.sessionRowsByAgent).flat(),
  ];
  for (const row of liveRows) {
    if (input.adopted.has(row.key) && !byKey.has(row.key)) {
      byKey.set(row.key, input.navigationState.toSidebarSession(row));
    }
  }
  return [...byKey.values()];
}
