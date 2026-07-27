import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  countActiveDescendantRuns,
  getSessionDisplaySubagentRunByChildSessionKey,
} from "../agents/subagent-registry-read.js";
import { shouldKeepSubagentRunChildLink } from "../agents/subagent-run-liveness.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPinnedActivePluginRegistryWorkspaceDir } from "../plugins/runtime-workspace-state.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { type SessionEntryPair, sortAndLimitSessionEntries } from "./session-list-order.js";
import { readSessionTitleFieldsFromTranscriptAsync as readScopedSessionTitleFieldsFromTranscriptAsync } from "./session-transcript-readers.js";
import type {
  SessionListRowContext,
  SessionListRowContextProvider,
} from "./session-utils-contracts.js";
import {
  deriveSessionTitle,
  isFinitePositiveTimestamp,
  shouldKeepStoreOnlyChildLink,
} from "./session-utils-core.js";
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

type SessionEntrySelection = {
  entries: SessionEntryPair[];
  creatorEntries: SessionEntryPair[];
  totalCount: number;
  limitApplied?: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
};

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

function filterSessionEntries(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  opts: SessionsListParams;
  now: number;
  rowContext?: SessionListRowContext;
  getRowContext?: SessionListRowContextProvider;
}): SessionEntryPair[] {
  const { cfg, store, opts, now } = params;
  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = normalizeOptionalString(opts.label) ?? "";
  const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  const search = normalizeLowercaseStringOrEmpty(opts.search);
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;

  let entries = Object.entries(store)
    .filter(([key]) => {
      if (isCronRunSessionKey(key)) {
        return false;
      }
      if (!includeGlobal && key === "global") {
        return false;
      }
      if (!includeUnknown && key === "unknown") {
        return false;
      }
      if (agentId) {
        if (key === "global") {
          return includeGlobal;
        }
        if (key === "unknown") {
          return false;
        }
        const parsed = parseAgentSessionKey(key);
        if (!parsed) {
          return false;
        }
        return normalizeAgentId(parsed.agentId) === agentId;
      }
      return true;
    })
    .filter(([key, entry]) => {
      if (isPhantomAgentStoreListEntry(key, entry)) {
        return false;
      }
      if (!spawnedBy) {
        return true;
      }
      if (key === "unknown" || key === "global") {
        return false;
      }
      const filterRowContext = resolveSessionListRowContext(params);
      const latest = filterRowContext
        ? filterRowContext.subagentRuns.getDisplaySubagentRun(key)
        : getSessionDisplaySubagentRunByChildSessionKey(key);
      if (latest) {
        const latestControllerSessionKey =
          normalizeOptionalString(latest.controllerSessionKey) ||
          normalizeOptionalString(latest.requesterSessionKey);
        return (
          latestControllerSessionKey === spawnedBy &&
          shouldKeepSubagentRunChildLink(latest, {
            activeDescendants: filterRowContext
              ? filterRowContext.subagentRuns.countActiveDescendantRuns(key)
              : countActiveDescendantRuns(key),
            now,
          })
        );
      }
      return (
        shouldKeepStoreOnlyChildLink(entry, now) &&
        (entry?.spawnedBy === spawnedBy || entry?.parentSessionKey === spawnedBy)
      );
    })
    .filter(([, entry]) => {
      if (opts.archived === "all") {
        return true;
      }
      const archived = entry?.archivedAt !== undefined;
      return opts.archived === true ? archived : !archived;
    })
    .filter(([, entry]) => {
      if (opts.requireLastInteraction !== true) {
        return true;
      }
      return (
        isFinitePositiveTimestamp(entry?.lastInteractionAt) &&
        !normalizeOptionalString(entry?.heartbeatIsolatedBaseSessionKey)
      );
    })
    .filter(([, entry]) => {
      if (!label) {
        return true;
      }
      return entry?.label === label;
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

  if (activeMinutes !== undefined) {
    const cutoff = now - activeMinutes * 60_000;
    entries = entries.filter(([, entry]) => (entry?.updatedAt ?? 0) >= cutoff);
  }

  return entries;
}

function isPhantomAgentStoreListEntry(key: string, entry: SessionEntry | undefined): boolean {
  const parsed = parseAgentSessionKey(key);
  return (
    parsed?.rest === "sessions" &&
    !normalizeOptionalString(entry?.sessionId) &&
    entry?.updatedAt == null
  );
}

function selectSessionEntries(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  opts: SessionsListParams;
  now: number;
  rowContext?: SessionListRowContext;
  getRowContext?: SessionListRowContextProvider;
  defaultLimit?: number;
}): SessionEntrySelection {
  const creatorEntries = filterSessionEntries(params);
  const creatorId = normalizeOptionalString(params.opts.creatorId);
  const filtered = creatorId
    ? creatorEntries.filter(([, entry]) => entry.createdActor?.id === creatorId)
    : creatorEntries;
  const limit = resolveSessionsListLimit(params.opts, params.defaultLimit);
  const offset = resolveSessionsListOffset(params.opts);
  const windowLimit = resolveSessionsListWindowLimit(limit, offset);
  const sortedWindow = sortAndLimitSessionEntries(filtered, windowLimit, params.opts.sortBy);
  const entries =
    limit === undefined ? sortedWindow.slice(offset) : sortedWindow.slice(offset, offset + limit);
  const nextOffset = offset + entries.length;
  const hasMore = nextOffset < filtered.length;
  return {
    entries,
    creatorEntries,
    totalCount: filtered.length,
    limitApplied: limit,
    offset,
    nextOffset: hasMore ? nextOffset : null,
    hasMore,
  };
}

function listSessionCreatorIdentities(
  entries: readonly SessionEntryPair[],
  userProfileLabelById: Map<string, string | undefined>,
): Array<{ id: string; label?: string }> {
  const creators = new Map<string, { id: string; label?: string }>();
  for (const [, entry] of entries) {
    const actor = projectSessionActor(entry.createdActor, userProfileLabelById);
    const id = normalizeOptionalString(actor?.id);
    if (!id) {
      continue;
    }
    const label = normalizeOptionalString(actor?.label);
    const existing = creators.get(id);
    if (!existing || (label && (!existing.label || label.localeCompare(existing.label) < 0))) {
      creators.set(id, { id, ...(label ? { label } : {}) });
    }
  }
  return [...creators.values()].toSorted((a, b) => {
    const byLabel = (a.label ?? a.id).localeCompare(b.label ?? b.id);
    return byLabel || a.id.localeCompare(b.id);
  });
}

export function filterAndSortSessionEntries(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  opts: SessionsListParams;
  now: number;
  rowContext?: SessionListRowContext;
  getRowContext?: SessionListRowContextProvider;
}): [string, SessionEntry][] {
  return selectSessionEntries(params).entries;
}

