import {
  getRoleSnapshotIdentityKeys,
  type RoleRefMap,
  type RoleSnapshotIdentityMode,
} from "./pw-role-snapshot.js";
import type { BrowserRouteContext, BrowserServerState } from "./server-context.types.js";

/**
 * Process-local snapshot delta state owned by one browser control runtime.
 * Each tab/options family keeps one previous-key slot; restart or tab close drops it.
 */
const SNAPSHOT_DELTA_CACHE_MAX_ENTRIES = 32;

export type SnapshotDeltaFamily = {
  identity: RoleSnapshotIdentityMode;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  frame?: string;
  urls?: boolean;
  maxChars?: number;
};

type SnapshotDeltaEntry = {
  profile: string;
  targetId: string;
  documentIdentity: string;
  keys: Set<string>;
};

const cacheByState = new WeakMap<BrowserServerState, Map<string, SnapshotDeltaEntry>>();

function getCache(ctx: BrowserRouteContext): Map<string, SnapshotDeltaEntry> {
  const existing = cacheByState.get(ctx.state());
  if (existing) {
    return existing;
  }
  const cache = new Map<string, SnapshotDeltaEntry>();
  cacheByState.set(ctx.state(), cache);
  return cache;
}

function cacheKey(params: {
  profile: string;
  targetId: string;
  family: SnapshotDeltaFamily;
}): string {
  return JSON.stringify([params.profile, params.targetId, params.family]);
}

export function getPreviousSnapshotKeys(
  ctx: BrowserRouteContext,
  params: {
    profile: string;
    targetId: string;
    documentIdentity: string;
    family: SnapshotDeltaFamily;
  },
): ReadonlySet<string> | undefined {
  const cache = getCache(ctx);
  const key = cacheKey(params);
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  // Delta markers are same-document only. Navigation resets the baseline so a
  // replacement document is not reported as a tree full of newly appeared elements.
  if (entry.documentIdentity !== params.documentIdentity) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.keys;
}

export function recordSnapshotKeys(
  ctx: BrowserRouteContext,
  params: {
    profile: string;
    targetId: string;
    documentIdentity: string;
    family: SnapshotDeltaFamily;
    refs: RoleRefMap;
  },
): void {
  const cache = getCache(ctx);
  const key = cacheKey(params);
  cache.delete(key);
  cache.set(key, {
    profile: params.profile,
    targetId: params.targetId,
    documentIdentity: params.documentIdentity,
    keys: getRoleSnapshotIdentityKeys(params.refs, params.family.identity),
  });
  while (cache.size > SNAPSHOT_DELTA_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

export function clearSnapshotKeysForTab(
  ctx: BrowserRouteContext,
  profile: string,
  targetId: string,
): void {
  const cache = cacheByState.get(ctx.state());
  if (!cache) {
    return;
  }
  for (const [key, entry] of cache) {
    if (entry.profile === profile && entry.targetId === targetId) {
      cache.delete(key);
    }
  }
}
