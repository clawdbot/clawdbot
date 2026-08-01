import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMetaBatch } from "../acp/runtime/session-meta.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagent-registry-read.js";
import { shouldKeepSubagentRunChildLink } from "../agents/subagent-run-liveness.js";
import type { SessionEntry } from "../config/sessions.js";
import type { SessionEntryListQuery } from "../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPinnedActivePluginRegistryWorkspaceDir } from "../plugins/runtime-workspace-state.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { readSessionTitleFieldsFromTranscriptAsync as readScopedSessionTitleFieldsFromTranscriptAsync } from "./session-transcript-title-reader.js";
import type {
  SessionActorProfileIdentity,
  SessionListRowContext,
  SessionListRowContextProvider,
} from "./session-utils-contracts.js";
import { shouldKeepStoreOnlyChildLink } from "./session-utils-core.js";
import { getSessionDefaults } from "./session-utils-model.js";
import {
  buildSessionListRowContext,
  buildSessionListRowMetadataContext,
  buildSingleRowStoreChildSessionsByKey,
} from "./session-utils-projection.js";
import { buildGatewaySessionRow, projectSessionActor } from "./session-utils-row.js";
import {
  appendStoredSessionModelSearchFields,
  matchesSessionListSearch,
  resolveSessionListRowContext,
  resolveSessionListSearchDisplayName,
  resolveSessionListSearchModelFields,
  shouldResolveDerivedSessionModelSearchFields,
} from "./session-utils-search.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";

/**
 * Number of session rows to build per batch before yielding to the event loop.
 * Keeps the main thread responsive during large session list operations while
 * avoiding excessive yielding overhead for small stores.
 */
const SESSIONS_LIST_YIELD_BATCH_SIZE = 10;

const SESSIONS_LIST_DEFAULT_LIMIT = 100;
const SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS = 100;
const SESSIONS_LIST_TRANSCRIPT_USAGE_MAX_BYTES = 64 * 1024;

type SessionEntryPair = [string, SessionEntry];

function compareSessionEntries(
  left: SessionEntryPair,
  right: SessionEntryPair,
  sortBy: SessionsListParams["sortBy"],
): number {
  const pinned =
    sortBy === "lastInteractionAt" ? 0 : (right[1].pinnedAt ?? 0) - (left[1].pinnedAt ?? 0);
  const timestamp =
    (sortBy === "lastInteractionAt" ? (right[1].lastInteractionAt ?? 0) : right[1].updatedAt) -
    (sortBy === "lastInteractionAt" ? (left[1].lastInteractionAt ?? 0) : left[1].updatedAt);
  return pinned || timestamp || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
}

type SessionEntrySelection = {
  entries: SessionEntryPair[];
  creatorEntries: SessionEntryPair[];
  totalCount: number;
  limitApplied?: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
};

type SqlSessionEntrySelection = {
  creatorActors?: readonly NonNullable<SessionEntry["createdActor"]>[];
  creatorFilterApplied?: boolean;
  lineage?: SessionListLineageSqlQuery;
  ordered?: boolean;
  totalCount?: number;
};

type SessionListBuildParams = {
  cfg: OpenClawConfig;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
  storePath: string;
  store: Record<string, SessionEntry>;
  modelCatalog?: ModelCatalogEntry[];
  opts: SessionsListParams;
  rowContextStore?: Record<string, SessionEntry>;
  sqlSelection: SqlSessionEntrySelection;
};

type SessionListLineageSqlQuery = {
  excludeLineageSessionKeys?: string[];
  includeLineageSessionKeys?: string[];
  lineageKeys?: string[];
};