export function listSessionsFromStore(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  modelCatalog?: ModelCatalogEntry[];
  opts: SessionsListParams;
}): SessionsListResult {
  const { cfg, storePath, store, opts } = params;
  const now = Date.now();
  const sessionListTranscriptUsageMaxBytes = 64 * 1024;
  const sessionListTranscriptFieldRows = 100;
  let rowContext: SessionListRowContext | undefined;
  const getRowContext = () => {
    rowContext ??= buildSessionListRowContext({ store, now });
    return rowContext;
  };
  const includeDerivedTitles = opts.includeDerivedTitles === true;
  const includeLastMessage = opts.includeLastMessage === true;
  const hasSpawnedByFilter = typeof opts.spawnedBy === "string" && opts.spawnedBy.length > 0;

  const selection = selectSessionEntries({
    cfg,
    store,
    opts,
    now,
    getRowContext:
      hasSpawnedByFilter || Boolean(normalizeOptionalString(opts.search))
        ? getRowContext
        : undefined,
    defaultLimit: SESSIONS_LIST_DEFAULT_LIMIT,
  });
  const { entries, creatorEntries, totalCount, limitApplied, offset, nextOffset, hasMore } =
    selection;
  const fullRowContext =
    rowContext || hasSpawnedByFilter || entries.length > SESSIONS_LIST_YIELD_BATCH_SIZE
      ? getRowContext()
      : undefined;
  const sharedRowContext =
    fullRowContext ??
    (entries.length > 0 ? buildSessionListRowMetadataContext({ now }) : undefined);

  const sessions = entries.map(([key, entry], index) => {
    const includeTranscriptFields = index < sessionListTranscriptFieldRows;
    const rowAgentId =
      key === "global" && typeof opts.agentId === "string"
        ? normalizeAgentId(opts.agentId)
        : undefined;
    const storeChildSessionsByKey =
      fullRowContext?.storeChildSessionsByKey ??
      buildSingleRowStoreChildSessionsByKey({ store, storePath, key, now });
    return buildGatewaySessionRow({
      cfg,
      storePath,
      store,
      key,
      entry,
      agentId: rowAgentId,
      modelCatalog: params.modelCatalog,
      now,
      includeDerivedTitles: includeTranscriptFields && includeDerivedTitles,
      includeLastMessage: includeTranscriptFields && includeLastMessage,
      transcriptUsageMaxBytes: sessionListTranscriptUsageMaxBytes,
      storeChildSessionsByKey,
      rowContext: sharedRowContext,
    });
  });

  return {
    ts: now,
    path: storePath,
    count: sessions.length,
    totalCount,
    limitApplied,
    offset: offset > 0 ? offset : undefined,
    nextOffset,
    hasMore,
    creators: listSessionCreatorIdentities(
      creatorEntries,
      sharedRowContext?.userProfileLabelById ?? new Map(),
    ),
    defaults: getSessionDefaults(cfg, params.modelCatalog, { allowPluginNormalization: false }),
    sessions,
  };
}

