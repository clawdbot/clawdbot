import type { Relay } from "nostr-tools";

/**
 * Transient relay queries share one small allowance per relay so their REQs can
 * never push a near-maximum room set past the relay's subscription ceiling.
 *
 * The room-subscription budget reserves exactly this many slots above the live
 * room and membership subscriptions, so every transient query - profile,
 * room-directory, membership, history paging, reply targets - has to pass
 * through here for that reserve to mean anything.
 */
export const BUZZ_MAX_CONCURRENT_RELAY_QUERIES = 3;

type RelayQueryLeaseState = {
  active: number;
  waiting: Array<() => void>;
};

const leaseStates = new WeakMap<Relay, RelayQueryLeaseState>();

function stateFor(relay: Relay): RelayQueryLeaseState {
  const existing = leaseStates.get(relay);
  if (existing) {
    return existing;
  }
  const created: RelayQueryLeaseState = { active: 0, waiting: [] };
  leaseStates.set(relay, created);
  return created;
}

/**
 * Take one query slot on `relay`.
 *
 * Returns the release callback, or `null` when the allowance is spent and the
 * caller opted out of waiting. Callers in front of an agent turn pass
 * `wait: false` so a busy relay degrades their result instead of adding latency.
 */
export async function acquireBuzzQueryLease(
  relay: Relay,
  options?: { wait?: boolean },
): Promise<(() => void) | null> {
  const state = stateFor(relay);
  if (state.active >= BUZZ_MAX_CONCURRENT_RELAY_QUERIES) {
    if (options?.wait === false) {
      return null;
    }
    await new Promise<void>((resolve) => {
      state.waiting.push(resolve);
    });
  }
  state.active += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    state.active -= 1;
    const next = state.waiting.shift();
    // The woken caller claims the slot this release just freed.
    next?.();
  };
}
