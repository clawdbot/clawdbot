// Builds the gateway-visible combined session store across agent-specific stores.
// Gateway callers need canonical per-agent keys even when stores are split by `{agentId}`.

import { expectDefined } from "@openclaw/normalization-core";
import { listAgentEntries, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  canonicalizeSpawnedByForAgent,
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
  dedupeSessionStoreTargetsBySqliteTarget,
  listConfiguredSessionStoreAgentIds,
  listKnownSessionStoreAgentIds,
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

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
  storePath: string;
}): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesReadOnly({
      agentId: params.agentId,
      clone: false,
      storePath: params.storePath,
    }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

function loadIncognitoGatewayStoreEntries(params: {
  agentId: string;
  storePath: string;
}): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({
      agentId: params.agentId,
      clone: false,
      storePath: params.storePath,
    }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
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

  if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
    // Preserve the freshest entry while still canonicalizing spawnedBy for this agent store.
    const spawnedBy = canonicalizeSpawnedByForAgent(
      cfg,
      agentId,
      existing.spawnedBy ?? entry.spawnedBy,
    );
    combined[canonicalKey] = {
      ...entry,
      ...existing,
      spawnedBy,
    };
    return;
  }

  const spawnedBy = canonicalizeSpawnedByForAgent(
    cfg,
    agentId,
    entry.spawnedBy ?? existing?.spawnedBy,
  );
  if (!existing && entry.spawnedBy === spawnedBy) {
    combined[canonicalKey] = entry;
  } else {
    combined[canonicalKey] = {
      ...existing,
      ...entry,
      spawnedBy,
    };
  }
}

function mergeOpenIncognitoStores(params: {
  allowedAgentIds?: ReadonlySet<string>;
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  agentId?: string;
}): string[] {
  const storePaths: string[] = [];
  for (const target of listOpenIncognitoAgentDatabases()) {
    if (params.allowedAgentIds && !params.allowedAgentIds.has(target.agentId)) {
      continue;
    }
    if (params.agentId && target.agentId !== params.agentId) {
      continue;
    }
    const store = loadIncognitoGatewayStoreEntries({
      agentId: target.agentId,
      storePath: target.storePath,
    });
    let merged = false;
    for (const [sessionKey, entry] of Object.entries(store)) {
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

/** Loads and canonicalizes session entries for gateway views across one or more agent stores. */
export function loadCombinedSessionStoreForGateway(
  cfg: OpenClawConfig,
  opts: { agentId?: string; configuredAgentsOnly?: boolean; includeIncognito?: boolean } = {},
): {
  diagnostics: string[];
  durableStorePath?: string;
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  const storeConfig = cfg.session?.store;
  const diagnostics: string[] = [];
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
    const combined: Record<string, SessionEntry> = {};
    // Runtime session access is SQLite-only: a fixed literal is a naming seed whose
    // resolved database is partitioned per owner. Legacy flat JSON is migration-only.
    const ownerTargets = dedupeSessionStoreTargetsBySqliteTarget(
      ownerIds.map((agentId) => ({
        agentId,
        storePath: resolveStorePath(storeConfig, { agentId }),
      })),
      {
        defaultAgentId,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      },
    );
    for (const { agentId, storePath } of ownerTargets) {
      const store = loadGatewayStoreEntries({ agentId, storePath });
      for (const [key, entry] of Object.entries(store)) {
        const canonicalKey = resolveStoredSessionKeyForAgentStore({
          cfg,
          agentId,
          sessionKey: key,
        });
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
    const incognitoStorePaths = includeIncognito
      ? mergeOpenIncognitoStores({
          ...(allowedIncognitoAgentIds ? { allowedAgentIds: allowedIncognitoAgentIds } : {}),
          cfg,
          combined,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
        })
      : [];
    return {
      diagnostics,
      durableStorePath,
      storePath: incognitoStorePaths.length > 0 ? "(multiple)" : durableStorePath,
      store: combined,
    };
  }
  const targets = requestedAgentId
    ? resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId)
    : opts.configuredAgentsOnly === true
      ? resolveSessionStoreTargets(cfg, { allAgents: true })
      : resolveAllAgentSessionStoreTargetsSync(cfg);
  const combined: Record<string, SessionEntry> = {};
  for (const target of targets) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const store = loadGatewayStoreEntries({ agentId, storePath });
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId,
        sessionKey: key,
      });
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

  const incognitoStorePaths = includeIncognito
    ? mergeOpenIncognitoStores({
        ...(allowedIncognitoAgentIds ? { allowedAgentIds: allowedIncognitoAgentIds } : {}),
        cfg,
        combined,
        ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
      })
    : [];

  const durableStorePaths = targets.map((target) => target.storePath);
  const durableStorePath = resolveCombinedStorePath(durableStorePaths, storeConfig);
  const storePath = resolveCombinedStorePath(
    [...durableStorePaths, ...incognitoStorePaths],
    storeConfig,
  );
  return { diagnostics, durableStorePath, storePath, store: combined };
}