/** Converts the current runtime lineage snapshot into exact SQL include/exclude keys. */
export function resolveSessionListLineageSqlQuery(
  spawnedBy: string | undefined,
  now = Date.now(),
): SessionListLineageSqlQuery {
  const parentKey = normalizeOptionalString(spawnedBy);
  if (!parentKey) {
    return {};
  }
  const index = buildSubagentSessionListReadIndex(now);
  const canonicalChildKeys = new Set<string>();
  for (const runs of index.runsByControllerSessionKey.values()) {
    for (const run of runs) {
      if (run.childSessionKey.trim()) {
        canonicalChildKeys.add(run.childSessionKey.trim());
      }
    }
  }
  const childKeys = new Set<string>();
  const include = new Set<string>();
  for (const childKey of canonicalChildKeys) {
    childKeys.add(childKey);
    const latest = index.getDisplaySubagentRun(childKey);
    const owner =
      normalizeOptionalString(latest?.controllerSessionKey) ||
      normalizeOptionalString(latest?.requesterSessionKey);
    if (
      latest &&
      owner === parentKey &&
      shouldKeepSubagentRunChildLink(latest, {
        activeDescendants: index.countActiveDescendantRuns(childKey),
        now,
      })
    ) {
      include.add(childKey);
    }
  }
  // Registry ownership overrides stale stored lineage after a child moves. These sets project
  // that authority into SQL; combined-store federation remains with the deferred goal-3 follow-up.
  return {
    ...(childKeys.size > 0 ? { excludeLineageSessionKeys: [...childKeys] } : {}),
    ...(include.size > 0 ? { includeLineageSessionKeys: [...include] } : {}),
    lineageKeys: [parentKey],
  };
}

export function buildSessionListSqlQuery(
  opts: SessionsListParams,
  params: { bounded: boolean; includeCreatorFilter: boolean; mainKey?: string; now: number },
): { lineage: SessionListLineageSqlQuery; query: SessionEntryListQuery } {
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;
  const lineage = resolveSessionListLineageSqlQuery(opts.spawnedBy, params.now);
  const lineageRequiresResidual = (lineage.excludeLineageSessionKeys?.length ?? 0) > 400;
  const query: SessionEntryListQuery = {
    archived: opts.archived ?? false,
    includeGlobal: opts.includeGlobal === true,
    includeUnknown: !opts.agentId && opts.includeUnknown === true,
    mainKey: params.mainKey,
    sortBy: opts.sortBy ?? "updatedAt",
    ...(lineageRequiresResidual ? { selectionResidual: true } : lineage),
  };
  if (activeMinutes !== undefined) {
    query.activeAfter = params.now - activeMinutes * 60_000;
  }
  const creatorId = normalizeOptionalString(opts.creatorId);
  const label = normalizeOptionalString(opts.label);
  const spawnedBy = normalizeOptionalString(opts.spawnedBy);
  const hasResidualFacetFilter =
    lineageRequiresResidual ||
    Boolean(normalizeOptionalString(opts.search)) ||
    Boolean(opts.boardFace) ||
    opts.requireLastInteraction === true;
  if (params.includeCreatorFilter && !hasResidualFacetFilter && creatorId) {
    query.createdActorId = creatorId;
  }
  if (label) {
    query.label = label;
  }
  if (spawnedBy && !lineageRequiresResidual) {
    query.spawnedBy = spawnedBy;
  }
  if (opts.requireLastInteraction) {
    query.requireLastInteraction = true;
  }
  // Callers set bounded only after proving every requested filter is represented in SQL;
  // search and boardFace remain residual and therefore always load the full candidate set.
  if (
    params.bounded &&
    !lineageRequiresResidual &&
    !normalizeOptionalString(opts.search) &&
    !opts.boardFace &&
    !opts.requireLastInteraction
  ) {
    query.limit = resolveSessionsListOffset(opts) + (resolveSessionsListLimit(opts, 100) ?? 100);
  }
  return { lineage, query };
}

