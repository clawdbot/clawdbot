import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMetaBatch } from "../acp/runtime/session-meta.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  countActiveDescendantRuns,
  getSessionDisplaySubagentRunByChildSessionKey,
} from "../agents/subagents/registry/subagent-registry-read.js";
import { shouldKeepSubagentRunChildLink } from "../agents/subagents/registry/subagent-run-liveness.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPinnedActivePluginRegistryWorkspaceDir } from "../plugins/runtime-workspace-state.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { type SessionEntryPair, sortAndLimitSessionEntries } from "./session-list-order.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "./session-store-key.js";
import { readSessionTitleFieldsFromTranscriptBatch as readScopedSessionTitleFieldsFromTranscriptBatch } from "./session-transcript-title-reader.js";
import type {
  SessionActorProfileIdentity,
  SessionListRowContext,
  SessionListRowContextProvider,
} from "./session-utils-contracts.js";
import {
  deriveSessionTitle,
  isFinitePositiveTimestamp,
  isCurrentSessionChildOwner,
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
const SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS = 100;
const SESSIONS_LIST_TRANSCRIPT_USAGE_MAX_BYTES = 64 * 1024;

type ListSessionsFromStoreParams = {
  cfg: OpenClawConfig;
  durableStorePath?: string;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
  storePath: string;
  store: Record<string, SessionEntry>;
  modelCatalog?: ModelCatalogEntry[];
  lightweightListRows?: boolean;
  opts: SessionsListParams;
  involvingActorId?: string;
};

type SessionEntrySelection = {
  entries: SessionEntryPair[];
  creators: Array<{ id: string; label?: string; avatarUrl?: string }>;
  totalCount: number;
  limitApplied?: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
};

function preferredCreatorIdentityValue(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  if (!current || !candidate) {
    return current ?? candidate;
  }
  return candidate < current ? candidate : current;
}

function addSessionCreatorIdentity(
  creators: Map<string, { id: string; label?: string; avatarUrl?: string }>,
  entry: SessionEntry,
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined>,
  cfg: OpenClawConfig,
): void {
  const actor = projectSessionActor(
    entry.owner?.actor ?? entry.createdActor,
    userProfileIdentityById,
    cfg,
  );
  const id = normalizeOptionalString(actor?.id);
  if (!id) {
    return;
  }
  const label = normalizeOptionalString(actor?.label);
  const avatarUrl = normalizeOptionalString(actor?.avatarUrl);
  const existing = creators.get(id);
  const preferredLabel = preferredCreatorIdentityValue(existing?.label, label);
  const preferredAvatarUrl = preferredCreatorIdentityValue(existing?.avatarUrl, avatarUrl);
  if (!existing || preferredLabel !== existing.label || preferredAvatarUrl !== existing.avatarUrl) {
    creators.set(id, {
      id,
      ...(preferredLabel ? { label: preferredLabel } : {}),
      ...(preferredAvatarUrl ? { avatarUrl: preferredAvatarUrl } : {}),
    });
  }
}

function sortSessionCreatorIdentities(
  creators: Map<string, { id: string; label?: string; avatarUrl?: string }>,
): Array<{ id: string; label?: string; avatarUrl?: string }> {
  return [...creators.values()].toSorted((a, b) => {
    const byLabel = (a.label ?? a.id).localeCompare(b.label ?? b.id);
    return byLabel || a.id.localeCompare(b.id);
  });
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
      parsed?.agentId ?? params.opts.agentId ?? resolveSessionStoreAgentId(params.cfg, key),
    );
    return {
      sessionKey: resolveStoredSessionKeyForAgentStore({
        cfg: params.cfg,
        agentId,
        sessionKey: key,
      }),
      agentId,
      entry,
    };
  });
  params.rowContext.acpSessionMetaByEntry = readAcpSessionMetaBatch({
    entries,
    cfg: params.cfg,
  });
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

