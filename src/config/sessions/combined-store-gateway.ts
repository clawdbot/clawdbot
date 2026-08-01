// Builds the gateway-visible combined session store across agent-specific stores.
// Gateway callers need canonical per-agent keys even when stores are split by `{agentId}`.

import { expectDefined } from "@openclaw/normalization-core";
import { listAgentEntries, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "../../gateway/session-store-key.js";
import {
  isIncognitoSessionKey,
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { listOpenIncognitoAgentDatabases } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import { listSessionEntries, listSessionEntriesReadOnly } from "./session-accessor.js";
import {
  querySqliteSessionEntries,
  querySqliteSessionEntriesReadOnly,
} from "./session-accessor.sqlite-entry.js";
import type {
  SessionEntryListQuery,
  SessionEntryListScope,
  SessionEntrySummary,
} from "./session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  listConfiguredSessionStoreAgentIds,
  listKnownSessionStoreAgentIds,
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
  type SessionStoreTarget,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

type GatewaySessionEntryProjection = NonNullable<SessionEntryListScope["projection"]>;

// Template-backed stores need per-agent scans before they can be merged for Gateway views.
function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function resolveCombinedStorePath(paths: string[], storeConfig?: string): string {
  return paths.length === 1
    ? expectDefined(paths[0], "store path at 0")
    : typeof storeConfig === "string" && storeConfig.trim()
      ? storeConfig.trim()
      : "(multiple)";
}

function loadGatewayStoreEntries(params: {
  agentId: string;
  incognito?: boolean;
  includeDependencies?: boolean;
  projection: GatewaySessionEntryProjection;
  query?: SessionEntryListQuery;
  storePath: string;
}): {
  creatorActors: NonNullable<SessionEntry["createdActor"]>[];
  dependencies?: SessionEntrySummary[];
  entries: SessionEntrySummary[];
  totalCount: number;
} {
  const queryEntries = params.incognito
    ? querySqliteSessionEntries
    : querySqliteSessionEntriesReadOnly;
  const result = params.query
    ? queryEntries({
        agentId: params.agentId,
        clone: false,
        projection: params.projection,
        query: params.query,
        storePath: params.storePath,
      })
    : undefined;
  const listEntries = params.incognito ? listSessionEntries : listSessionEntriesReadOnly;
  const entries =
    result?.entries ??
    listEntries({
      agentId: params.agentId,
      clone: false,
      projection: params.projection,
      storePath: params.storePath,
    });
  const dependencyKeys = [
    ...new Set(
      params.includeDependencies ? (result?.entries.map(({ sessionKey }) => sessionKey) ?? []) : [],
    ),
  ];
  const dependencies = new Map<string, SessionEntrySummary>();
  for (let offset = 0; offset < dependencyKeys.length; offset += 400) {
    for (const dependency of queryEntries({
      agentId: params.agentId,
      clone: false,
      projection: params.projection,
      query: {
        archived: "all",
        includeGlobal: true,
        includeHidden: true,
        includeUnknown: true,
        lineageKeys: dependencyKeys.slice(offset, offset + 400),
      },
      storePath: params.storePath,
    }).entries) {
      dependencies.set(dependency.sessionKey, dependency);
    }
  }
  const selectedKeys = new Set(entries.map(({ sessionKey }) => sessionKey));
  return {
    creatorActors: result?.creatorActors ?? [],
    ...(dependencies.size > 0
      ? {
          dependencies: [...dependencies.values()].filter(
            ({ sessionKey }) => !selectedKeys.has(sessionKey),
          ),
        }
      : {}),
    entries,
    totalCount: result?.totalCount ?? entries.length,
  };
}

function mergeSessionEntryIntoCombined(params: {
  combined: Record<string, SessionEntry>;
  entry: SessionEntry;
  canonicalKey: string;
}) {
  const { combined, entry, canonicalKey } = params;
  if (combined[canonicalKey]) {
    throw canonicalSessionKeyMigrationRequiredError(
      `duplicate rows resolve to canonical session key ${canonicalKey}`,
    );
  }
  combined[canonicalKey] = entry;
}

function projectCombinedSessionEntry(params: {
  agentId: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
}): SessionEntry {
  if (!params.entry.spawnedBy && !params.entry.parentSessionKey) {
    return params.entry;
  }
  const resolveParent = (sessionKey: string) =>
    resolveSessionStoreKey({
      cfg: params.cfg,
      sessionKey,
      storeAgentId: params.agentId,
    });
  return {
    ...params.entry,
    ...(params.entry.parentSessionKey
      ? { parentSessionKey: resolveParent(params.entry.parentSessionKey) }
      : {}),
    ...(params.entry.spawnedBy ? { spawnedBy: resolveParent(params.entry.spawnedBy) } : {}),
  };
}

function mergeGatewayEntries(params: {
  agentId: string;
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  configuredAgentIds?: ReadonlySet<string>;
  entries: readonly SessionEntrySummary[];
  requestedAgentId?: string;
  seenSentinelOwners: Set<string>;
}): boolean {
  let exact = true;
  for (const { sessionKey: key, entry } of params.entries) {
    const canonicalKey = resolveStoredSessionKeyForAgentStore({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: key,
    });
    const canonicalAgentId = normalizeAgentId(
      parseAgentSessionKey(canonicalKey)?.agentId ?? params.agentId,
    );
    if (
      (params.configuredAgentIds && !params.configuredAgentIds.has(canonicalAgentId)) ||
      (params.requestedAgentId && canonicalAgentId !== params.requestedAgentId)
    ) {
      exact = false;
      continue;
    }
    if (key !== canonicalKey) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${canonicalKey}`,
      );
    }
    const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(key, entry);
    if (deliveryCanonicalKey !== key) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
      );
    }
    const sentinelOwnerKey =
      canonicalKey === "global" || canonicalKey === "unknown"
        ? `${canonicalKey}\0${canonicalAgentId}`
        : undefined;
    if (sentinelOwnerKey) {
      if (params.seenSentinelOwners.has(sentinelOwnerKey)) {
        throw canonicalSessionKeyMigrationRequiredError(
          `duplicate rows resolve to canonical session key ${canonicalKey}`,
        );
      }
      params.seenSentinelOwners.add(sentinelOwnerKey);
    }
    const projectedEntry = projectCombinedSessionEntry({
      agentId: canonicalAgentId,
      cfg: params.cfg,
      entry,
    });
    if (
      params.combined[canonicalKey] &&
      (canonicalKey === "global" || canonicalKey === "unknown")
    ) {
      exact = false;
      const preferredAgentId =
        params.requestedAgentId ?? normalizeAgentId(resolveDefaultAgentId(params.cfg));
      if (canonicalAgentId === preferredAgentId) {
        params.combined[canonicalKey] = projectedEntry;
      }
      continue;
    }
    mergeSessionEntryIntoCombined({
      combined: params.combined,
      entry: projectedEntry,
      canonicalKey,
    });
  }
  return exact;
}

function mergeOpenIncognitoStores(params: {
  allowedAgentIds?: ReadonlySet<string>;
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  rowContextCombined: Record<string, SessionEntry>;
  agentId?: string;
  includeDependencies?: boolean;
  projection: GatewaySessionEntryProjection;
  query?: SessionEntryListQuery;
}): string[] {
  const storePaths: string[] = [];
  for (const target of listOpenIncognitoAgentDatabases()) {
    if (params.allowedAgentIds && !params.allowedAgentIds.has(target.agentId)) {
      continue;
    }
    if (params.agentId && target.agentId !== params.agentId) {
      continue;
    }
    const loaded = loadGatewayStoreEntries({
      agentId: target.agentId,
      incognito: true,
      includeDependencies: params.includeDependencies,
      projection: params.projection,
      ...(params.query ? { query: params.query } : {}),
      storePath: target.storePath,
    });
    const merge = (
      entries: readonly SessionEntrySummary[],
      combined: Record<string, SessionEntry>,
    ) => {
      let found = false;
      for (const { sessionKey, entry } of entries) {
        if (!isIncognitoSessionKey(sessionKey) || entry.incognito !== true) {
          continue;
        }
        mergeSessionEntryIntoCombined({
          combined,
          entry: projectCombinedSessionEntry({
            agentId: target.agentId,
            cfg: params.cfg,
            entry,
          }),
          canonicalKey: sessionKey,
        });
        found = true;
      }
      return found;
    };
    const merged = merge(loaded.entries, params.combined);
    merge(loaded.entries, params.rowContextCombined);
    if (loaded.dependencies) {
      merge(loaded.dependencies, params.rowContextCombined);
    }
    if (merged) {
      storePaths.push(target.storePath);
    }
  }
  return storePaths;
}

function resolveCombinedDurableTargets(params: {
  cfg: OpenClawConfig;
  configuredAgentsOnly: boolean;
  defaultAgentId: string;
  diagnostics: string[];
  requestedAgentId?: string;
}): { durableStorePath: string; targets: SessionStoreTarget[] } {
  const storeConfig = params.cfg.session?.store;
  if (!storeConfig || isStorePathTemplate(storeConfig)) {
    const targets = params.requestedAgentId
      ? resolveAgentSessionStoreTargetsSync(params.cfg, params.requestedAgentId)
      : params.configuredAgentsOnly
        ? resolveSessionStoreTargets(params.cfg, { allAgents: true })
        : resolveAllAgentSessionStoreTargetsSync(params.cfg);
    return {
      durableStorePath: resolveCombinedStorePath(
        targets.map((target) => target.storePath),
        storeConfig,
      ),
      targets,
    };
  }
  const ownerIds = new Set(
    params.requestedAgentId
      ? [params.requestedAgentId]
      : params.configuredAgentsOnly
        ? listConfiguredSessionStoreAgentIds(params.cfg)
        : [
            ...listAgentEntries(params.cfg).map((entry) => normalizeAgentId(entry.id)),
            ...listKnownSessionStoreAgentIds(params.cfg),
            params.defaultAgentId,
            LEGACY_IMPLICIT_AGENT_ID,
          ],
  );
  return {
    durableStorePath: resolveStorePath(storeConfig, { agentId: params.defaultAgentId }),
    targets: dedupeSessionStoreTargetsBySqliteTarget(
      [...ownerIds].map((agentId) => ({
        agentId,
        storePath: resolveStorePath(storeConfig, { agentId }),
      })),
      {
        defaultAgentId: params.defaultAgentId,
        onDiagnostic: (diagnostic) => params.diagnostics.push(diagnostic.message),
      },
    ),
  };
}

/** Loads and canonicalizes session entries for gateway views across one or more agent stores. */
export function loadCombinedSessionStoreForGateway(
  cfg: OpenClawConfig,
  opts: {
    agentId?: string;
    configuredAgentsOnly?: boolean;
    includeIncognito?: boolean;
    includeRowContext?: boolean;
    projection?: SessionEntryListScope["projection"];
    query?: SessionEntryListQuery;
  } = {},
): {
  diagnostics?: string[];
  durableStorePath?: string;
  storePath: string;
  store: Record<string, SessionEntry>;
  creatorActors?: NonNullable<SessionEntry["createdActor"]>[];
  rowContextStore?: Record<string, SessionEntry>;
  selectionExact?: boolean;
  totalCount?: number;
} {
  const storeConfig = cfg.session?.store;
  const projection = opts.projection ?? "full";
  const diagnostics: string[] = [];
  const creatorActors = new Map<string, NonNullable<SessionEntry["createdActor"]>>();
  let totalCount = 0;
  // Exclusion happens before path aggregation; filtering rows afterward would
  // still leak a live incognito handle by changing the projected store path.
  const includeIncognito = opts.includeIncognito !== false;
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const requestedAgentId =
    typeof opts.agentId === "string" && opts.agentId.trim()
      ? normalizeAgentId(opts.agentId)
      : undefined;
  const configuredAgentIds =
    opts.configuredAgentsOnly === true && !requestedAgentId
      ? new Set(listConfiguredSessionStoreAgentIds(cfg))
      : undefined;
  const allowedIncognitoAgentIds = requestedAgentId
    ? new Set([requestedAgentId])
    : configuredAgentIds;
  const resolved = resolveCombinedDurableTargets({
    cfg,
    configuredAgentsOnly: opts.configuredAgentsOnly === true,
    defaultAgentId,
    diagnostics,
    ...(requestedAgentId ? { requestedAgentId } : {}),
  });
  const targets = resolved.targets;
  const openIncognito =
    includeIncognito &&
    listOpenIncognitoAgentDatabases().some(
      ({ agentId }) => !allowedIncognitoAgentIds || allowedIncognitoAgentIds.has(agentId),
    );
  let query =
    opts.query && (targets.length !== 1 || openIncognito)
      ? { ...opts.query, limit: undefined }
      : opts.query;
  if (query && requestedAgentId) {
    query = { ...query, ownerAgentId: requestedAgentId };
  }
  if (query) {
    query = { ...query, mainKey: cfg.session?.mainKey };
  }
  const combined: Record<string, SessionEntry> = {};
  const rowContextCombined: Record<string, SessionEntry> = {};
  const combinedSeenSentinelOwners = new Set<string>();
  const rowContextSeenSentinelOwners = new Set<string>();
  let selectionExact = targets.length === 1 && !openIncognito && query?.selectionResidual !== true;
  for (const target of targets) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const loaded = loadGatewayStoreEntries({
      agentId,
      includeDependencies: opts.includeRowContext === true,
      projection,
      ...(query ? { query } : {}),
      storePath,
    });
    totalCount += loaded.totalCount;
    for (const actor of loaded.creatorActors) {
      creatorActors.set(`${actor.type}\0${actor.id ?? ""}`, actor);
    }
    const merge = (
      entries: readonly SessionEntrySummary[],
      destination: Record<string, SessionEntry>,
      seenSentinelOwners: Set<string>,
    ) =>
      mergeGatewayEntries({
        agentId,
        cfg,
        combined: destination,
        ...(configuredAgentIds ? { configuredAgentIds } : {}),
        entries,
        ...(requestedAgentId ? { requestedAgentId } : {}),
        seenSentinelOwners,
      });
    selectionExact = merge(loaded.entries, combined, combinedSeenSentinelOwners) && selectionExact;
    merge(loaded.entries, rowContextCombined, rowContextSeenSentinelOwners);
    if (loaded.dependencies) {
      merge(loaded.dependencies, rowContextCombined, rowContextSeenSentinelOwners);
    }
  }

  const incognitoStorePaths = includeIncognito
    ? mergeOpenIncognitoStores({
        ...(allowedIncognitoAgentIds ? { allowedAgentIds: allowedIncognitoAgentIds } : {}),
        cfg,
        combined,
        includeDependencies: opts.includeRowContext === true,
        rowContextCombined,
        ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
        projection,
        ...(query ? { query } : {}),
      })
    : [];

  const storePath = resolveCombinedStorePath(
    [...targets.map((target) => target.storePath), ...incognitoStorePaths],
    storeConfig,
  );
  return {
    diagnostics,
    durableStorePath: resolved.durableStorePath,
    storePath,
    store: combined,
    ...(Object.keys(rowContextCombined).length > Object.keys(combined).length
      ? { rowContextStore: { ...rowContextCombined, ...combined } }
      : {}),
    ...(opts.query
      ? {
          creatorActors: [...creatorActors.values()],
          selectionExact,
          totalCount,
        }
      : {}),
  };
}
