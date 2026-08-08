// Voice Call manager helpers own bounded webhook replay identity.

/** Match the existing voice-call webhook replay-cache cardinality. */
const MAX_MANAGER_REPLAY_KEYS = 10_000;
/** Keep typical provider replay IDs near one raw persisted-record chunk. */
export const MAX_CALL_REPLAY_KEYS = 500;

function pruneOldestSetEntries(keys: Set<string>, maxEntries: number): void {
  while (keys.size > maxEntries) {
    const oldest = keys.values().next().value;
    if (oldest === undefined) {
      break;
    }
    keys.delete(oldest);
  }
}

function pruneOldestMapEntries(keys: Map<string, symbol>, maxEntries: number): void {
  while (keys.size > maxEntries) {
    const oldest = keys.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    keys.delete(oldest);
  }
}

/** Remember one manager replay key without refreshing duplicate insertion order. */
export function rememberManagerReplayKey(
  keys: Set<string>,
  key: string,
  maxEntries = MAX_MANAGER_REPLAY_KEYS,
): void {
  keys.add(key);
  pruneOldestSetEntries(keys, maxEntries);
}

/** Append one per-call replay key and retain only the newest bounded suffix. */
export function appendCallReplayKey(
  keys: string[],
  key: string,
  maxEntries = MAX_CALL_REPLAY_KEYS,
): void {
  keys.push(key);
  trimCallReplayKeys(keys, maxEntries);
}

/** Normalize restored or externally constructed call replay history in place. */
export function trimCallReplayKeys(keys: string[], maxEntries = MAX_CALL_REPLAY_KEYS): void {
  const overflow = keys.length - maxEntries;
  if (overflow > 0) {
    keys.splice(0, overflow);
  }
}

/**
 * Reserve one rejected provider call. The token prevents a stale failed
 * hangup from deleting a newer reservation after bounded eviction and reuse.
 */
export function reserveRejectedProviderCall(
  calls: Map<string, symbol>,
  providerCallId: string,
  maxEntries = MAX_MANAGER_REPLAY_KEYS,
): symbol | undefined {
  if (calls.has(providerCallId)) {
    return undefined;
  }
  const reservation = Symbol(providerCallId);
  calls.set(providerCallId, reservation);
  pruneOldestMapEntries(calls, maxEntries);
  return reservation;
}

/** Release a rejected-call reservation only when the failing attempt still owns it. */
export function releaseRejectedProviderCall(
  calls: Map<string, symbol>,
  providerCallId: string,
  reservation: symbol,
): void {
  if (calls.get(providerCallId) === reservation) {
    calls.delete(providerCallId);
  }
}