function populateSessionListAcpMetadata(params: {
  cfg: OpenClawConfig;
  entries: readonly SessionEntryPair[];
  opts: SessionsListParams;
  rowContext?: SessionListRowContext;
}): void {
  if (!params.rowContext || params.entries.length === 0) {
    return;
  }
  const entries = params.entries.map(([key, entry]) => {
    const parsed = parseAgentSessionKey(key);
    const agentId = normalizeAgentId(
      key === "global" && typeof params.opts.agentId === "string"
        ? params.opts.agentId
        : (parsed?.agentId ?? resolveDefaultAgentId(params.cfg)),
    );
    return {
      sessionKey: resolveStoredSessionKeyForAgentStore({
        cfg: params.cfg,
        agentId,
        sessionKey: key,
      }),
      entry,
    };
  });
  params.rowContext.acpSessionMetaByEntry = readAcpSessionMetaBatch({ entries });
}

function resolveSessionsListLimit(
  opts: SessionsListParams,
  defaultLimit?: number,
): number | undefined {
  if (typeof opts.limit !== "number" || !Number.isFinite(opts.limit)) {
    return defaultLimit;
  }
  return Math.max(1, Math.floor(opts.limit));
}

function resolveSessionsListOffset(opts: SessionsListParams): number {
  if (typeof opts.offset !== "number" || !Number.isFinite(opts.offset)) {
    return 0;
  }
  return Math.max(0, Math.floor(opts.offset));
}

function resolveSessionsListWindowLimit(limit: number | undefined, offset: number) {
  if (limit === undefined) {
    return undefined;
  }
  const windowLimit = offset + limit;
  return Number.isFinite(windowLimit) ? Math.min(windowLimit, Number.MAX_SAFE_INTEGER) : undefined;
}

function filterResidualSessionEntries(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  opts: SessionsListParams;
  now: number;
  rowContext?: SessionListRowContext;
  getRowContext?: SessionListRowContextProvider;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
  sqlSelection: SqlSessionEntrySelection;
}): SessionEntryPair[] {
  const { cfg, store, opts } = params;
  const boardFace = opts.boardFace;
  const search = normalizeLowercaseStringOrEmpty(opts.search);
  const spawnedBy = normalizeOptionalString(opts.spawnedBy);
  const lineage =
    params.sqlSelection?.lineage ?? resolveSessionListLineageSqlQuery(spawnedBy, params.now);

  let entries = Object.entries(store)
    .filter(([key, entry]) => !params.entryFilter || params.entryFilter(key, entry))
    .filter(([key, entry]) => {
      if (!spawnedBy) {
        return true;
      }
      if (key === "global" || key === "unknown") {
        // Reserved canonical sentinels cannot be children of a logical session.
        return false;
      }
      if (lineage.excludeLineageSessionKeys?.includes(key)) {
        return lineage.includeLineageSessionKeys?.includes(key) === true;
      }
      return (
        shouldKeepStoreOnlyChildLink(entry, params.now) &&
        (entry.spawnedBy === spawnedBy || entry.parentSessionKey === spawnedBy)
      );
    })
    .filter(([, entry]) => {
      if (opts.requireLastInteraction !== true) {
        return true;
      }
      return !normalizeOptionalString(entry?.heartbeatIsolatedBaseSessionKey);
    })
    .filter(([, entry]) => {
      if (!boardFace) {
        return true;
      }
      return entry?.boardFace === boardFace;
    });

  if (search) {
    entries = entries.filter(([key, entry]) => {
      const cheapFields = [
        resolveSessionListSearchDisplayName(key, entry),
        entry?.label,
        entry?.subject,
        entry?.sessionId,
        key,
      ];
      appendStoredSessionModelSearchFields(cheapFields, entry);
      if (matchesSessionListSearch(cheapFields, search)) {
        return true;
      }
      if (!shouldResolveDerivedSessionModelSearchFields(search)) {
        return false;
      }
      const searchRowContext = resolveSessionListRowContext(params);
      return matchesSessionListSearch(
        resolveSessionListSearchModelFields({
          cfg,
          key,
          entry,
          rowContext: searchRowContext,
        }),
        search,
      );
    });
  }

  return entries;
}

