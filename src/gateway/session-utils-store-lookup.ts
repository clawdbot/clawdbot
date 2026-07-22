import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds } from "../agents/agent-scope.js";
import {
  isConfiguredSessionStoreAgentId,
  resolveAgentMainSessionKey,
  resolveAllAgentSessionStoreTargetsSync,
  resolveExistingAgentSessionStoreTargetsSync,
  resolveStorePath,
  type SessionEntry,
  type SessionStoreTarget,
} from "../config/sessions.js";
import {
  listSessionEntries as listAccessorSessionEntries,
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_AGENT_ID,
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "./session-store-key.js";
import type {
  GatewaySessionStoreTarget,
  GatewaySessionStoreTargetWithStore,
} from "./session-utils-contracts.js";

function findFreshestStoreMatch(
  store: Record<string, SessionEntry>,
  ...candidates: string[]
): { entry: SessionEntry; key: string } | undefined {
  const matches = new Map<string, { entry: SessionEntry; key: string }>();
  for (const candidate of candidates) {
    const trimmed = normalizeOptionalString(candidate) ?? "";
    if (!trimmed) {
      continue;
    }
    const exact = store[trimmed];
    if (exact) {
      matches.set(trimmed, { entry: exact, key: trimmed });
    }
  }
  if (matches.size === 0) {
    return undefined;
  }
  let freshest: { entry: SessionEntry; key: string } | undefined;
  for (const match of matches.values()) {
    if (!freshest || (match.entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) {
      freshest = match;
    }
  }
  return freshest;
}

function buildGatewaySessionStoreScanTargets(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
  agentId: string;
}): string[] {
  const targets = new Set<string>();
  if (params.canonicalKey) {
    targets.add(params.canonicalKey);
  }
  if (params.key && params.key !== params.canonicalKey) {
    targets.add(params.key);
  }
  if (params.canonicalKey === "global" || params.canonicalKey === "unknown") {
    return [...targets];
  }
  const agentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId });
  if (params.canonicalKey === agentMainKey) {
    targets.add(`agent:${params.agentId}:main`);
  }
  return [...targets];
}

function resolveGatewaySessionStoreCandidates(
  cfg: OpenClawConfig,
  agentId: string,
): { existing: SessionStoreTarget[]; fallback: SessionStoreTarget } {
  const storeConfig = cfg.session?.store;
  const fallback = {
    agentId,
    storePath: resolveStorePath(storeConfig, { agentId }),
  };
  return {
    existing: resolveExistingAgentSessionStoreTargetsSync(cfg, agentId),
    fallback,
  };
}

function loadGatewaySessionLookupStore(
  storePath: string,
  clone: boolean | undefined,
  agentId?: string,
  options: { readOnly?: boolean } = {},
): Record<string, SessionEntry> {
  try {
    const listEntries = options.readOnly
      ? listAccessorSessionEntriesReadOnly
      : listAccessorSessionEntries;
    return Object.fromEntries(
      listEntries({
        ...(agentId ? { agentId } : {}),
        ...(clone === false ? { clone: false } : {}),
        storePath,
      }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
  } catch {
    return {};
  }
}

function resolveGatewaySessionStoreLookup(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
  agentId: string;
  clone?: boolean;
  initialStore?: Record<string, SessionEntry>;
  readOnly?: boolean;
}): {
  storePath: string;
  store: Record<string, SessionEntry>;
  match: { entry: SessionEntry; key: string } | undefined;
} {
  const scanTargets = buildGatewaySessionStoreScanTargets(params);
  const { existing, fallback } = resolveGatewaySessionStoreCandidates(params.cfg, params.agentId);
  const configured = isConfiguredSessionStoreAgentId(params.cfg, params.agentId);
  const candidates = configured
    ? [fallback, ...existing.filter((target) => target.storePath !== fallback.storePath)]
    : existing;
  if (candidates.length === 0) {
    // Discovery is read-only. Only configured agents may cross the fallback edge that creates a
    // missing SQLite store; retired/manual agents must already have a discovered store.
    return {
      storePath: fallback.storePath,
      store: {},
      match: undefined,
    };
  }
  const loadStore = (target: SessionStoreTarget) =>
    loadGatewaySessionLookupStore(target.storePath, params.clone, target.agentId, {
      readOnly: params.readOnly || !configured,
    });
  const firstCandidate = candidates[0] ?? fallback;
  let selectedStorePath = firstCandidate.storePath;
  let selectedStore =
    params.initialStore && firstCandidate.storePath === fallback.storePath
      ? params.initialStore
      : loadStore(firstCandidate);
  let selectedMatch = findFreshestStoreMatch(selectedStore, ...scanTargets);
  let selectedUpdatedAt = selectedMatch?.entry.updatedAt ?? Number.NEGATIVE_INFINITY;

  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const store = loadStore(candidate);
    const match = findFreshestStoreMatch(store, ...scanTargets);
    if (!match) {
      continue;
    }
    const updatedAt = match.entry.updatedAt ?? 0;
    // Mirror combined-store merge behavior so follow-up mutations target the
    // same backing store that won the listing merge when ids collide.
    if (!selectedMatch || updatedAt >= selectedUpdatedAt) {
      selectedStorePath = candidate.storePath;
      selectedStore = store;
      selectedMatch = match;
      selectedUpdatedAt = updatedAt;
    }
  }

  return {
    storePath: selectedStorePath,
    store: selectedStore,
    match: selectedMatch,
  };
}