function filterSessionEntries(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  opts: SessionsListParams;
  now: number;
  userProfileIdentityById?: Map<string, SessionActorProfileIdentity | undefined>;
  getRowContext?: SessionListRowContextProvider;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
  involvingActorId?: string;
}): Pick<SessionEntrySelection, "creators" | "entries"> {
  const { cfg, store, opts, now } = params;
  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = normalizeOptionalString(opts.label) ?? "";
  const boardFace = opts.boardFace;
  const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  const search = normalizeLowercaseStringOrEmpty(opts.search);
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;
  const creatorId = normalizeOptionalString(opts.creatorId);
  const involvingActorId = normalizeOptionalString(params.involvingActorId);
  const activeCutoff = activeMinutes === undefined ? undefined : now - activeMinutes * 60_000;
  const entries: SessionEntryPair[] = [];
  const creators = new Map<string, { id: string; label?: string; avatarUrl?: string }>();

  for (const [key, entry] of Object.entries(store)) {
    if (params.entryFilter && !params.entryFilter(key, entry)) {
      continue;
    }
    if (
      isCronRunSessionKey(key) ||
      (!includeGlobal && key === "global") ||
      (!includeUnknown && key === "unknown")
    ) {
      continue;
    }
    if (agentId) {
      if (key === "global") {
        if (!includeGlobal) {
          continue;
        }
      } else if (key === "unknown") {
        continue;
      } else {
        const parsed = parseAgentSessionKey(key);
        if (!parsed || normalizeAgentId(parsed.agentId) !== agentId) {
          continue;
        }
      }
    }
    if (isPhantomAgentStoreListEntry(key, entry)) {
      continue;
    }
    if (spawnedBy) {
      if (key === "unknown" || key === "global") {
        continue;
      }
      const filterRowContext = resolveSessionListRowContext(params);
      const latest = filterRowContext
        ? filterRowContext.subagentRuns.getDisplaySubagentRun(key)
        : getSessionDisplaySubagentRunByChildSessionKey(key);
      const keepSpawned = latest
        ? isCurrentSessionChildOwner({
            entry,
            ownerSessionKey: spawnedBy,
            controllerSessionKey:
              normalizeOptionalString(latest.controllerSessionKey) ||
              normalizeOptionalString(latest.requesterSessionKey),
          }) &&
          shouldKeepSubagentRunChildLink(latest, {
            activeDescendants: filterRowContext
              ? filterRowContext.subagentRuns.countActiveDescendantRuns(key)
              : countActiveDescendantRuns(key),
            now,
          })
        : shouldKeepStoreOnlyChildLink(entry, now) &&
          (entry.spawnedBy === spawnedBy || entry.parentSessionKey === spawnedBy);
      if (!keepSpawned) {
        continue;
      }
    }
    if (opts.archived !== "all") {
      const archived = entry.archivedAt !== undefined;
      if (opts.archived === true ? !archived : archived) {
        continue;
      }
    }
    if (
      opts.requireLastInteraction === true &&
      (!isFinitePositiveTimestamp(entry.lastInteractionAt) ||
        normalizeOptionalString(entry.heartbeatIsolatedBaseSessionKey))
    ) {
      continue;
    }
    if ((label && entry.label !== label) || (boardFace && entry.boardFace !== boardFace)) {
      continue;
    }
    if (search) {
      const cheapFields = [
        resolveSessionListSearchDisplayName(key, entry),
        entry.label,
        entry.subject,
        entry.sessionId,
        key,
      ];
      appendStoredSessionModelSearchFields(cheapFields, entry);
      const cheapMatch = matchesSessionListSearch(cheapFields, search);
      const derivedMatch =
        !cheapMatch &&
        shouldResolveDerivedSessionModelSearchFields(search) &&
        matchesSessionListSearch(
          resolveSessionListSearchModelFields({
            ...(agentId ? { agentId } : {}),
            cfg,
            key,
            entry,
            rowContext: resolveSessionListRowContext(params),
          }),
          search,
        );
      if (!cheapMatch && !derivedMatch) {
        continue;
      }
    }
    if (activeCutoff !== undefined && (entry.updatedAt ?? 0) < activeCutoff) {
      continue;
    }
    if (params.userProfileIdentityById) {
      addSessionCreatorIdentity(creators, entry, params.userProfileIdentityById, cfg);
    }
    if (creatorId && (entry.owner?.actor ?? entry.createdActor)?.id !== creatorId) {
      continue;
    }
    if (involvingActorId) {
      const owner = entry.owner?.actor ?? entry.createdActor;
      const viewerOwns = owner?.type === "human" && owner.id === involvingActorId;
      // Only profile-backed ids share the authenticated viewer namespace.
      // Channel-native and legacy unknown ids remain display-only.
      const viewerParticipates = entry.participants?.some(
        (participant) =>
          participant.type === "human" &&
          participant.source === "profile" &&
          participant.id === involvingActorId,
      );
      if (!viewerOwns && !viewerParticipates) {
        continue;
      }
    }
    entries.push([key, entry]);
  }

  return { entries, creators: sortSessionCreatorIdentities(creators) };
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
  getRowContext?: SessionListRowContextProvider;
  defaultLimit?: number;
  userProfileIdentityById?: Map<string, SessionActorProfileIdentity | undefined>;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
  involvingActorId?: string;
}): SessionEntrySelection {
  const { creators, entries: filtered } = filterSessionEntries(params);
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
    creators,
    totalCount: filtered.length,
    limitApplied: limit,
    offset,
    nextOffset: hasMore ? nextOffset : null,
    hasMore,
  };
}

