// Builds the gateway-visible combined session store across agent-specific stores.
// Gateway callers need canonical per-agent keys even when stores are split by `{agentId}`.

import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../../agents/agent-scope.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "../../gateway/session-store-key.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  listOpenClawRegisteredAgentDatabases,
  listOpenIncognitoAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
  readOpenIncognitoAgentDatabaseGeneration,
} from "../../state/openclaw-agent-db.js";
import { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionStorePathCore } from "./paths.js";
import {
  countSessionEntryRowsReadOnly,
  listSessionEntriesCore,
  listSessionEntriesReadOnly,
} from "./session-accessor.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  listConfiguredSessionStoreAgentIds,
  listKnownSessionStoreAgentIds,
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

type GatewaySessionEntryProjection = NonNullable<SessionEntryListScope["projection"]>;

type GatewaySessionStoreOptions = {
  agentId?: string;
  configuredAgentsOnly?: boolean;
  includeIncognito?: boolean;
  projection?: SessionEntryListScope["projection"];
};

type ResolvedGatewaySessionStoreTargets = {
  configuredAgentIds?: ReadonlySet<string>;
  defaultAgentId: string;
  diagnostics: readonly string[];
  durableStorePath?: string;
  durableTargets: ReadonlyArray<{ agentId: string; storePath: string }>;
  incognitoTargets: ReadonlyArray<{ agentId: string; storePath: string }>;
  requestedAgentId?: string;
  storeConfig?: string;
};

type PreparedConfiguredSessionStoreTargets = {
  cfg: OpenClawConfig;
  includeIncognito: boolean;
  incognitoGeneration: number;
  registryToken: symbol;
  resolved: ResolvedGatewaySessionStoreTargets;
};

// Gateway aliases, config, registry, and incognito topology are process-stable until
// an explicit generation change or restart; generic CLI/Doctor dedupe stays fresh.
let preparedConfiguredSessionStoreTargets: PreparedConfiguredSessionStoreTargets | undefined;

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

function resolveCombinedDatabasePath(
  targets: ReadonlyArray<{ agentId: string; storePath: string }>,
  defaultAgentId: string,
  physicallyDeduped = false,
): string {
  if (physicallyDeduped && targets.length !== 1) {
    return "(multiple)";
  }
  const paths = [
    ...new Set(
      targets.map(
        (target) =>
          resolveSqliteTargetFromSessionStorePath(target.storePath, {
            agentId: target.agentId,
            defaultAgentId,
          }).path,
      ),
    ),
  ];
  return paths.length === 1 ? expectDefined(paths[0], "database path at 0") : "(multiple)";
}

function loadGatewayStoreEntries(params: {
  agentId: string;
  includeOpenDatabases?: boolean;
  projection: GatewaySessionEntryProjection;
  storePath: string;
}) {
  const listEntries = params.includeOpenDatabases
    ? listSessionEntriesCore
    : listSessionEntriesReadOnly;
  return listEntries({
    agentId: params.agentId,
    clone: false,
    projection: params.projection,
    storePath: params.storePath,
  });
}

function mergeSessionEntryIntoCombined(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  entry: SessionEntry;
  agentId: string;
  canonicalKey: string;
}) {
  const { cfg, combined, entry, agentId, canonicalKey } = params;
  const existing = combined[canonicalKey];
  if (existing && (canonicalKey === "global" || canonicalKey === "unknown")) {
    // Reserved sentinels remain per-store federation state until goal 3 decides
    // how multi-store ownership composes; target order owns the projection.
    return;
  }
  if (existing) {
    throw canonicalSessionKeyMigrationRequiredError(
      `duplicate rows resolve to canonical session key ${canonicalKey}`,
    );
  }
  const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(canonicalKey, entry);
  if (deliveryCanonicalKey !== canonicalKey) {
    throw canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
    );
  }
  const resolveLineageKey = (sessionKey: string | undefined) =>
    sessionKey ? resolveSessionStoreKey({ cfg, sessionKey, storeAgentId: agentId }) : undefined;
  combined[canonicalKey] = {
    ...entry,
    ...(entry.parentSessionKey
      ? { parentSessionKey: resolveLineageKey(entry.parentSessionKey) }
      : {}),
    ...(entry.spawnedBy ? { spawnedBy: resolveLineageKey(entry.spawnedBy) } : {}),
  };
}