function selectSessionEntries(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  opts: SessionsListParams;
  now: number;
  rowContext?: SessionListRowContext;
  getRowContext?: SessionListRowContextProvider;
  defaultLimit?: number;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
  sqlSelection: SqlSessionEntrySelection;
}): SessionEntrySelection {
  const creatorEntries = filterResidualSessionEntries(params);
  const creatorId = normalizeOptionalString(params.opts.creatorId);
  const filtered =
    creatorId && params.sqlSelection?.creatorFilterApplied === false
      ? creatorEntries.filter(([, entry]) => entry.createdActor?.id === creatorId)
      : creatorEntries;
  const limit = resolveSessionsListLimit(params.opts, params.defaultLimit);
  const offset = resolveSessionsListOffset(params.opts);
  const windowLimit = resolveSessionsListWindowLimit(limit, offset);
  const sorted = params.sqlSelection.ordered
    ? filtered
    : filtered.toSorted((left, right) => compareSessionEntries(left, right, params.opts.sortBy));
  const sortedWindow = windowLimit === undefined ? sorted : sorted.slice(0, windowLimit);
  const entries =
    limit === undefined ? sortedWindow.slice(offset) : sortedWindow.slice(offset, offset + limit);
  const nextOffset = offset + entries.length;
  const hasResidualCountFilter = Boolean(
    params.entryFilter ||
    params.opts.boardFace ||
    normalizeOptionalString(params.opts.search) ||
    (creatorId && params.sqlSelection?.creatorFilterApplied === false) ||
    (normalizeOptionalString(params.opts.spawnedBy) && params.sqlSelection.ordered !== true) ||
    params.opts.requireLastInteraction === true,
  );
  const totalCount = hasResidualCountFilter
    ? filtered.length
    : (params.sqlSelection?.totalCount ?? filtered.length);
  const hasMore = nextOffset < totalCount;
  return {
    entries,
    creatorEntries,
    totalCount,
    limitApplied: limit,
    offset,
    nextOffset: hasMore ? nextOffset : null,
    hasMore,
  };
}

function listSessionCreatorIdentities(
  entries: readonly SessionEntryPair[],
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined>,
  creatorActors?: readonly NonNullable<SessionEntry["createdActor"]>[],
): Array<{ id: string; label?: string; avatarUrl?: string }> {
  const creators = new Map<string, { id: string; label?: string; avatarUrl?: string }>();
  const facetCreatorIds = new Set<string>();
  const preferredValue = (current: string | undefined, candidate: string | undefined) => {
    if (!current || !candidate) {
      return current ?? candidate;
    }
    return candidate < current ? candidate : current;
  };
  const addCreator = (creator: NonNullable<SessionEntry["createdActor"]>) => {
    const actor = projectSessionActor(creator, userProfileIdentityById);
    const id = normalizeOptionalString(actor?.id);
    if (!id) {
      return;
    }
    const label = normalizeOptionalString(actor?.label);
    const avatarUrl = normalizeOptionalString(actor?.avatarUrl);
    const existing = creators.get(id);
    const preferredLabel = preferredValue(existing?.label, label);
    const preferredAvatarUrl = preferredValue(existing?.avatarUrl, avatarUrl);
    if (
      !existing ||
      preferredLabel !== existing.label ||
      preferredAvatarUrl !== existing.avatarUrl
    ) {
      creators.set(id, {
        id,
        ...(preferredLabel ? { label: preferredLabel } : {}),
        ...(preferredAvatarUrl ? { avatarUrl: preferredAvatarUrl } : {}),
      });
    }
  };
  for (const creator of creatorActors ?? []) {
    addCreator(creator);
    const id = normalizeOptionalString(creator.id);
    if (id) {
      facetCreatorIds.add(id);
    }
  }
  for (const [, entry] of entries) {
    if (
      entry.createdActor &&
      !facetCreatorIds.has(normalizeOptionalString(entry.createdActor.id) ?? "")
    ) {
      addCreator(entry.createdActor);
    }
  }
  return [...creators.values()].toSorted((a, b) => {
    const byLabel = (a.label ?? a.id).localeCompare(b.label ?? b.id);
    return byLabel || a.id.localeCompare(b.id);
  });
}

