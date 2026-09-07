import { verifyEvent, type Event, type Relay } from "nostr-tools";
import { BUZZ_INBOUND_MESSAGE_KINDS } from "./message-event.js";
import { queryBuzzRelaySnapshot } from "./relay-subscription.js";

// Resolving the quote sits in front of the agent turn, so this budget is much
// tighter than background history paging: a silent relay must not stall a reply.
const REPLY_TARGET_TIMEOUT_MS = 2_000;
const REPLY_TARGET_COMPLETE_REASON = "buzz reply target loaded";

/**
 * Fetch the single event a reply points at.
 *
 * Resolves `null` when the relay has no such event, and rejects only on
 * transport failure so callers can degrade to a quote-less turn.
 */
export async function queryBuzzEventById(params: {
  relay: Relay;
  eventId: string;
  signal?: AbortSignal;
}): Promise<Event | null> {
  let found: Event | null = null;
  return await queryBuzzRelaySnapshot({
    relay: params.relay,
    filters: [{ ids: [params.eventId], kinds: [...BUZZ_INBOUND_MESSAGE_KINDS], limit: 1 }],
    signal: params.signal,
    timeoutMs: REPLY_TARGET_TIMEOUT_MS,
    timeoutMessage: `Timed out loading Buzz reply target ${params.eventId}`,
    abortMessage: "Buzz reply target query aborted",
    failureMessage: "Buzz reply target query failed",
    closeReason: REPLY_TARGET_COMPLETE_REASON,
    closeMessage: (reason) => `Buzz reply target query closed: ${reason}`,
    onEvent: (event) => {
      // This text becomes model-visible quote context, so both questions are
      // answered here rather than left to the transport. Relevance: a relay may
      // answer with events the reply tag never named. Integrity: `verifyEvent`
      // recomputes the event hash, compares it against `id`, then checks `sig`
      // against `pubkey`. nostr-tools already applies that verifier on delivery
      // and caches the verdict on the event, so repeating it costs a cached
      // read while keeping the guarantee visible in the code that relies on it.
      if (!found && event.id === params.eventId && verifyEvent(event)) {
        found = event;
      }
    },
    result: () => found,
    checkAbortAfterSubscribe: true,
    // This runs once per reply, on the relay every room shares. Drop the
    // subscription on timeout, never the connection, and never make the agent
    // turn wait behind a background query.
    closeRelayOnTimeout: false,
    closeSubscriptionOnTimeout: true,
    leaseWait: false,
  });
}
