// Builds the gateway-visible combined session store across agent-specific stores.
// Gateway callers need canonical per-agent keys even when stores are split by `{agentId}`.

import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../../agents/agent-scope.js";
import {
  resolveSessionStoreAgentId,
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
import { canonicalizeMainSessionAlias } from "./main-session.js";
import { resolveSessionStorePathCore } from "./paths.js";
import {
  countSessionEntryRowsReadOnly,
  listSessionEntriesCore,
  listSessionEntriesReadOnly,
} from "./session-accessor.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import { resolvePersistedSessionStoreOwner } from "./session-store-owner.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  listConfiguredSessionStoreAgentIds,
  listKnownSessionStoreAgentIds,
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  type SessionStoreTarget,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

type GatewaySessionEntryProjection = NonNullable<SessionEntryListScope["projection"]>;

type GatewayStoredSessionTarget = {
  agentId: string;
  storeTarget: SessionStoreTarget;
};

export type GatewayStoredSessionTargets = ReadonlyMap<string, GatewayStoredSessionTarget>;

function storeTargetKey(target: SessionStoreTarget): string {
  return `${target.agentId}\0${target.storePath}`;
}

function capturePhysicalStoreTargets() {
  const physicalTargets = new Map<string, SessionStoreTarget>();
  return {
    physicalTargets,
    onResolvedTarget: (selected: SessionStoreTarget, physical: SessionStoreTarget) => {
      physicalTargets.set(storeTargetKey(selected), physical);
    },
  };
}

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
  physicalTargets: ReadonlyMap<string, SessionStoreTarget>;
  requestedAgentId?: string;
  sharedStoreRowOwner?: { agentId: string; target: SessionStoreTarget };
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
  targets: readonly SessionStoreTarget[],
  physicalTargets: ReadonlyMap<string, SessionStoreTarget>,
): string {
  const paths = [
    ...new Set(
      targets.map(
        (target) =>
          expectDefined(physicalTargets.get(storeTargetKey(target)), "physical store").storePath,
      ),
    ),
  ];
  return paths.length === 1 ? expectDefined(paths[0], "database path at 0") : "(multiple)";
}

function resolveSharedStoreRowOwner(
  cfg: OpenClawConfig,
  selected: SessionStoreTarget,
  sharedStorePaths: ReadonlySet<string>,
): ResolvedGatewaySessionStoreTargets["sharedStoreRowOwner"] {
  const configuredPath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: resolveSessionStoreCompatibilityAgentId(cfg),
  });
  // Registry aliases do not turn legacy selectors into shared stores. Reuse the
  // configured selector's own classification from the physical dedupe pass.
  if (!sharedStorePaths.has(configuredPath)) {
    return undefined;
  }
  const persistedOwner = resolvePersistedSessionStoreOwner(cfg);
  return persistedOwner.kind === "configured"
    ? { agentId: persistedOwner.agentId, target: selected }
    : undefined;
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
  targetsBySessionKey: Map<string, GatewayStoredSessionTarget>;
  entry: SessionEntry;
  target: GatewayStoredSessionTarget;
  canonicalKey: string;
}) {
  const { cfg, combined, entry, target, canonicalKey } = params;
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
  const projected = { ...entry };
  // SQLite validates lineage shape; qualified global aliases still depend on config.
  // Keep reserved sentinels intact and resolve each alias with its own agent.
  if (cfg.session?.scope === "global") {
    for (const field of ["parentSessionKey", "spawnedBy"] as const) {
      const sessionKey = projected[field];
      const parsed = sessionKey ? parseAgentSessionKey(sessionKey) : null;
      if (sessionKey && parsed) {
        projected[field] = canonicalizeMainSessionAlias({
          cfg,
          agentId: parsed.agentId,
          sessionKey,
        });
      }
    }
  }
  combined[canonicalKey] = projected;
  params.targetsBySessionKey.set(canonicalKey, target);
}