function prepareSessionList(params: SessionListBuildParams) {
  const { cfg, store, opts } = params;
  const contextStore = params.rowContextStore ?? store;
  const now = Date.now();
  // Creator facets and rows share one profile identity snapshot for the whole response.
  const userProfileIdentityById = new Map<string, SessionActorProfileIdentity | undefined>();
  let rowContext: SessionListRowContext | undefined;
  const getRowContext = () =>
    (rowContext ??= buildSessionListRowContext({
      store: contextStore,
      now,
      userProfileIdentityById,
    }));
  const hasSpawnedByFilter = Boolean(normalizeOptionalString(opts.spawnedBy));
  const filteredSessionKeys = new Set<string>();
  const entryFilter = params.entryFilter
    ? (key: string, entry: SessionEntry) => {
        const keep = params.entryFilter?.(key, entry) ?? true;
        if (!keep) {
          filteredSessionKeys.add(key);
        }
        return keep;
      }
    : undefined;
  if (entryFilter && contextStore !== store) {
    for (const [key, entry] of Object.entries(contextStore)) {
      entryFilter(key, entry);
    }
  }
  let childLinksPruned = false;
  const pruneFilteredChildLinks = (context: SessionListRowContext) => {
    if (childLinksPruned || filteredSessionKeys.size === 0) {
      return;
    }
    for (const [parentKey, childKeys] of context.storeChildSessionsByKey) {
      context.storeChildSessionsByKey.set(
        parentKey,
        childKeys.filter((key) => !filteredSessionKeys.has(key)),
      );
    }
    childLinksPruned = true;
  };
  const needsFilterAwareContext =
    Boolean(entryFilter) || hasSpawnedByFilter || Boolean(normalizeOptionalString(opts.search));
  if (entryFilter && filteredSessionKeys.size > 0 && needsFilterAwareContext) {
    pruneFilteredChildLinks(getRowContext());
  }
  const selection = selectSessionEntries({
    cfg,
    store,
    opts,
    now,
    getRowContext: needsFilterAwareContext ? getRowContext : undefined,
    defaultLimit: SESSIONS_LIST_DEFAULT_LIMIT,
    ...(entryFilter ? { entryFilter } : {}),
    sqlSelection: params.sqlSelection,
  });
  const fullRowContext =
    rowContext ||
    hasSpawnedByFilter ||
    filteredSessionKeys.size > 0 ||
    selection.entries.length > SESSIONS_LIST_YIELD_BATCH_SIZE
      ? getRowContext()
      : undefined;
  if (fullRowContext && filteredSessionKeys.size > 0) {
    // The predicate replaces a filtered-store object; hidden rows must not survive as child links.
    pruneFilteredChildLinks(fullRowContext);
  }
  const sharedRowContext =
    fullRowContext ??
    (selection.entries.length > 0
      ? buildSessionListRowMetadataContext({ now, userProfileIdentityById })
      : undefined);
  populateSessionListAcpMetadata({
    cfg,
    entries: selection.entries,
    opts,
    rowContext: sharedRowContext,
  });
  return { ...selection, contextStore, fullRowContext, now, sharedRowContext };
}

function buildSessionsListResult(
  params: SessionListBuildParams,
  prepared: ReturnType<typeof prepareSessionList>,
  sessions: GatewaySessionRow[],
): SessionsListResult {
  return {
    ts: prepared.now,
    path: params.storePath,
    count: sessions.length,
    totalCount: prepared.totalCount,
    limitApplied: prepared.limitApplied,
    offset: prepared.offset > 0 ? prepared.offset : undefined,
    nextOffset: prepared.nextOffset,
    hasMore: prepared.hasMore,
    creators: listSessionCreatorIdentities(
      prepared.creatorEntries,
      prepared.sharedRowContext?.userProfileIdentityById ?? new Map(),
      // Callers provide the SQL facet only when no residual filter can remove its source rows.
      // Otherwise creatorEntries preserves the pre-creator-filter facet after residual filtering.
      params.sqlSelection.creatorActors,
    ),
    defaults: getSessionDefaults(params.cfg, params.modelCatalog, {
      allowPluginNormalization: false,
    }),
    sessions,
  };
}