function isAgentScopedSentinelSessionKey(canonicalKey: string): boolean {
  return canonicalKey === "global" || canonicalKey === "unknown";
}

function resolveExplicitDeletedLegacyMainStoreTarget(params: {
  cfg: OpenClawConfig;
  key: string;
  clone?: boolean;
  readOnly?: boolean;
}): GatewaySessionStoreTargetWithStore | null {
  const parsed = parseAgentSessionKey(params.key);
  const legacyAgentId = normalizeAgentId(parsed?.agentId);
  if (
    !parsed ||
    legacyAgentId !== DEFAULT_AGENT_ID ||
    listAgentIds(params.cfg).includes(legacyAgentId)
  ) {
    return null;
  }

  // Only preserve agent:main:* when it is backed by a discovered deleted-main store.
  // Shared-store legacy aliases should continue remapping to the configured default agent.
  const canonicalKey = resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId: legacyAgentId,
    sessionKey: params.key,
  });
  const agentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: legacyAgentId });
  const legacyAgentMainKey = `agent:${legacyAgentId}:main`;
  const lookupSeeds = Array.from(
    new Set([params.key, canonicalKey, agentMainKey, legacyAgentMainKey]),
  );
  let best:
    | {
        storePath: string;
        store: Record<string, SessionEntry>;
        match: { entry: SessionEntry; key: string };
      }
    | undefined;
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg)) {
    if (target.agentId !== legacyAgentId) {
      continue;
    }
    const store = loadGatewaySessionLookupStore(target.storePath, params.clone, target.agentId, {
      readOnly: true,
    });
    const match = findFreshestStoreMatch(store, ...lookupSeeds);
    if (!match) {
      continue;
    }
    if (!best || (match.entry.updatedAt ?? 0) >= (best.match.entry.updatedAt ?? 0)) {
      best = { storePath: target.storePath, store, match };
    }
  }
  if (!best) {
    return null;
  }

  const storeKeys = new Set<string>([canonicalKey]);
  if (params.key !== canonicalKey) {
    storeKeys.add(params.key);
  }
  storeKeys.add(best.match.key);
  for (const seed of lookupSeeds) {
    storeKeys.add(seed);
  }
  return {
    agentId: legacyAgentId,
    storePath: best.storePath,
    canonicalKey,
    storeKeys: Array.from(storeKeys),
    store: best.store,
  };
}

export function resolveGatewaySessionStoreTargetWithStore(params: {
  cfg: OpenClawConfig;
  key: string;
  agentId?: string;
  clone?: boolean;
  readOnly?: boolean;
  store?: Record<string, SessionEntry>;
}): GatewaySessionStoreTargetWithStore {
  const key = normalizeOptionalString(params.key) ?? "";
  const explicitDeletedMainTarget = resolveExplicitDeletedLegacyMainStoreTarget({
    cfg: params.cfg,
    key,
    clone: params.clone,
    readOnly: params.readOnly,
  });
  if (explicitDeletedMainTarget) {
    return explicitDeletedMainTarget;
  }

  const requestedAgentId = normalizeOptionalString(params.agentId);
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: key,
    ...(requestedAgentId ? { storeAgentId: requestedAgentId } : {}),
  });
  const agentId =
    requestedAgentId &&
    (isAgentScopedSentinelSessionKey(canonicalKey) || !parseAgentSessionKey(key))
      ? normalizeAgentId(requestedAgentId)
      : resolveSessionStoreAgentId(params.cfg, canonicalKey);
  if (isIncognitoSessionKey(canonicalKey)) {
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
    // Session resolution may receive arbitrary stale keys; only creation/write
    // owners may materialize the process-lifetime incognito database.
    const store = loadGatewaySessionLookupStore(storePath, params.clone, agentId, {
      readOnly: true,
    });
    return {
      agentId,
      storePath,
      canonicalKey,
      storeKeys: [canonicalKey],
      store,
    };
  }
  const { storePath, store } = resolveGatewaySessionStoreLookup({
    cfg: params.cfg,
    key,
    canonicalKey,
    agentId,
    clone: params.clone,
    readOnly: params.readOnly,
    initialStore: params.store,
  });
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    const storeKeys = key && key !== canonicalKey ? [canonicalKey, key] : [key];
    return { agentId, storePath, canonicalKey, storeKeys, store };
  }

  const storeKeys = new Set<string>(
    buildGatewaySessionStoreScanTargets({ cfg: params.cfg, key, canonicalKey, agentId }),
  );
  return {
    agentId,
    storePath,
    canonicalKey,
    storeKeys: Array.from(storeKeys),
    store,
  };
}

export function resolveGatewaySessionStoreTarget(params: {
  cfg: OpenClawConfig;
  key: string;
  agentId?: string;
  clone?: boolean;
  store?: Record<string, SessionEntry>;
}): GatewaySessionStoreTarget {
  const { store: _store, ...target } = resolveGatewaySessionStoreTargetWithStore(params);
  return target;
}
