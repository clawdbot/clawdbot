import type { Filter, Relay } from "nostr-tools";

type BuzzRelaySubscriptionParams = Omit<Parameters<Relay["prepareSubscription"]>[1], "abort">;

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
