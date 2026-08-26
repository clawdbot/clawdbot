import type { Event, Filter, Relay } from "nostr-tools";

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
  checkAbortAfterSubscribe?: boolean;
};

export function openBuzzRelaySubscription(
  relay: Relay,
  filters: Filter[],
  params: BuzzRelaySubscriptionParams,
): ReturnType<Relay["prepareSubscription"]> {
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

  const frame = JSON.stringify(["REQ", subscription.id, ...filters]);
  void relay.send(frame).catch((error: unknown) => {
    if (subscription.closed || relay.openSubs.get(subscription.id) !== subscription) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    subscription.close(`Buzz relay subscription request failed: ${message}`);
  });
  return subscription;
}

export async function queryBuzzRelaySnapshot<TResult>(
  params: BuzzRelaySnapshotParams<TResult>,
): Promise<TResult> {
  return await new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let receivedEose = false;
    let subscriptionClosed = false;
    let subscription: ReturnType<Relay["prepareSubscription"]> | undefined;
    const timeout = setTimeout(() => {
      const error = new Error(params.timeoutMessage);
      finish(error);
      params.onTimeout?.(error);
      if (params.closeRelayOnTimeout !== false) {
        params.relay.close();
      }
    }, params.timeoutMs ?? 10_000);
    const closeAfterRealEose = () => {
      if (receivedEose && subscription && !subscriptionClosed) {
        subscriptionClosed = true;
        subscription.close(params.closeReason);
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
