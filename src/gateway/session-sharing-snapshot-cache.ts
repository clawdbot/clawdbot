import type { SessionVisibility } from "../../packages/gateway-protocol/src/index.js";

const SNAPSHOT_CACHE_LIMIT = 2_048;

export type SessionSharingSnapshot = {
  creatorId?: string;
  incognito: boolean;
  visibility: SessionVisibility;
};

const snapshotCache = new Map<string, SessionSharingSnapshot>();
const snapshotAliases = new Map<string, string>();

function snapshotKey(sessionKey: string, agentId?: string): string {
  return `${agentId ?? ""}\0${sessionKey}`;
}

function rememberSnapshot(key: string, snapshot: SessionSharingSnapshot): void {
  snapshotCache.delete(key);
  snapshotCache.set(key, snapshot);
  if (snapshotCache.size <= SNAPSHOT_CACHE_LIMIT) {
    return;
  }
  const oldest = snapshotCache.keys().next().value;
  if (oldest) {
    snapshotCache.delete(oldest);
    for (const [alias, canonical] of snapshotAliases) {
      if (canonical === oldest) {
        snapshotAliases.delete(alias);
      }
    }
  }
}

function rememberSnapshotAlias(alias: string, canonical: string): void {
  snapshotAliases.delete(alias);
  snapshotAliases.set(alias, canonical);
  if (snapshotAliases.size <= SNAPSHOT_CACHE_LIMIT * 2) {
    return;
  }
  const oldest = snapshotAliases.keys().next().value;
  if (oldest) {
    snapshotAliases.delete(oldest);
  }
}

export function invalidateSessionSharingSnapshot(sessionKey?: string): void {
  if (sessionKey) {
    const matchingCanonicalKeys = new Set<string>();
    for (const key of snapshotCache.keys()) {
      if (key.endsWith(`\0${sessionKey}`)) {
        matchingCanonicalKeys.add(key);
      }
    }
    for (const [alias, canonical] of snapshotAliases) {
      if (alias.endsWith(`\0${sessionKey}`) || canonical.endsWith(`\0${sessionKey}`)) {
        matchingCanonicalKeys.add(canonical);
      }
    }
    for (const key of matchingCanonicalKeys) {
      snapshotCache.delete(key);
    }
    for (const [alias, canonical] of snapshotAliases) {
      if (matchingCanonicalKeys.has(canonical)) {
        snapshotAliases.delete(alias);
      }
    }
    return;
  }
  snapshotCache.clear();
  snapshotAliases.clear();
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