function prepareSessionList(params: ListSessionsFromStoreParams) {
  const { cfg, store, opts } = params;
  const now = Date.now();
  const userProfileIdentityById = new Map<string, SessionActorProfileIdentity | undefined>();
  let rowContext: SessionListRowContext | undefined;
  const getRowContext = () => {
    rowContext ??= buildSessionListRowContext({ store, now, userProfileIdentityById });
    return rowContext;
  };
  const hasSpawnedByFilter = typeof opts.spawnedBy === "string" && opts.spawnedBy.length > 0;
  const filteredSessionKeys = new Set<string>();
  let hasIncognito = false;
  const entryFilter = (key: string, entry: SessionEntry) => {
    if (params.entryFilter && !params.entryFilter(key, entry)) {
      filteredSessionKeys.add(key);
      return false;
    }
    hasIncognito ||= entry.incognito === true || isIncognitoSessionKey(key);
    return true;
  };
  const selection = selectSessionEntries({
    cfg,
    store,
    opts,
    now,
    entryFilter,
    getRowContext:
      hasSpawnedByFilter || Boolean(normalizeOptionalString(opts.search))
        ? getRowContext
        : undefined,
    defaultLimit: SESSIONS_LIST_DEFAULT_LIMIT,
    userProfileIdentityById,
    involvingActorId: params.involvingActorId,
  });
  const fullRowContext =
    rowContext ||
    hasSpawnedByFilter ||
    filteredSessionKeys.size > 0 ||
    selection.entries.length > SESSIONS_LIST_YIELD_BATCH_SIZE
      ? getRowContext()
      : undefined;
  if (fullRowContext && filteredSessionKeys.size > 0) {
    // The predicate replaces a filtered-store object; keep its hidden child links out too.
    for (const [parentKey, childKeys] of fullRowContext.storeChildSessionsByKey) {
      fullRowContext.storeChildSessionsByKey.set(
        parentKey,
        childKeys.filter((key) => !filteredSessionKeys.has(key)),
      );
    }
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
  return {
    ...selection,
    includeDerivedTitles: opts.includeDerivedTitles === true,
    includeLastMessage: opts.includeLastMessage === true,
    now,
    rowContext: sharedRowContext,
    storeChildSessionsByKey: fullRowContext?.storeChildSessionsByKey,
    storePath: hasIncognito ? params.storePath : (params.durableStorePath ?? params.storePath),
  };
}

function buildSessionsListResult(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  list: ReturnType<typeof prepareSessionList>;
  modelCatalog?: ModelCatalogEntry[];
  sessions: GatewaySessionRow[];
}): SessionsListResult {
  const { list, sessions } = params;
  return {
    ts: list.now,
    path: list.storePath,
    count: sessions.length,
    totalCount: list.totalCount,
    limitApplied: list.limitApplied,
    offset: list.offset > 0 ? list.offset : undefined,
    nextOffset: list.nextOffset,
    hasMore: list.hasMore,
    creators: list.creators,
    defaults: getSessionDefaults(params.cfg, params.modelCatalog, {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      allowPluginNormalization: false,
    }),
    sessions,
  };
}

export function filterAndSortSessionEntries(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  opts: SessionsListParams;
  now: number;
  involvingActorId?: string;
}): [string, SessionEntry][] {
  return selectSessionEntries(params).entries;
}

