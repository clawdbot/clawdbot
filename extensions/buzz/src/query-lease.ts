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

type Waiter = () => void;

type RelayQueryLeaseState = {
  /** Slots currently owned, including one handed to a waiter it has not resumed into yet. */
  active: number;
  waiting: Waiter[];
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

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Buzz relay query lease wait aborted");
}

/**
 * Suspend until a releasing holder hands this caller its slot. The slot is
 * transferred, not freed: `active` never dips while the hand-off is in flight,
 * so a no-wait caller cannot slip into the gap.
 */
function waitForSlot(state: RelayQueryLeaseState, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!signal) {
      state.waiting.push(resolve);
      return;
    }
    const onAbort = () => {
      const index = state.waiting.indexOf(waiter);
      if (index >= 0) {
        state.waiting.splice(index, 1);
      }
      reject(abortError(signal));
    };
    const waiter: Waiter = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    state.waiting.push(waiter);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Take one query slot on `relay`.
 *
 * Returns the release callback, or `null` when the allowance is spent and the
 * caller opted out of waiting. Callers in front of an agent turn pass
 * `wait: false` so a busy relay degrades their result instead of adding latency.
 * A waiting caller whose `signal` aborts is dropped from the queue and rejected
 * with the abort reason.
 */
export async function acquireBuzzQueryLease(
  relay: Relay,
  options?: { wait?: boolean; signal?: AbortSignal },
): Promise<(() => void) | null> {
  const state = stateFor(relay);
  options?.signal?.throwIfAborted();
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    const next = state.waiting.shift();
    if (next) {
      // Transfer the slot: `active` stays put and the waiter inherits it.
      next();
    } else {
      state.active -= 1;
    }
  };
  if (state.active >= BUZZ_MAX_CONCURRENT_RELAY_QUERIES) {
    if (options?.wait === false) {
      return null;
    }
    await waitForSlot(state, options?.signal);
  } else {
    state.active += 1;
  }
  if (options?.signal?.aborted) {
    // Woken and cancelled in the same turn: give the slot straight back.
    release();
    throw abortError(options.signal);
  }
  return release;
}
