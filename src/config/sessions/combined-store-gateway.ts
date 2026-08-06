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
import {
  countSessionEntryRowsReadOnly,
  listSessionEntries,
  listSessionEntriesReadOnly,
} from "./session-accessor.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  listConfiguredSessionStoreAgentIds,
  listKnownSessionStoreAgentIds,
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
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
  diagnostics: string[];
  durableTargets: Array<{ agentId: string; storePath: string }>;
  incognitoTargets: Array<{ agentId: string; storePath: string }>;
  requestedAgentId?: string;
  storeConfig?: string;
};

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
  includeOpenDatabases?: boolean;
  projection: GatewaySessionEntryProjection;
  storePath: string;
}) {
  const listEntries = params.includeOpenDatabases ? listSessionEntries : listSessionEntriesReadOnly;
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
  targets: Array<{ agentId: string; storePath: string }>;
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

function resolveGatewaySessionStoreTargets(
  cfg: OpenClawConfig,
  opts: GatewaySessionStoreOptions,
): ResolvedGatewaySessionStoreTargets {
  const storeConfig = cfg.session?.store;
  const diagnostics: string[] = [];
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
  const incognitoTargets =
    opts.includeIncognito === false
      ? []
      : listOpenIncognitoAgentDatabases().filter(
          (target) => !allowedIncognitoAgentIds || allowedIncognitoAgentIds.has(target.agentId),
        );

  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const ownerIds = [
      ...new Set([
        ...listAgentEntries(cfg).map((entry) => normalizeAgentId(entry.id)),
        ...listKnownSessionStoreAgentIds(cfg),
        defaultAgentId,
        LEGACY_IMPLICIT_AGENT_ID,
        ...(requestedAgentId ? [requestedAgentId] : []),
      ]),
    ];
    const durableTargets = dedupeSessionStoreTargetsBySqliteTarget(
      ownerIds.map((agentId) => ({
        agentId,
        storePath: resolveStorePath(storeConfig, { agentId }),
      })),
      {
        defaultAgentId,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      },
    );
    return {
      configuredAgentIds,
      defaultAgentId,
      diagnostics,
      durableTargets,
      incognitoTargets,
      requestedAgentId,
      storeConfig,
    };
  }

  const durableTargets = requestedAgentId
    ? resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId)
    : opts.configuredAgentsOnly === true
      ? resolveSessionStoreTargets(cfg, { allAgents: true })
      : resolveAllAgentSessionStoreTargetsSync(cfg);
  return {
    configuredAgentIds,
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
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  let totalRows = 0;
  for (const agentId of params.agentIds) {
    const resolved = resolveGatewaySessionStoreTargets(cfg, { agentId });
    const projectionTargets = dedupeSessionStoreTargetsBySqliteTarget(
      [...resolved.durableTargets, ...resolved.incognitoTargets],
      { defaultAgentId },
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
export function loadCombinedSessionStoreForGateway(
  cfg: OpenClawConfig,
  opts: GatewaySessionStoreOptions = {},
): {
  diagnostics?: string[];
  durableStorePath?: string;
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
    durableTargets,
    incognitoTargets,
    requestedAgentId,
    storeConfig,
  } = resolveGatewaySessionStoreTargets(cfg, opts);
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const combined: Record<string, SessionEntry> = {};
    for (const { agentId, storePath } of durableTargets) {
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
        if (configuredAgentIds && !configuredAgentIds.has(canonicalAgentId)) {
          continue;
        }
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
    const durableStorePath = resolveStorePath(storeConfig, { agentId: defaultAgentId });
    const incognitoStorePaths = mergeOpenIncognitoStores({
      cfg,
      combined,
      projection,
      targets: incognitoTargets,
    });
    return {
      diagnostics,
      durableStorePath,
      storePath: incognitoStorePaths.length > 0 ? "(multiple)" : durableStorePath,
      store: combined,
    };
  }
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
      if (configuredAgentIds && !configuredAgentIds.has(canonicalAgentId)) {
        continue;
      }
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

  const durableStorePaths = durableTargets.map((target) => target.storePath);
  const durableStorePath = resolveCombinedStorePath(durableStorePaths, storeConfig);
  const storePath = resolveCombinedStorePath(
    [...durableStorePaths, ...incognitoStorePaths],
    storeConfig,
  );
  return { diagnostics, durableStorePath, storePath, store: combined };
}
