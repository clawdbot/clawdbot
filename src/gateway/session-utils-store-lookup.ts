import { expectDefined } from "@openclaw/normalization-core";
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
import {
  loadGatewaySessionStoreReads,
  readGatewaySessionStore,
  type GatewaySessionStoreRead,
  type GatewaySessionStoreCache,
} from "./session-utils-store-read.js";
export type { GatewaySessionStoreCache } from "./session-utils-store-read.js";

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

type GatewaySessionStoreLookupParams = {
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
};

type GatewaySessionStorePlan<T> = {
  reads: GatewaySessionStoreRead[];
  resolve: () => T;
};

type GatewaySessionStoreLookup = {
  storePath: string;
  store: Record<string, SessionEntry>;
  match: { entry: SessionEntry; key: string } | undefined;
  canonicalValidationError?: Error;
};

function prepareGatewaySessionStoreLookup(
  params: GatewaySessionStoreLookupParams & { canonicalKey: string; agentId: string },
): GatewaySessionStorePlan<GatewaySessionStoreLookup> {
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
    // Retired/manual agents require an existing discovered store; lookup never creates one.
    return {
      reads: [],
      resolve: () => ({ storePath: fallback.storePath, store: {}, match: undefined }),
    };
  }
  const reads = candidates.map((target, index): GatewaySessionStoreRead => ({
    storePath: target.storePath,
    agentId: target.agentId,
    clone: params.clone,
    options: {
      readOnly: configured ? params.readOnly : true,
      ...(params.exactRead ? { exactKeys: scanTargets } : {}),
      ...(params.projection ? { projection: params.projection } : {}),
      ...(params.storeCache ? { cache: params.storeCache } : {}),
    },
    store: index === 0 && target.storePath === fallback.storePath ? params.store : undefined,
  }));
  return {
    reads,
    resolve: () => {
      const first = expectDefined(reads[0], "first configured or discovered session store");
      let selectedStorePath = first.storePath;
      let selectedStore = readGatewaySessionStore(first);
      let canonicalValidationError: Error | undefined;
      const recordCanonicalError = params.deferCanonicalValidation
        ? (error: Error) => {
            canonicalValidationError ??= error;
          }
        : undefined;
      let selectedMatch = findCanonicalStoreMatch(selectedStore, scanTargets, recordCanonicalError);
      for (const candidate of reads.slice(1)) {
        const store = readGatewaySessionStore(candidate);
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
    },
  };
}

function isAgentScopedSentinelSessionKey(canonicalKey: string): boolean {
  return canonicalKey === "global" || canonicalKey === "unknown";
}

function prepareExplicitDeletedLegacyMainStoreTarget(
  params: GatewaySessionStoreLookupParams,
): GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore | null> | null {
  const parsed = parseAgentSessionKey(params.key);
  const legacyAgentId = normalizeAgentId(parsed?.agentId);
  if (
    !parsed ||
    isIncognitoSessionKey(params.key) ||
    legacyAgentId !== DEFAULT_AGENT_ID ||
    listAgentIds(params.cfg).includes(legacyAgentId)
  ) {
    return null;
  }
  // Deleted-main discovery precedes normal aliases; only a real matching row keeps this owner.
  const canonicalKey = resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId: legacyAgentId,
    sessionKey: params.key,
  });
  const agentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: legacyAgentId });
  const lookupSeeds = Array.from(
    new Set([params.key, canonicalKey, agentMainKey, `agent:${legacyAgentId}:main`]),
  );
  const { existing } = resolveGatewaySessionStoreCandidates(
    params.cfg,
    legacyAgentId,
    params.targetDiscoveryCache,
  );
  const reads = existing
    .filter((target) => target.agentId === legacyAgentId)
    .map((target): GatewaySessionStoreRead => ({
      storePath: target.storePath,
      clone: params.clone,
      agentId: target.agentId,
      options: {
        readOnly: true,
        ...(params.exactRead ? { exactKeys: lookupSeeds } : {}),
        ...(params.projection ? { projection: params.projection } : {}),
        ...(params.storeCache ? { cache: params.storeCache } : {}),
      },
    }));
  return {
    reads,
    resolve: () => {
      let best:
        | {
            storePath: string;
            store: Record<string, SessionEntry>;
            match: { entry: SessionEntry; key: string };
          }
        | undefined;
      let canonicalValidationError: Error | undefined;
      const recordCanonicalError = params.deferCanonicalValidation
        ? (error: Error) => {
            canonicalValidationError ??= error;
          }
        : undefined;
      for (const target of reads) {
        const store = readGatewaySessionStore(target);
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
    },
  };
}