function mergeOpenIncognitoStores(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  projection: GatewaySessionEntryProjection;
  targets: ReadonlyArray<{ agentId: string; storePath: string }>;
}): string[] {
  const storePaths: string[] = [];
  for (const target of params.targets) {
    const store = loadGatewayStoreEntries({
      agentId: target.agentId,
      includeOpenDatabases: true,
      projection: params.projection,
      storePath: target.storePath,
    });
    let merged = false;
    for (const { sessionKey, entry } of store) {
      if (!isIncognitoSessionKey(sessionKey) || entry.incognito !== true) {
        continue;
      }
      mergeSessionEntryIntoCombined({
        cfg: params.cfg,
        combined: params.combined,
        entry,
        agentId: target.agentId,
        canonicalKey: sessionKey,
      });
      merged = true;
    }
    if (merged) {
      storePaths.push(target.storePath);
    }
  }
  return storePaths;
}

function filterCombinedStoreToConfiguredAgents(params: {
  cfg: OpenClawConfig;
  configuredAgentIds: ReadonlySet<string>;
  store: Record<string, SessionEntry>;
}): void {
  const isConfiguredSessionKey = (key: string | undefined) => {
    const normalizedKey = normalizeOptionalString(key);
    if (!normalizedKey) {
      return false;
    }
    const canonicalKey = resolveSessionStoreKey({ cfg: params.cfg, sessionKey: normalizedKey });
    const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
    return params.configuredAgentIds.has(normalizeAgentId(agentId));
  };
  for (const [key, entry] of Object.entries(params.store)) {
    const keep =
      key === "global" ||
      key === "unknown" ||
      isConfiguredSessionKey(key) ||
      isConfiguredSessionKey(entry.spawnedBy) ||
      isConfiguredSessionKey(entry.parentSessionKey);
    if (!keep) {
      delete params.store[key];
    }
  }
}

function resolvePreparedConfiguredSessionStoreTargets(
  cfg: OpenClawConfig,
  includeIncognito: boolean,
): ResolvedGatewaySessionStoreTargets {
  const registryToken = readOpenClawAgentDatabaseRegistryToken();
  const incognitoGeneration = readOpenIncognitoAgentDatabaseGeneration();
  const cached = preparedConfiguredSessionStoreTargets;
  if (
    cached?.cfg === cfg &&
    cached.registryToken === registryToken &&
    cached.incognitoGeneration === incognitoGeneration &&
    cached.includeIncognito === includeIncognito
  ) {
    return cached.resolved;
  }

  const storeConfig = cfg.session?.store;
  const defaultAgentId = normalizeAgentId(resolveSessionStoreCompatibilityAgentId(cfg));
  const configuredIds = listConfiguredSessionStoreAgentIds(cfg);
  const configuredAgentIds = new Set(configuredIds);
  const incognitoTargets = includeIncognito ? listOpenIncognitoAgentDatabases() : [];
  const incognitoTargetKeys = new Set(
    incognitoTargets.map((target) => `${target.agentId}\0${target.storePath}`),
  );
  const diagnostics: string[] = [];
  const candidates = dedupeSessionStoreTargetsBySqliteTarget(
    [
      ...listOpenClawRegisteredAgentDatabases().map(({ agentId, path }) => ({
        agentId,
        storePath: path,
      })),
      ...configuredIds.map((agentId) => ({
        agentId,
        storePath: resolveSessionStorePathCore(storeConfig, { agentId }),
      })),
      ...incognitoTargets,
    ],
    {
      defaultAgentId,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    },
  );
  const durableTargets = candidates.filter(
    (target) => !incognitoTargetKeys.has(`${target.agentId}\0${target.storePath}`),
  );
  const resolved = Object.freeze({
    configuredAgentIds,
    defaultAgentId,
    diagnostics: Object.freeze(diagnostics),
    durableStorePath: resolveCombinedDatabasePath(durableTargets, defaultAgentId, true),
    durableTargets: Object.freeze(durableTargets.map((target) => Object.freeze({ ...target }))),
    incognitoTargets: Object.freeze(
      candidates
        .filter((target) => incognitoTargetKeys.has(`${target.agentId}\0${target.storePath}`))
        .map((target) => Object.freeze({ ...target })),
    ),
    storeConfig,
  });
  preparedConfiguredSessionStoreTargets = {
    cfg,
    includeIncognito,
    incognitoGeneration,
    registryToken,
    resolved,
  };
  return resolved;
}

