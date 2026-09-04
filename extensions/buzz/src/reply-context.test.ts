import type { Event, Filter, Relay } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The shared query lease makes subscription setup async, so wait for the REQ. */
async function waitForSubscription(prepareSubscription: { mock: { calls: unknown[] } }) {
  await vi.waitFor(() => expect(prepareSubscription.mock.calls.length).toBeGreaterThan(0));
}
import { BUZZ_NORMAL_MESSAGE_KIND } from "./message-event.js";
import { queryBuzzEventById } from "./reply-context.js";

type SubscriptionHandlers = {
  onevent?: (event: Event) => void;
  oneose?: () => void;
  onclose?: (reason: string) => void;
};

function createRelay() {
  const handlers: SubscriptionHandlers = {};
  const closeSubscription = vi.fn();
  const closeRelay = vi.fn();
  const subscription = {
    id: "sub:reply",
    closed: false,
    close: closeSubscription,
  } as unknown as ReturnType<Relay["prepareSubscription"]>;
  const prepareSubscription = vi.fn((_filters: Filter[], params: SubscriptionHandlers) => {
    Object.assign(handlers, params);
    return subscription;
  });
  const relay = {
    connected: true,
    idleSince: undefined,
    ongoingOperations: 0,
    openSubs: new Map(),
    prepareSubscription,
    send: vi.fn(async () => {}),
    close: closeRelay,
  } as unknown as Relay;
  return { relay, handlers, prepareSubscription, closeSubscription, closeRelay };
}

function roomEvent(id: string): Event {
  return {
    id,
    kind: BUZZ_NORMAL_MESSAGE_KIND,
    pubkey: "a".repeat(64),
    created_at: 1_777_000_000,
    tags: [],
    content: "hello",
    sig: "",
  } as Event;
}

describe("queryBuzzEventById", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the named event once the relay signals EOSE", async () => {
    const { relay, handlers, prepareSubscription, closeSubscription, closeRelay } = createRelay();

    const pending = queryBuzzEventById({ relay, eventId: "target" });
    await waitForSubscription(prepareSubscription);
    handlers.onevent?.(roomEvent("someone-else"));
    handlers.onevent?.(roomEvent("target"));
    handlers.oneose?.();

    await expect(pending).resolves.toMatchObject({ id: "target" });
    expect(prepareSubscription).toHaveBeenCalledWith(
      [{ ids: ["target"], kinds: expect.any(Array), limit: 1 }],
      expect.anything(),
    );
    expect(closeSubscription).toHaveBeenCalledTimes(1);
    expect(closeRelay).not.toHaveBeenCalled();
  });

  it("resolves null when the relay has no such event", async () => {
    const { relay, handlers, prepareSubscription } = createRelay();

    const pending = queryBuzzEventById({ relay, eventId: "target" });
    await waitForSubscription(prepareSubscription);
    handlers.oneose?.();

    await expect(pending).resolves.toBeNull();
  });

  it("closes only its own subscription when the relay never answers", async () => {
    vi.useFakeTimers();
    const { relay, handlers, prepareSubscription, closeSubscription, closeRelay } = createRelay();

    const pending = queryBuzzEventById({ relay, eventId: "target" });
    const rejection = expect(pending).rejects.toThrow("Timed out loading Buzz reply target target");
    // Fake timers are active, so flush the lease microtasks instead of polling.
    await vi.advanceTimersByTimeAsync(0);
    expect(prepareSubscription).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;

    expect(closeSubscription).toHaveBeenCalledTimes(1);
    expect(closeRelay).not.toHaveBeenCalled();

    // A late EOSE must not close the subscription a second time.
    handlers.oneose?.();
    expect(closeSubscription).toHaveBeenCalledTimes(1);
  });

  it("rejects with the abort reason when cancelled", async () => {
    const controller = new AbortController();
    const { relay } = createRelay();

    const pending = queryBuzzEventById({ relay, eventId: "target", signal: controller.signal });
    controller.abort(new Error("gateway shutting down"));

    await expect(pending).rejects.toThrow("gateway shutting down");
  });
});
