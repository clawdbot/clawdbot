import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds } from "../agents/agent-scope.js";
import {
  isConfiguredSessionStoreAgentId,
  resolveAgentMainSessionKey,
  resolveExistingAgentSessionStoreTargetsSync,
  resolveSessionStorePathCore,
  type SessionEntry,
  type SessionStoreTarget,
} from "../config/sessions.js";
import {
  listSessionChildEntriesReadOnly,
  listSessionEntriesCore as listAccessorSessionEntries,
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
  loadExactSessionEntryReadOnly,
  type SessionEntryListScope,
} from "../config/sessions/session-accessor.js";
import { canonicalSessionKeyMigrationRequiredError } from "../config/sessions/session-canonical-key.js";
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

function findCanonicalStoreMatch(
  store: Record<string, SessionEntry>,
  candidates: readonly string[],
  onCanonicalError?: (error: Error) => void,
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
  const canonicalKey = candidates[0] ?? "";
  const selected = matches.get(canonicalKey) ?? matches.values().next().value;
  if (matches.size > 1) {
    const error = canonicalSessionKeyMigrationRequiredError(
      `duplicate rows resolve to canonical session key ${canonicalKey || selected?.key || ""}`,
    );
    if (!onCanonicalError) {
      throw error;
    }
    onCanonicalError(error);
  }
  if (selected && selected.key !== canonicalKey) {
    const error = canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${canonicalKey || selected.key}`,
    );
    if (!onCanonicalError) {
      throw error;
    }
    onCanonicalError(error);
  }
  return selected;
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

type GatewaySessionStoreDiscovery = {
  existing: SessionStoreTarget[];
  fallback: SessionStoreTarget;
  prepared?: true;
};

function resolveGatewaySessionStoreCandidates(
  cfg: OpenClawConfig,
  agentId: string,
  cache?: GatewaySessionStoreDiscoveryCache,
): GatewaySessionStoreDiscovery {
  const cached = cache?.get(agentId);
  if (cached) {
    return cached;
  }
  const storeConfig = cfg.session?.store;
  const fallback = {
    agentId,
    storePath: resolveSessionStorePathCore(storeConfig, { agentId }),
  };
  const discovery = {
    existing: resolveExistingAgentSessionStoreTargetsSync(cfg, agentId),
    fallback,
  };
  cache?.set(agentId, discovery);
  return discovery;
}

/**
 * Request-scoped store reuse.
 *
 * Sharing resolution runs once per listed row, and each run materialized every
 * entry of a candidate store, making `sessions.list` quadratic in entries. A
 * caller that resolves many keys against the same stores passes one cache so
 * each store is materialized once. Entries are shared across rows within that
 * request, so cached stores are read-only to their holder; the cache is never
 * process-global, so it cannot serve a later request stale rows.
 */
export type GatewaySessionStoreCache = Map<string, Record<string, SessionEntry>>;

/**
 * Sharing resolves every returned row, but store targets are stable within one request.
 * Keep discovery agent-scoped here or each row repeats registry probes and agent-root scans.
 */
export type GatewaySessionStoreDiscoveryCache = Map<string, GatewaySessionStoreDiscovery>;

export function createGatewaySessionStoreDiscoveryCache(params: {
  cfg: OpenClawConfig;
  targets: readonly SessionStoreTarget[];
  agentIds: Iterable<string>;
}): GatewaySessionStoreDiscoveryCache {
  const cache: GatewaySessionStoreDiscoveryCache = new Map();
  const prepare = (rawAgentId: string, target?: SessionStoreTarget) => {
    const agentId = normalizeAgentId(rawAgentId);
    const current = cache.get(agentId);
    if (current) {
      if (target) {
        current.existing.push(target);
      }
      return;
    }
    const fallback = {
      agentId,
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
    };
    const existing = target
      ? [target]
      : params.targets.length > 0
        ? [...params.targets]
        : [fallback];
    cache.set(agentId, { existing, fallback, prepared: true });
  };
  for (const target of params.targets) {
    prepare(target.agentId, target);
  }
  for (const agentId of params.agentIds) {
    prepare(agentId);
  }
  return cache;
}

function loadGatewaySessionLookupStore(
  storePath: string,
  clone: boolean | undefined,
  agentId?: string,
  options: {
    readOnly?: boolean;
    cache?: GatewaySessionStoreCache;
    exactKeys?: readonly string[];
    projection?: SessionEntryListScope["projection"];
  } = {},
): Record<string, SessionEntry> {
  const cache = options.cache;
  const cacheKey = cache
    ? `${storePath}\u0000${agentId ?? ""}\u0000${clone === false ? "0" : "1"}\u0000${options.readOnly ? "1" : "0"}\u0000${options.projection ?? "full"}\u0000${options.exactKeys?.join("\u0001") ?? ""}`
    : "";
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const loaded = loadGatewaySessionLookupStoreUncached(storePath, clone, agentId, options);
  cache?.set(cacheKey, loaded);
  return loaded;
}

function loadGatewaySessionLookupStoreUncached(
  storePath: string,
  clone: boolean | undefined,
  agentId?: string,
  options: {
    exactKeys?: readonly string[];
    readOnly?: boolean;
    projection?: SessionEntryListScope["projection"];
  } = {},
): Record<string, SessionEntry> {
  try {
    if (options.exactKeys) {
      const store: Record<string, SessionEntry> = {};
      for (const sessionKey of options.exactKeys) {
        const match = loadExactSessionEntryReadOnly({
          ...(agentId ? { agentId } : {}),
          clone: false,
          sessionKey,
          storePath,
        });
        if (match) {
          store[match.sessionKey] = match.entry;
        }
      }
      return store;
    }
    const listEntries = options.readOnly
      ? listAccessorSessionEntriesReadOnly
      : listAccessorSessionEntries;
    return Object.fromEntries(
      listEntries({
        ...(agentId ? { agentId } : {}),
        ...(clone === false ? { clone: false } : {}),
        ...(options.projection ? { projection: options.projection } : {}),
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
  projection?: SessionEntryListScope["projection"];
  readOnly?: boolean;
  exactRead?: boolean;
  deferCanonicalValidation?: boolean;
  storeCache?: GatewaySessionStoreCache;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
}): {
  storePath: string;
  store: Record<string, SessionEntry>;
  match: { entry: SessionEntry; key: string } | undefined;
  canonicalValidationError?: Error;
} {
  const scanTargets = buildGatewaySessionStoreScanTargets(params);
  const discovery = resolveGatewaySessionStoreCandidates(
    params.cfg,
    params.agentId,
    params.targetDiscoveryCache,
  );
  const { existing, fallback } = discovery;
  const configured = isConfiguredSessionStoreAgentId(params.cfg, params.agentId);
  const candidates = discovery.prepared
    ? existing
    : configured
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
      ...(params.exactRead ? { exactKeys: scanTargets } : {}),
      ...(params.projection ? { projection: params.projection } : {}),
      ...(params.storeCache ? { cache: params.storeCache } : {}),
    });
  const firstCandidate = candidates[0] ?? fallback;
  let selectedStorePath = firstCandidate.storePath;
  let selectedStore =
    params.initialStore && firstCandidate.storePath === fallback.storePath
      ? params.initialStore
      : loadStore(firstCandidate);
  let canonicalValidationError: Error | undefined;
  const recordCanonicalError = params.deferCanonicalValidation
    ? (error: Error) => {
        canonicalValidationError ??= error;
      }
    : undefined;
  let selectedMatch = findCanonicalStoreMatch(selectedStore, scanTargets, recordCanonicalError);

  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const store = loadStore(candidate);
    const match = findCanonicalStoreMatch(store, scanTargets, recordCanonicalError);
    if (!match) {
      continue;
    }
    if (selectedMatch) {
      const error = canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${params.canonicalKey}`,
      );
      if (!recordCanonicalError) {
        throw error;
      }
      recordCanonicalError(error);
      if (match.key !== params.canonicalKey || selectedMatch.key === params.canonicalKey) {
        continue;
      }
    }
    selectedStorePath = candidate.storePath;
    selectedStore = store;
    selectedMatch = match;
  }

  return {
    storePath: selectedStorePath,
    store: selectedStore,
    match: selectedMatch,
    ...(canonicalValidationError ? { canonicalValidationError } : {}),
  };
}