function resolveGatewaySessionStoreTargets(
  cfg: OpenClawConfig,
  opts: GatewaySessionStoreOptions,
): ResolvedGatewaySessionStoreTargets {
  const storeConfig = cfg.session?.store;
  const diagnostics: string[] = [];
  const requestedAgentId =
    typeof opts.agentId === "string" && opts.agentId.trim()
      ? normalizeAgentId(opts.agentId)
      : undefined;
  if (opts.configuredAgentsOnly === true && !requestedAgentId) {
    return resolvePreparedConfiguredSessionStoreTargets(cfg, opts.includeIncognito !== false);
  }
  const defaultAgentId = normalizeAgentId(resolveSessionStoreCompatibilityAgentId(cfg));
  const incognitoTargets =
    opts.includeIncognito === false
      ? []
      : listOpenIncognitoAgentDatabases().filter(
          (target) => !requestedAgentId || target.agentId === requestedAgentId,
        );

  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const ownerIds = [
      ...new Set([
        ...listAgentEntries(cfg).map((entry) => normalizeAgentId(entry.id)),
        ...listKnownSessionStoreAgentIds(cfg),
        defaultAgentId,
        ...(requestedAgentId ? [requestedAgentId] : []),
      ]),
    ];
    const durableTargets = dedupeSessionStoreTargetsBySqliteTarget(
      ownerIds.map((agentId) => ({
        agentId,
        storePath: resolveSessionStorePathCore(storeConfig, { agentId }),
      })),
      {
        defaultAgentId,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      },
    );
    return {
      defaultAgentId,
      diagnostics,
      durableTargets,
      incognitoTargets,
      requestedAgentId,
      storeConfig,
    };
  }

  const durableTargets = requestedAgentId
    ? dedupeSessionStoreTargetsBySqliteTarget(
        resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId),
        { defaultAgentId },
      )
    : resolveAllAgentSessionStoreTargetsSync(cfg);
  return {
    defaultAgentId,
    diagnostics,
    durableTargets,
    incognitoTargets,
    requestedAgentId,
    storeConfig,
  };
}

/** Checks whether Gateway prewarm can project the selected stores within a bounded row budget. */
export function canPrewarmCombinedSessionStoresForGateway(
  cfg: OpenClawConfig,
  params: { agentIds: readonly string[]; maxRows: number },
): boolean {
  let totalRows = 0;
  for (const agentId of params.agentIds) {
    const resolved = resolveGatewaySessionStoreTargets(cfg, { agentId });
    const projectionTargets =
      resolved.incognitoTargets.length === 0
        ? resolved.durableTargets
        : dedupeSessionStoreTargetsBySqliteTarget(
            [...resolved.durableTargets, ...resolved.incognitoTargets],
            { defaultAgentId: resolved.defaultAgentId },
          );
    for (const target of projectionTargets) {
      totalRows += countSessionEntryRowsReadOnly(target);
      if (totalRows > params.maxRows) {
        return false;
      }
    }
  }
  return true;
}

/** Loads and canonicalizes session entries for gateway views across one or more agent stores. */
export function loadCombinedSessionStoreForGatewayCore(
  cfg: OpenClawConfig,
  opts: GatewaySessionStoreOptions = {},
): {
  diagnostics?: readonly string[];
  durableStorePath?: string;
  durableTargets: ReadonlyArray<{ agentId: string; storePath: string }>;
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  const projection = opts.projection ?? "full";
  // Count admission and projection share this exact target set. Otherwise an optional
  // prewarm can approve one database and synchronously materialize another.
  const {
    configuredAgentIds,
    defaultAgentId,
    diagnostics,
    durableStorePath: preparedDurableStorePath,
    durableTargets,
    incognitoTargets,
    requestedAgentId,
    storeConfig,
  } = resolveGatewaySessionStoreTargets(cfg, opts);
  const combined: Record<string, SessionEntry> = {};
  for (const target of durableTargets) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const store = loadGatewayStoreEntries({ agentId, projection, storePath });
    for (const { sessionKey: key, entry } of store) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId,
        sessionKey: key,
      });
      if (key !== canonicalKey) {
        throw canonicalSessionKeyMigrationRequiredError(
          `non-canonical persisted row resolves to session key ${canonicalKey}`,
        );
      }
      const canonicalAgentId = normalizeAgentId(
        parseAgentSessionKey(canonicalKey)?.agentId ?? agentId,
      );
      if (requestedAgentId && canonicalAgentId !== requestedAgentId) {
        continue;
      }
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId: canonicalAgentId,
        canonicalKey,
      });
    }
  }

  const incognitoStorePaths = mergeOpenIncognitoStores({
    cfg,
    combined,
    projection,
    targets: incognitoTargets,
  });
  if (configuredAgentIds) {
    filterCombinedStoreToConfiguredAgents({ cfg, configuredAgentIds, store: combined });
  }

  const durableStorePaths = durableTargets.map((target) => target.storePath);
  const durableStorePath =
    preparedDurableStorePath ?? resolveCombinedDatabasePath(durableTargets, defaultAgentId);
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    return {
      diagnostics,
      durableStorePath,
      durableTargets,
      storePath: incognitoStorePaths.length > 0 ? "(multiple)" : durableStorePath,
      store: combined,
    };
  }
  const storePath = resolveCombinedStorePath(
    [...durableStorePaths, ...incognitoStorePaths],
    storeConfig,
  );
  return { diagnostics, durableStorePath, durableTargets, storePath, store: combined };
}
