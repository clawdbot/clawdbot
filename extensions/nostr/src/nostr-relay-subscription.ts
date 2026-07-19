import type { Event, SimplePool } from "nostr-tools";

const DEFAULT_EOSE_CONFIRM_DEADLINE_MS = 10_000;
const LIBRARY_EOSE_TIMEOUT_MARGIN_MS = 1_000;
type BackfillStatus = "pending" | "confirmed" | "incomplete";

/** Separates real relay EOSE frames from nostr-tools timeout/close synthesis. */
export function createNostrRelaySubscriptionGroup(options: {
  pool: SimplePool;
  relays: string[];
  filter: Parameters<SimplePool["subscribeMany"]>[1];
  abort: AbortSignal;
  onEvent: (event: Event) => void;
  onBackfillComplete: (relays: string[]) => void;
  onClose: (relay: string, reasons: string[]) => void;
  eoseConfirmDeadlineMs?: number;
}) {
  const relays = [...new Set(options.relays)];
  const subscriptions: Array<ReturnType<SimplePool["subscribeMany"]>> = [];
  const deadlineTimers = new Set<ReturnType<typeof setTimeout>>();
  const backfillStatus = new Map<string, BackfillStatus>(
    relays.map((relay): [string, BackfillStatus] => [relay, "pending"]),
  );
  const confirmDeadlineMs = options.eoseConfirmDeadlineMs ?? DEFAULT_EOSE_CONFIRM_DEADLINE_MS;

  const settleBackfill = (relay: string, status: "confirmed" | "incomplete"): void => {
    if (backfillStatus.get(relay) !== "pending") {
      return;
    }
    backfillStatus.set(relay, status);
    if ([...backfillStatus.values()].some((value) => value === "pending")) {
      return;
    }
    if ([...backfillStatus.values()].every((value) => value === "confirmed")) {
      options.onBackfillComplete(relays);
    }
  };

  const clearDeadlines = (): void => {
    for (const timer of deadlineTimers) {
      clearTimeout(timer);
    }
    deadlineTimers.clear();
  };

  return {
    start: (): void => {
      for (const relay of relays) {
        let relayClosed = false;
        let deadlineReached = false;
        const deadlineTimer = setTimeout(() => {
          deadlineTimers.delete(deadlineTimer);
          deadlineReached = true;
          settleBackfill(relay, "incomplete");
        }, confirmDeadlineMs);
        deadlineTimer.unref?.();
        deadlineTimers.add(deadlineTimer);

        subscriptions.push(
          options.pool.subscribeMany([relay], options.filter, {
            onevent: options.onEvent,
            oneose: () => {
              // Pool close is reported as EOSE first. Its onclose runs in this same turn.
              queueMicrotask(() => {
                if (!relayClosed && !deadlineReached) {
                  clearTimeout(deadlineTimer);
                  deadlineTimers.delete(deadlineTimer);
                  settleBackfill(relay, "confirmed");
                }
              });
            },
            onclose: (reasons) => {
              relayClosed = true;
              clearTimeout(deadlineTimer);
              deadlineTimers.delete(deadlineTimer);
              settleBackfill(relay, "incomplete");
              options.onClose(relay, reasons);
            },
            // Own earlier deadline marks synthetic library EOSE as incomplete.
            maxWait: confirmDeadlineMs + LIBRARY_EOSE_TIMEOUT_MARGIN_MS,
            abort: options.abort,
          }),
        );
      }
    },
    close: async (reason: string): Promise<void> => {
      clearDeadlines();
      await Promise.all(subscriptions.map(async (subscription) => subscription.close(reason)));
    },
  };
}
