import type { Event, SimplePool } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNostrRelaySubscriptionGroup } from "./nostr-relay-subscription.js";

type RelayHandlers = Parameters<SimplePool["subscribeMany"]>[2];

function createHarness() {
  const handlers: RelayHandlers[] = [];
  const subscribeMany = vi.fn(
    (_relays: string[], _filter: unknown, nextHandlers: RelayHandlers) => {
      handlers.push(nextHandlers);
      return { close: vi.fn() };
    },
  );
  const onBackfillComplete = vi.fn<(relays: string[]) => void>();
  const group = createNostrRelaySubscriptionGroup({
    pool: { subscribeMany } as unknown as SimplePool,
    relays: ["wss://one.example", "wss://two.example"],
    filter: { kinds: [4] },
    abort: new AbortController().signal,
    onEvent: (_event: Event) => {},
    onBackfillComplete,
    onClose: () => {},
    eoseConfirmDeadlineMs: 10,
  });
  group.start();
  return { group, handlers, onBackfillComplete, subscribeMany };
}

describe("Nostr relay subscriptions", () => {
  afterEach(() => vi.useRealTimers());

  it("confirms backfill only after every relay reports real EOSE", async () => {
    const { group, handlers, onBackfillComplete, subscribeMany } = createHarness();

    handlers[0]?.oneose?.();
    handlers[1]?.oneose?.();
    await Promise.resolve();

    expect(subscribeMany.mock.calls.every(([relays]) => relays.length === 1)).toBe(true);
    expect(onBackfillComplete).toHaveBeenCalledWith(["wss://one.example", "wss://two.example"]);
    await group.close("test complete");
  });

  it("does not confirm timeout-synthesized EOSE", async () => {
    vi.useFakeTimers();
    const { group, handlers, onBackfillComplete } = createHarness();

    await vi.advanceTimersByTimeAsync(10);
    handlers[0]?.oneose?.();
    handlers[1]?.oneose?.();
    await Promise.resolve();

    expect(onBackfillComplete).not.toHaveBeenCalled();
    await group.close("test complete");
  });

  it("lets same-turn close veto the pool's synthetic EOSE", async () => {
    const { group, handlers, onBackfillComplete } = createHarness();

    handlers[0]?.oneose?.();
    handlers[0]?.onclose?.(["relay closed"]);
    handlers[1]?.oneose?.();
    await Promise.resolve();

    expect(onBackfillComplete).not.toHaveBeenCalled();
    await group.close("test complete");
  });
});