/**
 * Builds session rows while yielding to the event loop between batches.
 *
 * Transcript reads for last-message previews remain the dominant blocker.
 * By yielding every SESSIONS_LIST_YIELD_BATCH_SIZE rows, we keep the event
 * loop responsive for WebSocket heartbeats, channel I/O, and concurrent RPC.
 */
export async function listSessionsFromStoreAsync(
  params: SessionListBuildParams,
): Promise<SessionsListResult> {
  // Pin the active plugin-registry workspace dir for the duration of this
  // call so per-row metadata lookups use a stable memo key. Without this pin,
  // concurrent agent turns / crons mutate the process-global workspace dir
  // between rows, the memo never hits, and each row triggers a full
  // loadPluginMetadataSnapshot scan (~100 ms).
  return withPinnedActivePluginRegistryWorkspaceDir(async () => {
    const { cfg, storePath, opts } = params;
    const prepared = prepareSessionList(params);
    const includeDerivedTitles = opts.includeDerivedTitles === true;
    const includeLastMessage = opts.includeLastMessage === true;

    const sessions: GatewaySessionRow[] = [];
    for (let i = 0; i < prepared.entries.length; i++) {
      const [key, entry] = expectDefined(prepared.entries[i], "entries entry at i");
      const includeTranscriptFields = i < SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS;
      const rowAgentId =
        key === "global" && typeof opts.agentId === "string"
          ? normalizeAgentId(opts.agentId)
          : undefined;
      const storeChildSessionsByKey =
        prepared.fullRowContext?.storeChildSessionsByKey ??
        buildSingleRowStoreChildSessionsByKey({
          store: prepared.contextStore,
          storePath,
          key,
          now: prepared.now,
        });
      const row = buildGatewaySessionRow({
        cfg,
        storePath,
        store: prepared.contextStore,
        key,
        entry,
        agentId: rowAgentId,
        modelCatalog: params.modelCatalog,
        now: prepared.now,
        includeDerivedTitles: includeTranscriptFields && includeDerivedTitles,
        includeLastMessage: false,
        transcriptUsageMaxBytes: SESSIONS_LIST_TRANSCRIPT_USAGE_MAX_BYTES,
        storeChildSessionsByKey,
        rowContext: prepared.sharedRowContext,
        // Aggregate paths resolve again per row: the agent key selects its durable store and an
        // incognito key selects its process DB. Keep transcript work bounded to SQL survivors.
        skipTranscriptUsageFallback: !includeTranscriptFields,
        lightweightListRow: true,
      });
      if (entry?.sessionId && includeTranscriptFields && includeLastMessage) {
        const parsed = parseAgentSessionKey(key);
        const sessionAgentId =
          rowAgentId ??
          (parsed?.agentId ? normalizeAgentId(parsed.agentId) : resolveDefaultAgentId(cfg));
        const fields = await readScopedSessionTitleFieldsFromTranscriptAsync({
          agentId: sessionAgentId,
          sessionEntry: entry,
          sessionId: entry.sessionId,
          sessionKey: key,
          storePath,
        });
        if (includeLastMessage && fields.lastMessagePreview) {
          row.lastMessagePreview = fields.lastMessagePreview;
        }
      }
      sessions.push(row);
      // Yield to the event loop between batches so WebSocket heartbeats,
      // channel I/O, and concurrent RPC calls are not starved.
      if ((i + 1) % SESSIONS_LIST_YIELD_BATCH_SIZE === 0 && i + 1 < prepared.entries.length) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    }

    return buildSessionsListResult(params, prepared, sessions);
  });
}