function prepareGatewaySessionStoreTarget(
  params: GatewaySessionStoreLookupParams,
): GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore> {
  const key = params.key;
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
    const read: GatewaySessionStoreRead = {
      storePath,
      agentId,
      clone: params.clone,
      options: {
        // Arbitrary stale keys must not materialize process-lifetime incognito state.
        readOnly: true,
        ...(params.exactRead ? { exactKeys: [canonicalKey] } : {}),
        ...(params.projection ? { projection: params.projection } : {}),
        ...(params.storeCache ? { cache: params.storeCache } : {}),
      },
    };
    return {
      reads: [read],
      resolve: () => ({
        agentId,
        storePath,
        canonicalKey,
        storeKeys: [canonicalKey],
        store: readGatewaySessionStore(read),
      }),
    };
  }
  const lookup = prepareGatewaySessionStoreLookup({ ...params, canonicalKey, agentId });
  return {
    reads: lookup.reads,
    resolve: () => {
      const { canonicalValidationError, storePath, store } = lookup.resolve();
      const storeKeys = isAgentScopedSentinelSessionKey(canonicalKey)
        ? key && key !== canonicalKey
          ? [canonicalKey, key]
          : [key]
        : Array.from(
            new Set(
              buildGatewaySessionStoreScanTargets({ cfg: params.cfg, key, canonicalKey, agentId }),
            ),
          );
      return {
        agentId,
        storePath,
        canonicalKey,
        storeKeys,
        store,
        ...(canonicalValidationError ? { canonicalValidationError } : {}),
      };
    },
  };
}

export function resolveGatewaySessionStoreTargetWithStore(
  params: GatewaySessionStoreLookupParams,
): GatewaySessionStoreTargetWithStore {
  const normalized = { ...params, key: normalizeOptionalString(params.key) ?? "" };
  const deletedMain = prepareExplicitDeletedLegacyMainStoreTarget(normalized)?.resolve();
  return includeDirectChildEntries(
    deletedMain ?? prepareGatewaySessionStoreTarget(normalized).resolve(),
    params.includeStoreChildEntries,
    params.projection,
  );
}

/** Resolve one synchronous set of logical metadata targets using exact grouped reads. */
export function resolveGatewaySessionStoreTargetsReadOnly(params: {
  cfg: OpenClawConfig;
  targets: readonly { key: string; agentId?: string }[];
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
}): GatewaySessionStoreTargetWithStore[] {
  const targetDiscoveryCache = params.targetDiscoveryCache ?? new Map();
  const requests = params.targets.map((target) => {
    const lookup: GatewaySessionStoreLookupParams = {
      ...target,
      key: normalizeOptionalString(target.key) ?? "",
      cfg: params.cfg,
      clone: false,
      readOnly: true,
      exactRead: true,
      projection: "list",
      targetDiscoveryCache,
    };
    return { lookup, legacy: prepareExplicitDeletedLegacyMainStoreTarget(lookup) };
  });
  loadGatewaySessionStoreReads(requests.flatMap((request) => request.legacy?.reads ?? []));
  // A successful deleted-main lookup must not open or validate a normal fallback store.
  const selected = requests.map((request) => {
    const target = request.legacy?.resolve();
    return target ? { target } : { plan: prepareGatewaySessionStoreTarget(request.lookup) };
  });
  loadGatewaySessionStoreReads(selected.flatMap((selection) => selection.plan?.reads ?? []));
  return selected.map(
    (selection) =>
      selection.target ??
      expectDefined(selection.plan, "unresolved logical session plan").resolve(),
  );
}

function includeDirectChildEntries(
  target: GatewaySessionStoreTargetWithStore,
  include: boolean | undefined,
  projection: SessionEntryListScope["projection"],
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
        projection,
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
  // Only keys and store metadata escape; omit large prompt snapshots without changing read mode.
  const { store: _store, ...target } = resolveGatewaySessionStoreTargetWithStore({
    ...params,
    projection: "list",
  });
  return target;
}