export function listSessionsFromStore(params: ListSessionsFromStoreParams): SessionsListResult {
  const { cfg, store, opts } = params;
  const list = prepareSessionList(params);
  const sessions = list.entries.map(([key, entry], index) => {
    const includeTranscriptFields = index < SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS;
    const rowAgentId =
      !parseAgentSessionKey(key) && typeof opts.agentId === "string"
        ? normalizeAgentId(opts.agentId)
        : undefined;
    const storeChildSessionsByKey =
      list.storeChildSessionsByKey ??
      buildSingleRowStoreChildSessionsByKey({
        store,
        storePath: list.storePath,
        key,
        now: list.now,
      });
    return buildGatewaySessionRow({
      cfg,
      storePath: list.storePath,
      store,
      key,
      entry,
      agentId: rowAgentId,
      modelCatalog: params.modelCatalog,
      now: list.now,
      includeDerivedTitles: includeTranscriptFields && list.includeDerivedTitles,
      includeLastMessage: includeTranscriptFields && list.includeLastMessage,
      transcriptUsageMaxBytes: SESSIONS_LIST_TRANSCRIPT_USAGE_MAX_BYTES,
      storeChildSessionsByKey,
      rowContext: list.rowContext,
      skipTranscriptUsageFallback: params.lightweightListRows === true,
      lightweightListRow: params.lightweightListRows === true,
    });
  });
  return buildSessionsListResult({
    cfg,
    list,
    modelCatalog: params.modelCatalog,
    sessions,
    agentId: opts.agentId,
  });
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
export async function listSessionsFromStoreAsync(
  params: ListSessionsFromStoreParams,
): Promise<SessionsListResult> {
  // Pin the active plugin-registry workspace dir for the duration of this
  // call so per-row metadata lookups use a stable memo key. Without this pin,
  // concurrent agent turns / crons mutate the process-global workspace dir
  // between rows, the memo never hits, and each row triggers a full
  // loadPluginMetadataSnapshot scan (~100 ms).
  return withPinnedActivePluginRegistryWorkspaceDir(async () => {
    const { cfg, store, opts } = params;
    const list = prepareSessionList(params);
    const sessions: GatewaySessionRow[] = [];
    const transcriptScopes = list.entries
      .slice(0, SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS)
      .flatMap(([key, entry]) => {
        if (!entry.sessionId || (!list.includeDerivedTitles && !list.includeLastMessage)) {
          return [];
        }
        const parsed = parseAgentSessionKey(key);
        const agentId = normalizeAgentId(
          parsed?.agentId ?? opts.agentId ?? resolveSessionStoreAgentId(cfg, key),
        );
        return [
          {
            agentId,
            sessionEntry: entry,
            sessionId: entry.sessionId,
            sessionKey: key,
            storePath: list.storePath,
          },
        ];
      });
    const transcriptFields = readScopedSessionTitleFieldsFromTranscriptBatch(transcriptScopes);
    let transcriptFieldIndex = 0;
    for (let i = 0; i < list.entries.length; i++) {
      const [key, entry] = expectDefined(list.entries[i], "entries entry at i");
      const includeTranscriptFields = i < SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS;
      const rowAgentId =
        !parseAgentSessionKey(key) && typeof opts.agentId === "string"
          ? normalizeAgentId(opts.agentId)
          : undefined;
      const storeChildSessionsByKey =
        list.storeChildSessionsByKey ??
        buildSingleRowStoreChildSessionsByKey({
          store,
          storePath: list.storePath,
          key,
          now: list.now,
        });
      const row = buildGatewaySessionRow({
        cfg,
        storePath: list.storePath,
        store,
        key,
        entry,
        agentId: rowAgentId,
        modelCatalog: params.modelCatalog,
        now: list.now,
        includeDerivedTitles: false,
        includeLastMessage: false,
        transcriptUsageMaxBytes: SESSIONS_LIST_TRANSCRIPT_USAGE_MAX_BYTES,
        storeChildSessionsByKey,
        rowContext: list.rowContext,
        skipTranscriptUsageFallback: true,
        lightweightListRow: true,
      });
      if (
        entry?.sessionId &&
        includeTranscriptFields &&
        (list.includeDerivedTitles || list.includeLastMessage)
      ) {
        const fields = expectDefined(
          transcriptFields[transcriptFieldIndex],
          "batched transcript fields at transcriptFieldIndex",
        );
        transcriptFieldIndex += 1;
        if (list.includeDerivedTitles) {
          row.derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage, row.displayName);
        }
        if (list.includeLastMessage && fields.lastMessagePreview) {
          row.lastMessagePreview = fields.lastMessagePreview;
        }
      }
      sessions.push(row);
      // Yield to the event loop between batches so WebSocket heartbeats,
      // channel I/O, and concurrent RPC calls are not starved.
      if ((i + 1) % SESSIONS_LIST_YIELD_BATCH_SIZE === 0 && i + 1 < list.entries.length) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    }

    return buildSessionsListResult({
      cfg,
      list,
      modelCatalog: params.modelCatalog,
      sessions,
      agentId: opts.agentId,
    });
  });
}
