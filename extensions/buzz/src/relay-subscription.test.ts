import type { Filter, Relay } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { BUZZ_MAX_CONCURRENT_RELAY_QUERIES, acquireBuzzQueryLease } from "./query-lease.js";
import {
  BuzzQueryLeaseUnavailableError,
  openBuzzRelaySubscription,
  queryBuzzRelaySnapshot,
} from "./relay-subscription.js";

describe("openBuzzRelaySubscription", () => {
  it("sends an explicit REQ without synthesizing EOSE", async () => {
    vi.useFakeTimers();
    const oneose = vi.fn();
    const close = vi.fn();
    const subscription = {
      id: "sub:1",
      close,
    } as unknown as ReturnType<Relay["prepareSubscription"]>;
    const prepareSubscription = vi.fn(() => subscription);
    const send = vi.fn(async () => {});
    const relay = {
      idleSince: Date.now(),
      ongoingOperations: 0,
      prepareSubscription,
      send,
    } as unknown as Relay;
    const filters: Filter[] = [{ kinds: [0], authors: ["a".repeat(64)] }];

    const opened = openBuzzRelaySubscription(relay, filters, { oneose });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(opened).toBe(subscription);
    expect(prepareSubscription).toHaveBeenCalledWith(filters, { oneose });
    expect(send).toHaveBeenCalledWith(JSON.stringify(["REQ", "sub:1", ...filters]));
    expect(relay.ongoingOperations).toBe(1);
    expect(relay.idleSince).toBeUndefined();
    expect(oneose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not close a subscription twice when sending fails after relay shutdown", async () => {
    let rejectSend: ((error: Error) => void) | undefined;
    const close = vi.fn();
    const subscription = {
      id: "sub:1",
      closed: false,
      close,
    } as unknown as ReturnType<Relay["prepareSubscription"]>;
    const openSubs = new Map([[subscription.id, subscription]]);
    const relay = {
      idleSince: undefined,
      ongoingOperations: 0,
      openSubs,
      prepareSubscription: vi.fn(() => subscription),
      send: vi.fn(
        async () =>
          await new Promise<void>((_resolve, reject) => {
            rejectSend = reject;
          }),
      ),
    } as unknown as Relay;

    openBuzzRelaySubscription(relay, [{ kinds: [0] }], {});
    subscription.closed = true;
    openSubs.delete(subscription.id);
    rejectSend?.(new Error("socket closed"));
    await Promise.resolve();

    expect(close).not.toHaveBeenCalled();
  });
});

describe("queryBuzzRelaySnapshot", () => {
  it("closes the subscription instead of the relay on timeout when asked", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const subscription = {
      id: "sub:1",
      closed: false,
      close,
    } as unknown as ReturnType<Relay["prepareSubscription"]>;
    const closeRelay = vi.fn();
    const relay = {
      idleSince: undefined,
      ongoingOperations: 0,
      openSubs: new Map(),
      prepareSubscription: vi.fn(() => subscription),
      send: vi.fn(async () => {}),
      close: closeRelay,
    } as unknown as Relay;

    const pending = queryBuzzRelaySnapshot({
      relay,
      filters: [{ kinds: [0] }],
      timeoutMs: 50,
      timeoutMessage: "timed out",
      abortMessage: "aborted",
      failureMessage: "failed",
      closeReason: "done",
      closeMessage: (reason) => reason,
      onEvent: () => {},
      result: () => null,
      closeRelayOnTimeout: false,
      closeSubscriptionOnTimeout: true,
    });
    const rejection = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;

    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith("done");
    expect(closeRelay).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("queryBuzzRelaySnapshot query capacity", () => {
  function createRelay(send: () => Promise<void>) {
    const close = vi.fn();
    const prepareSubscription = vi.fn(() => subscription);
    const closeRelay = vi.fn();
    const subscription = {
      id: "sub:1",
      closed: false,
      close,
    } as unknown as ReturnType<Relay["prepareSubscription"]>;
    const relay = {
      idleSince: undefined,
      ongoingOperations: 0,
      openSubs: new Map([[subscription.id, subscription]]),
      prepareSubscription,
      send: vi.fn(send),
      close: closeRelay,
    } as unknown as Relay;
    return { relay, close, prepareSubscription, closeRelay };
  }

  function snapshotParams(relay: Relay, overrides: Record<string, unknown> = {}) {
    return {
      relay,
      filters: [{ kinds: [0] }],
      timeoutMs: 50,
      timeoutMessage: "timed out",
      abortMessage: "aborted",
      failureMessage: "failed",
      closeReason: "done",
      closeMessage: (reason: string) => reason,
      onEvent: () => {},
      result: () => null,
      closeRelayOnTimeout: false,
      closeSubscriptionOnTimeout: true,
      ...overrides,
    };
  }

  it("refuses a no-wait query while other transient queries hold the allowance", async () => {
    const { relay, close, prepareSubscription } = createRelay(async () => {});
    const held = [];
    for (let index = 0; index < BUZZ_MAX_CONCURRENT_RELAY_QUERIES; index += 1) {
      held.push(await acquireBuzzQueryLease(relay));
    }

    // A profile, membership or history query holding the reserve must block a
    // reply lookup rather than letting it open a subscription past the cap.
    await expect(
      queryBuzzRelaySnapshot(snapshotParams(relay, { leaseWait: false })),
    ).rejects.toThrow(BuzzQueryLeaseUnavailableError);
    expect(prepareSubscription).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    for (const release of held) {
      release?.();
    }
  });

  it("waits for the REQ frame before closing a timed-out subscription", async () => {
    let releaseSend: (() => void) | undefined;
    const { close, closeRelay, relay } = createRelay(
      async () =>
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        }),
    );

    const pending = queryBuzzRelaySnapshot(snapshotParams(relay));
    const rejection = expect(pending).rejects.toThrow("timed out");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });
    await rejection;

    // The REQ is still in flight: closing now could overtake it server-side.
    expect(close).not.toHaveBeenCalled();

    releaseSend?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith("done");
    expect(closeRelay).not.toHaveBeenCalled();
  });
});
