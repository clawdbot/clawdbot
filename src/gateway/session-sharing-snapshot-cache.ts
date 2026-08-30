import type { SessionVisibility } from "../../packages/gateway-protocol/src/index.js";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";

const SNAPSHOT_CACHE_LIMIT = 2_048;

export type SessionSharingSnapshot = {
  createdActor?: SessionCreatedActor;
  incognito: boolean;
  visibility: SessionVisibility;
};

const snapshotCache = new Map<string, SessionSharingSnapshot>();
const snapshotAliases = new Map<string, string>();
const snapshotKeysBySessionKey = new Map<string, Set<string>>();
const aliasKeysBySessionKey = new Map<string, Set<string>>();
const aliasKeysByCanonicalKey = new Map<string, Set<string>>();

function snapshotKey(sessionKey: string, agentId?: string): string {
  return `${agentId ?? ""}\0${sessionKey}`;
}

function logicalSessionKey(key: string): string {
  return key.slice(key.lastIndexOf("\0") + 1);
}

function addReverseIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key) ?? new Set<string>();
  values.add(value);
  index.set(key, values);
}

function removeReverseIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key);
  values?.delete(value);
  if (values?.size === 0) {
    index.delete(key);
  }
}

function removeSnapshotAlias(alias: string): void {
  const canonical = snapshotAliases.get(alias);
  if (!canonical) {
    return;
  }
  snapshotAliases.delete(alias);
  removeReverseIndex(aliasKeysBySessionKey, logicalSessionKey(alias), alias);
  removeReverseIndex(aliasKeysByCanonicalKey, canonical, alias);
}

function removeSnapshot(key: string): void {
  if (!snapshotCache.delete(key)) {
    return;
  }
  removeReverseIndex(snapshotKeysBySessionKey, logicalSessionKey(key), key);
  for (const alias of aliasKeysByCanonicalKey.get(key) ?? []) {
    removeSnapshotAlias(alias);
  }
}

function rememberSnapshot(key: string, snapshot: SessionSharingSnapshot): void {
  const known = snapshotCache.delete(key);
  snapshotCache.set(key, snapshot);
  if (!known) {
    addReverseIndex(snapshotKeysBySessionKey, logicalSessionKey(key), key);
  }
  if (snapshotCache.size <= SNAPSHOT_CACHE_LIMIT) {
    return;
  }
  const oldest = snapshotCache.keys().next().value;
  if (oldest) {
    removeSnapshot(oldest);
  }
}

function rememberSnapshotAlias(alias: string, canonical: string): void {
  removeSnapshotAlias(alias);
  snapshotAliases.set(alias, canonical);
  addReverseIndex(aliasKeysBySessionKey, logicalSessionKey(alias), alias);
  addReverseIndex(aliasKeysByCanonicalKey, canonical, alias);
  if (snapshotAliases.size <= SNAPSHOT_CACHE_LIMIT * 2) {
    return;
  }
  const oldest = snapshotAliases.keys().next().value;
  if (oldest) {
    removeSnapshotAlias(oldest);
  }
}

export function invalidateSessionSharingSnapshot(sessionKey?: string): void {
  if (sessionKey) {
    // Mutation events carry the logical key without an agent id. These reverse indexes
    // preserve that cross-agent invalidation contract while keeping work proportional to
    // aliases/canonical entries for the affected session instead of the whole bounded cache.
    const matchingCanonicalKeys = new Set(snapshotKeysBySessionKey.get(sessionKey));
    for (const alias of aliasKeysBySessionKey.get(sessionKey) ?? []) {
      const canonical = snapshotAliases.get(alias);
      if (canonical) {
        matchingCanonicalKeys.add(canonical);
      }
    }
    for (const key of matchingCanonicalKeys) {
      removeSnapshot(key);
    }
    return;
  }
  snapshotCache.clear();
  snapshotAliases.clear();
  snapshotKeysBySessionKey.clear();
  aliasKeysBySessionKey.clear();
  aliasKeysByCanonicalKey.clear();
}

export function loadCachedSessionSharingSnapshot(params: {
  agentId?: string;
  resolve: () => {
    canonicalAgentId?: string;
    canonicalKey: string;
    snapshot: SessionSharingSnapshot;
  };
  sessionKey: string;
}): SessionSharingSnapshot {
  const requestedKey = snapshotKey(params.sessionKey, params.agentId);
  const aliasedKey = snapshotAliases.get(requestedKey);
  const cached = snapshotCache.get(aliasedKey ?? requestedKey);
  if (cached) {
    return cached;
  }
  const resolved = params.resolve();
  const canonicalKey = snapshotKey(resolved.canonicalKey, resolved.canonicalAgentId);
  const canonicalCached = snapshotCache.get(canonicalKey);
  if (canonicalCached) {
    rememberSnapshotAlias(requestedKey, canonicalKey);
    return canonicalCached;
  }
  rememberSnapshot(canonicalKey, resolved.snapshot);
  rememberSnapshotAlias(requestedKey, canonicalKey);
  return resolved.snapshot;
}
