import type { Filter, Relay } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { openBuzzRelaySubscription } from "./relay-subscription.js";

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
