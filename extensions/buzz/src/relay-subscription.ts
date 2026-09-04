import type { Event, Filter, Relay } from "nostr-tools";
import { acquireBuzzQueryLease } from "./query-lease.js";

type BuzzRelaySubscriptionParams = Omit<Parameters<Relay["prepareSubscription"]>[1], "abort">;

type BuzzRelaySnapshotParams<TResult> = {
  relay: Relay;
  filters: Filter[];
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage: string;
  abortMessage: string;
  failureMessage: string;
  closeReason: string;
  closeMessage: (reason: string) => string;
  onEvent: (event: Event) => void;
  result: () => TResult;
  onTimeout?: (error: Error) => void;
  closeRelayOnTimeout?: boolean;
  /**
   * On timeout, close this subscription instead of recycling the whole relay.
   * For per-turn lookups that must not tear down the connection every room
   * shares. The close still waits for the REQ frame to leave the client, so it
   * cannot overtake an asynchronously registered REQ.
   */
  closeSubscriptionOnTimeout?: boolean;
  /**
   * Whether to wait for a query slot when the relay's transient-query allowance
   * is spent. Callers in front of an agent turn pass `false` and get
   * `BuzzQueryLeaseUnavailableError` rather than added latency.
   */
  leaseWait?: boolean;
  checkAbortAfterSubscribe?: boolean;
};

/** Thrown when a no-wait caller finds the relay's query allowance spent. */
export class BuzzQueryLeaseUnavailableError extends Error {
  constructor() {
    super("Buzz relay query capacity is fully in use");
    this.name = "BuzzQueryLeaseUnavailableError";
  }
}

export type BuzzRelaySubscriptionHandle = ReturnType<Relay["prepareSubscription"]> & {
  /**
   * Settles once the REQ frame has left the client. `closeOnce()` must not run
   * before this, or the CLOSE can overtake an asynchronously registered REQ and
   * leave the subscription orphaned server-side.
   */
  requestSent: Promise<void>;
  /**
   * This subscription's only closer. nostr-tools guards just the CLOSE frame
   * behind `closed`; every `close()` call still drops the id from `openSubs`,
   * decrements `relay.ongoingOperations` and fires `onclose`. A second call
   * therefore reports less work in flight than the relay really has, and
   * `scheduleIdleClose()` can then tear down a connection other rooms are
   * still using. Timeout cleanup and send failure both close through here.
   */
  closeOnce: (reason: string) => void;
};

export function openBuzzRelaySubscription(
  relay: Relay,
  filters: Filter[],
  params: BuzzRelaySubscriptionParams,
  requestFilters: Filter[] = filters,
): BuzzRelaySubscriptionHandle {
  // Relay.subscribe() synthesizes EOSE after 4.4 seconds. Buzz needs the relay's
  // real EOSE before replacing or closing subscriptions, otherwise an async REQ
  // can register after CLOSE and remain orphaned on the server.
  relay.idleSince = undefined;
  relay.ongoingOperations += 1;

  let subscription: ReturnType<Relay["prepareSubscription"]>;
  try {
    subscription = relay.prepareSubscription(filters, params);
  } catch (error) {
    relay.ongoingOperations -= 1;
    if (relay.ongoingOperations === 0) {
      relay.idleSince = Date.now();
      relay.scheduleIdleClose();
    }
    throw error;
  }

  // Buzz can route on stored channel metadata absent from signed event tags.
  // Gateway owns reconnects; nostr-tools automatic refires must stay disabled
  // so fresh sessions keep these wire filters separate from client validation.
  const frame = JSON.stringify(["REQ", subscription.id, ...requestFilters]);
  let closeRequested = false;
  const closeOnce = (reason: string) => {
    if (closeRequested || subscription.closed) {
      return;
    }
    closeRequested = true;
    subscription.close(reason);
  };
  const requestSent = relay.send(frame).catch((error: unknown) => {
    // A socket drop closes its subscriptions after disconnecting, so it clears
    // openSubs and decrements the counter without ever setting `closed`. A
    // missing entry is the only evidence that path already ran.
    if (relay.openSubs.get(subscription.id) !== subscription) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    closeOnce(`Buzz relay subscription request failed: ${message}`);
  });
  // SAFETY: Object.assign returns that same subscription with the handle members added.
  return Object.assign(subscription, { requestSent, closeOnce }) as BuzzRelaySubscriptionHandle;
}