function mergeOpenIncognitoStores(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  targetsBySessionKey: Map<string, GatewayStoredSessionTarget>;
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
        targetsBySessionKey: params.targetsBySessionKey,
        entry,
        target: { agentId: target.agentId, storeTarget: target },
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
  targetsBySessionKey: Map<string, GatewayStoredSessionTarget>;
}): void {
  const isConfiguredSessionKey = (key: string | undefined) => {
    const normalizedKey = normalizeOptionalString(key);
    if (!normalizedKey) {
      return false;
    }
    // Stored keys already carry canonical owners; incoming aliases can retarget retired lineage.
    const agentId = resolveSessionStoreAgentId(params.cfg, normalizedKey);
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
      params.targetsBySessionKey.delete(key);
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
  const { physicalTargets, onResolvedTarget } = capturePhysicalStoreTargets();
  let sharedStoreRowOwner: ResolvedGatewaySessionStoreTargets["sharedStoreRowOwner"];
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
      onResolvedTarget,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      onSharedTarget: (selected, paths) => {
        sharedStoreRowOwner ??= resolveSharedStoreRowOwner(cfg, selected, paths);
      },
    },
  );
  const durableTargets = candidates.filter(
    (target) => !incognitoTargetKeys.has(`${target.agentId}\0${target.storePath}`),
  );
  const resolved = Object.freeze({
    configuredAgentIds,
    defaultAgentId,
    diagnostics: Object.freeze(diagnostics),
    durableStorePath: resolveCombinedDatabasePath(durableTargets, physicalTargets),
    durableTargets: Object.freeze(durableTargets.map((target) => Object.freeze({ ...target }))),
    incognitoTargets: Object.freeze(
      candidates
        .filter((target) => incognitoTargetKeys.has(`${target.agentId}\0${target.storePath}`))
        .map((target) => Object.freeze({ ...target })),
    ),
    sharedStoreRowOwner,
    physicalTargets,
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
  const { physicalTargets, onResolvedTarget } = capturePhysicalStoreTargets();
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
    let sharedStoreRowOwner: ResolvedGatewaySessionStoreTargets["sharedStoreRowOwner"];
    const durableTargets = dedupeSessionStoreTargetsBySqliteTarget(
      ownerIds.map((agentId) => ({
        agentId,
        storePath: resolveSessionStorePathCore(storeConfig, { agentId }),
      })),
      {
        defaultAgentId,
        onResolvedTarget,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
        onSharedTarget: (selected, paths) => {
          sharedStoreRowOwner ??= resolveSharedStoreRowOwner(cfg, selected, paths);
        },
      },
    );
    return {
      defaultAgentId,
      diagnostics,
      durableTargets,
      incognitoTargets,
      requestedAgentId,
      sharedStoreRowOwner,
      physicalTargets,
      storeConfig,
    };
  }

  const durableTargets = requestedAgentId
    ? dedupeSessionStoreTargetsBySqliteTarget(
        resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId),
        { defaultAgentId, onResolvedTarget },
      )
    : resolveAllAgentSessionStoreTargetsSync(cfg, { onResolvedTarget });
  return {
    defaultAgentId,
    diagnostics,
    durableTargets,
    incognitoTargets,
    physicalTargets,
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
  targetsBySessionKey: GatewayStoredSessionTargets;
} {
  const projection = opts.projection ?? "full";
  // Count admission and projection share this exact target set. Otherwise an optional
  // prewarm can approve one database and synchronously materialize another.
  const {
    configuredAgentIds,
    diagnostics,
    durableStorePath: preparedDurableStorePath,
    durableTargets,
    incognitoTargets,
    physicalTargets,
    requestedAgentId,
    sharedStoreRowOwner,
    storeConfig,
  } = resolveGatewaySessionStoreTargets(cfg, opts);
  const combined: Record<string, SessionEntry> = {};
  // Federation chooses both the logical owner and physical store once. Fresh reads
  // must not re-admit a sentinel through public aliases or select a different store.
  const targetsBySessionKey = new Map<string, GatewayStoredSessionTarget>();
  for (const target of durableTargets) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const storeTarget = expectDefined(
      physicalTargets.get(storeTargetKey(target)),
      "physical store",
    );
    const store = loadGatewayStoreEntries({ ...storeTarget, projection });
    // Legacy selector paths can be shared by distinct physical agent partitions.
    const rowAgentId =
      sharedStoreRowOwner?.target.storePath === storePath &&
      sharedStoreRowOwner.target.agentId === agentId
        ? sharedStoreRowOwner.agentId
        : agentId;
    for (const { sessionKey: key, entry } of store) {
      const parsed = parseAgentSessionKey(key);
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        // Qualified retired-owner keys keep their physical store's canonicalization context.
        agentId: parsed ? storeTarget.agentId : rowAgentId,
        sessionKey: key,
      });
      if (key !== canonicalKey) {
        throw canonicalSessionKeyMigrationRequiredError(
          `non-canonical persisted row resolves to session key ${canonicalKey}`,
        );
      }
      const canonicalAgentId = normalizeAgentId(parsed?.agentId ?? rowAgentId);
      if (requestedAgentId && canonicalAgentId !== requestedAgentId) {
        continue;
      }
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        targetsBySessionKey,
        entry,
        target: { agentId: canonicalAgentId, storeTarget },
        canonicalKey,
      });
    }
  }

  const incognitoStorePaths = mergeOpenIncognitoStores({
    cfg,
    combined,
    targetsBySessionKey,
    projection,
    targets: incognitoTargets,
  });
  if (configuredAgentIds) {
    filterCombinedStoreToConfiguredAgents({
      cfg,
      configuredAgentIds,
      store: combined,
      targetsBySessionKey,
    });
  }

  const durableStorePaths = durableTargets.map((target) => target.storePath);
  const durableStorePath =
    preparedDurableStorePath ?? resolveCombinedDatabasePath(durableTargets, physicalTargets);
  const storePath =
    storeConfig && !isStorePathTemplate(storeConfig)
      ? incognitoStorePaths.length > 0
        ? "(multiple)"
        : durableStorePath
      : resolveCombinedStorePath([...durableStorePaths, ...incognitoStorePaths], storeConfig);
  return {
    diagnostics,
    durableStorePath,
    durableTargets,
    storePath,
    store: combined,
    targetsBySessionKey,
  };
}