/**
 * Async version of listSessionsFromStore that yields to the event loop between
 * batches of session row builds. This prevents large session stores from
 * blocking the event loop during sessions.list requests.
 *
 * The synchronous file I/O in readSessionTitleFieldsFromTranscript (head/tail
 * reads for derived titles and last-message previews) is the dominant blocker.
 * By yielding every SESSIONS_LIST_YIELD_BATCH_SIZE rows, we keep the event
 * loop responsive for WebSocket heartbeats, channel I/O, and concurrent RPC.
 */
export async function listSessionsFromStoreAsync(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  modelCatalog?: ModelCatalogEntry[];
  opts: SessionsListParams;
}): Promise<SessionsListResult> {
  // Pin the active plugin-registry workspace dir for the duration of this
  // call so per-row metadata lookups use a stable memo key. Without this pin,
  // concurrent agent turns / crons mutate the process-global workspace dir
  // between rows, the memo never hits, and each row triggers a full
  // loadPluginMetadataSnapshot scan (~100 ms).
  return withPinnedActivePluginRegistryWorkspaceDir(async () => {
    const { cfg, storePath, store, opts } = params;
    const now = Date.now();
    const sessionListTranscriptUsageMaxBytes = 64 * 1024;
    const sessionListTranscriptFieldRows = 100;
    let rowContext: SessionListRowContext | undefined;
    const getRowContext = () => {
      rowContext ??= buildSessionListRowContext({ store, now });
      return rowContext;
    };
    const includeDerivedTitles = opts.includeDerivedTitles === true;
    const includeLastMessage = opts.includeLastMessage === true;
    const hasSpawnedByFilter = typeof opts.spawnedBy === "string" && opts.spawnedBy.length > 0;

    const selection = selectSessionEntries({
      cfg,
      store,
      opts,
      now,
      getRowContext:
        hasSpawnedByFilter || Boolean(normalizeOptionalString(opts.search))
          ? getRowContext
          : undefined,
      defaultLimit: SESSIONS_LIST_DEFAULT_LIMIT,
    });
    const { entries, creatorEntries, totalCount, limitApplied, offset, nextOffset, hasMore } =
      selection;
    const fullRowContext =
      rowContext || hasSpawnedByFilter || entries.length > SESSIONS_LIST_YIELD_BATCH_SIZE
        ? getRowContext()
        : undefined;
    const sharedRowContext =
      fullRowContext ??
      (entries.length > 0 ? buildSessionListRowMetadataContext({ now }) : undefined);

    const sessions: GatewaySessionRow[] = [];
    for (let i = 0; i < entries.length; i++) {
      const [key, entry] = expectDefined(entries[i], "entries entry at i");
      const includeTranscriptFields = i < sessionListTranscriptFieldRows;
      const rowAgentId =
        key === "global" && typeof opts.agentId === "string"
          ? normalizeAgentId(opts.agentId)
          : undefined;
      const storeChildSessionsByKey =
        fullRowContext?.storeChildSessionsByKey ??
        buildSingleRowStoreChildSessionsByKey({ store, storePath, key, now });
      const row = buildGatewaySessionRow({
        cfg,
        storePath,
        store,
        key,
        entry,
        agentId: rowAgentId,
        modelCatalog: params.modelCatalog,
        now,
        includeDerivedTitles: false,
        includeLastMessage: false,
        transcriptUsageMaxBytes: sessionListTranscriptUsageMaxBytes,
        storeChildSessionsByKey,
        rowContext: sharedRowContext,
        skipTranscriptUsageFallback: true,
        lightweightListRow: true,
      });
      if (
        entry?.sessionId &&
        includeTranscriptFields &&
        (includeDerivedTitles || includeLastMessage)
      ) {
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
        if (includeDerivedTitles) {
          row.derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage);
        }
        if (includeLastMessage && fields.lastMessagePreview) {
          row.lastMessagePreview = fields.lastMessagePreview;
        }
      }
      sessions.push(row);
      // Yield to the event loop between batches so WebSocket heartbeats,
      // channel I/O, and concurrent RPC calls are not starved.
      if ((i + 1) % SESSIONS_LIST_YIELD_BATCH_SIZE === 0 && i + 1 < entries.length) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    }

    return {
      ts: now,
      path: storePath,
      count: sessions.length,
      totalCount,
      limitApplied,
      offset: offset > 0 ? offset : undefined,
      nextOffset,
      hasMore,
      creators: listSessionCreatorIdentities(
        creatorEntries,
        sharedRowContext?.userProfileLabelById ?? new Map(),
      ),
      defaults: getSessionDefaults(cfg, params.modelCatalog, { allowPluginNormalization: false }),
      sessions,
    };
  });
}