function isAgentScopedSentinelSessionKey(canonicalKey: string): boolean {
  return canonicalKey === "global" || canonicalKey === "unknown";
}

function resolveExplicitDeletedLegacyMainStoreTarget(params: {
  cfg: OpenClawConfig;
  key: string;
  clone?: boolean;
  deferCanonicalValidation?: boolean;
  projection?: SessionEntryListScope["projection"];
  readOnly?: boolean;
  exactRead?: boolean;
  storeCache?: GatewaySessionStoreCache;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
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
  const { existing } = resolveGatewaySessionStoreCandidates(
    params.cfg,
    legacyAgentId,
    params.targetDiscoveryCache,
  );
  let canonicalValidationError: Error | undefined;
  const recordCanonicalError = params.deferCanonicalValidation
    ? (error: Error) => {
        canonicalValidationError ??= error;
      }
    : undefined;
  for (const target of existing) {
    if (target.agentId !== legacyAgentId) {
      continue;
    }
    const store = loadGatewaySessionLookupStore(target.storePath, params.clone, target.agentId, {
      readOnly: true,
      ...(params.exactRead ? { exactKeys: lookupSeeds } : {}),
      ...(params.projection ? { projection: params.projection } : {}),
      ...(params.storeCache ? { cache: params.storeCache } : {}),
    });
    const match = findCanonicalStoreMatch(store, lookupSeeds, recordCanonicalError);
    if (!match) {
      continue;
    }
    if (best) {
      const error = canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${canonicalKey}`,
      );
      if (!recordCanonicalError) {
        throw error;
      }
      recordCanonicalError(error);
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
    ...(canonicalValidationError ? { canonicalValidationError } : {}),
  };
}

export function resolveGatewaySessionStoreTargetWithStore(params: {
  cfg: OpenClawConfig;
  key: string;
  agentId?: string;
  clone?: boolean;
  projection?: SessionEntryListScope["projection"];
  readOnly?: boolean;
  exactRead?: boolean;
  deferCanonicalValidation?: boolean;
  includeStoreChildEntries?: boolean;
  store?: Record<string, SessionEntry>;
  storeCache?: GatewaySessionStoreCache;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
}): GatewaySessionStoreTargetWithStore {
  const key = normalizeOptionalString(params.key) ?? "";
  const explicitDeletedMainTarget = resolveExplicitDeletedLegacyMainStoreTarget({
    cfg: params.cfg,
    key,
    clone: params.clone,
    ...(params.deferCanonicalValidation ? { deferCanonicalValidation: true } : {}),
    readOnly: params.readOnly,
    exactRead: params.exactRead,
    ...(params.projection ? { projection: params.projection } : {}),
    ...(params.storeCache ? { storeCache: params.storeCache } : {}),
    ...(params.targetDiscoveryCache ? { targetDiscoveryCache: params.targetDiscoveryCache } : {}),
  });
  if (explicitDeletedMainTarget) {
    return includeDirectChildEntries(explicitDeletedMainTarget, params.includeStoreChildEntries);
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
      ...(params.exactRead ? { exactKeys: [canonicalKey] } : {}),
      ...(params.projection ? { projection: params.projection } : {}),
      ...(params.storeCache ? { cache: params.storeCache } : {}),
    });
    return includeDirectChildEntries(
      {
        agentId,
        storePath,
        canonicalKey,
        storeKeys: [canonicalKey],
        store,
      },
      params.includeStoreChildEntries,
    );
  }
  const { canonicalValidationError, storePath, store } = resolveGatewaySessionStoreLookup({
    cfg: params.cfg,
    key,
    canonicalKey,
    agentId,
    clone: params.clone,
    readOnly: params.readOnly,
    exactRead: params.exactRead,
    deferCanonicalValidation: params.deferCanonicalValidation,
    initialStore: params.store,
    ...(params.projection ? { projection: params.projection } : {}),
    ...(params.storeCache ? { storeCache: params.storeCache } : {}),
    ...(params.targetDiscoveryCache ? { targetDiscoveryCache: params.targetDiscoveryCache } : {}),
  });
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    const storeKeys = key && key !== canonicalKey ? [canonicalKey, key] : [key];
    return includeDirectChildEntries(
      {
        agentId,
        storePath,
        canonicalKey,
        storeKeys,
        store,
        ...(canonicalValidationError ? { canonicalValidationError } : {}),
      },
      params.includeStoreChildEntries,
    );
  }

  const storeKeys = new Set<string>(
    buildGatewaySessionStoreScanTargets({ cfg: params.cfg, key, canonicalKey, agentId }),
  );
  return includeDirectChildEntries(
    {
      agentId,
      storePath,
      canonicalKey,
      storeKeys: Array.from(storeKeys),
      store,
      ...(canonicalValidationError ? { canonicalValidationError } : {}),
    },
    params.includeStoreChildEntries,
  );
}

function includeDirectChildEntries(
  target: GatewaySessionStoreTargetWithStore,
  include: boolean | undefined,
): GatewaySessionStoreTargetWithStore {
  if (!include) {
    return target;
  }
  try {
    const parentKeys = new Set([target.canonicalKey, ...target.storeKeys]);
    for (const parentKey of parentKeys) {
      for (const { sessionKey, entry } of listSessionChildEntriesReadOnly({
        agentId: target.agentId,
        clone: false,
        sessionKey: parentKey,
        storePath: target.storePath,
      })) {
        target.store[sessionKey] = entry;
      }
    }
  } catch {
    // Match the existing read-only lookup contract: unavailable stores degrade to no rows.
  }
  return target;
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