export async function queryBuzzRelaySnapshot<TResult>(
  params: BuzzRelaySnapshotParams<TResult>,
): Promise<TResult> {
  // One allowance for every transient query on this relay, so the room budget's
  // reserve holds no matter which query types overlap.
  let releaseLease: (() => void) | null;
  try {
    releaseLease = await acquireBuzzQueryLease(params.relay, {
      wait: params.leaseWait,
      signal: params.signal,
    });
  } catch (error) {
    // Cancelled while queued for a slot: surface the same abort the snapshot
    // itself would have raised, and never touch the relay.
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new Error(params.abortMessage);
    }
    throw error;
  }
  if (!releaseLease) {
    throw new BuzzQueryLeaseUnavailableError();
  }
  const cleanup: PendingSnapshotCleanup = {};
  try {
    return await runBuzzRelaySnapshot(params, cleanup);
  } finally {
    // A timed-out lookup closes its subscription only once its REQ frame has
    // landed, so the slot stays taken until then. Releasing at rejection would
    // admit a replacement query while the old subscription is still open and
    // put the relay over the reserve this lease exists to protect.
    if (cleanup.pending) {
      void cleanup.pending.then(releaseLease, releaseLease);
    } else {
      releaseLease();
    }
  }
}

/** Carries deferred subscription cleanup back to the lease holder. */
type PendingSnapshotCleanup = { pending?: Promise<void> };

async function runBuzzRelaySnapshot<TResult>(
  params: BuzzRelaySnapshotParams<TResult>,
  cleanup: PendingSnapshotCleanup,
): Promise<TResult> {
  return await new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let receivedEose = false;
    let subscription: BuzzRelaySubscriptionHandle | undefined;
    const timeout = setTimeout(() => {
      const error = new Error(params.timeoutMessage);
      if (params.closeSubscriptionOnTimeout) {
        // Never CLOSE ahead of the REQ this subscription still owes the relay.
        // Recorded before rejecting so the lease holder sees it and waits.
        cleanup.pending = (subscription?.requestSent ?? Promise.resolve()).then(
          closeSubscription,
          closeSubscription,
        );
      }
      finish(error);
      params.onTimeout?.(error);
      if (params.closeRelayOnTimeout !== false) {
        params.relay.close();
      }
    }, params.timeoutMs ?? 10_000);
    // The handle owns closing. A send rejection arriving after the timeout runs
    // its own cleanup, and a second close() here would unbalance the relay's
    // operation count.
    const closeSubscription = () => {
      subscription?.closeOnce(params.closeReason);
    };
    const closeAfterRealEose = () => {
      if (receivedEose) {
        closeSubscription();
      }
    };
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      closeAfterRealEose();
      if (error === undefined) {
        resolve(params.result());
      } else {
        reject(error instanceof Error ? error : new Error(params.failureMessage, { cause: error }));
      }
    };
    const onAbort = () => finish(params.signal?.reason ?? new Error(params.abortMessage));
    params.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      subscription = openBuzzRelaySubscription(params.relay, params.filters, {
        onevent: params.onEvent,
        oneose: () => {
          receivedEose = true;
          if (settled) {
            closeAfterRealEose();
          } else {
            finish();
          }
        },
        onclose: (reason) => {
          if (reason !== params.closeReason) {
            finish(new Error(params.closeMessage(reason)));
          }
        },
      });
    } catch (error) {
      finish(error);
      return;
    }
    closeAfterRealEose();
    if (params.checkAbortAfterSubscribe && params.signal?.aborted) {
      onAbort();
    }
  });
}
