import type { Event, Filter, Relay } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { queryBuzzDirectoryRooms, startBuzzDirectoryRelay } from "./directory-relay.js";
import { BuzzDirectoryState } from "./directory-state.js";

type SubscriptionRecord = {
  filters: Filter[];
  handlers: {
    onevent: (event: Event) => void;
    oneose: () => void;
    onclose: (reason: string) => void;
  };
  close: ReturnType<typeof vi.fn>;
};

const BOT_PUBLIC_KEY = "a".repeat(64);
const RELAY_PUBLIC_KEY = "f".repeat(64);
const FIRST_MEMBER_PUBLIC_KEY = "b".repeat(64);
const SECOND_MEMBER_PUBLIC_KEY = "c".repeat(64);
const LATEST_MEMBER_PUBLIC_KEY = "d".repeat(64);

function createSubscriptionStub(
  id: string,
  close: ReturnType<typeof vi.fn>,
): ReturnType<Relay["prepareSubscription"]> {
  return { id, close } as unknown as ReturnType<Relay["prepareSubscription"]>;
}

describe("Buzz directory relay", () => {
  it("waits for EOSE and collapses queued profile replacements to the latest set", () => {
    const subscriptions: SubscriptionRecord[] = [];
    const relay = {
      idleSince: undefined,
      ongoingOperations: 0,
      prepareSubscription: vi.fn(
        (
          filters: Filter[],
          handlers: SubscriptionRecord["handlers"],
        ): ReturnType<Relay["prepareSubscription"]> => {
          const close = vi.fn();
          subscriptions.push({ filters, handlers, close });
          return createSubscriptionStub(`sub:${subscriptions.length}`, close);
        },
      ),
      send: vi.fn(async () => {}),
    } as unknown as Relay;
    const directory = startBuzzDirectoryRelay({
      relay,
      relayPublicKey: RELAY_PUBLIC_KEY,
      state: new BuzzDirectoryState({
        publicKey: BOT_PUBLIC_KEY,
        fallbackProfileName: "OpenClaw",
        channelIds: [],
      }),
    });

    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, FIRST_MEMBER_PUBLIC_KEY]);
    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, SECOND_MEMBER_PUBLIC_KEY]);
    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, LATEST_MEMBER_PUBLIC_KEY]);

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.close).not.toHaveBeenCalled();

    subscriptions[0]?.handlers.oneose();

    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0]?.close).toHaveBeenCalledWith("directory profile subscription replaced");
    expect(subscriptions[1]?.filters[0]?.authors).toEqual([
      BOT_PUBLIC_KEY,
      LATEST_MEMBER_PUBLIC_KEY,
    ]);

    directory.close();
    expect(subscriptions[1]?.close).toHaveBeenCalledWith("directory shutdown");
  });

  it("does not start a queued profile replacement after the relay closes", () => {
    const subscriptions: SubscriptionRecord[] = [];
    const relay = {
      idleSince: undefined,
      ongoingOperations: 0,
      prepareSubscription: vi.fn(
        (
          filters: Filter[],
          handlers: SubscriptionRecord["handlers"],
        ): ReturnType<Relay["prepareSubscription"]> => {
          const close = vi.fn();
          subscriptions.push({ filters, handlers, close });
          return createSubscriptionStub(`sub:${subscriptions.length}`, close);
        },
      ),
      send: vi.fn(async () => {}),
    } as unknown as Relay;
    const directory = startBuzzDirectoryRelay({
      relay,
      relayPublicKey: RELAY_PUBLIC_KEY,
      state: new BuzzDirectoryState({
        publicKey: BOT_PUBLIC_KEY,
        fallbackProfileName: "OpenClaw",
        channelIds: [],
      }),
    });

    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, FIRST_MEMBER_PUBLIC_KEY]);
    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, SECOND_MEMBER_PUBLIC_KEY]);
    subscriptions[0]?.handlers.onclose("relay connection closed");

    expect(subscriptions).toHaveLength(1);
  });

  it("closes sibling profile subscriptions when one chunk fails", () => {
    const subscriptions: SubscriptionRecord[] = [];
    const relay = {
      idleSince: undefined,
      ongoingOperations: 0,
      prepareSubscription: vi.fn(
        (
          filters: Filter[],
          handlers: SubscriptionRecord["handlers"],
        ): ReturnType<Relay["prepareSubscription"]> => {
          const close = vi.fn();
          subscriptions.push({ filters, handlers, close });
          return createSubscriptionStub(`sub:${subscriptions.length}`, close);
        },
      ),
      send: vi.fn(async () => {}),
    } as unknown as Relay;
    const directory = startBuzzDirectoryRelay({
      relay,
      relayPublicKey: RELAY_PUBLIC_KEY,
      state: new BuzzDirectoryState({
        publicKey: BOT_PUBLIC_KEY,
        fallbackProfileName: "OpenClaw",
        channelIds: [],
      }),
    });

    directory.replaceProfilePublicKeys(
      Array.from({ length: 201 }, (_, index) => index.toString(16).padStart(64, "0")),
    );
    expect(subscriptions).toHaveLength(2);

    subscriptions[0]?.handlers.onclose("relay rejected subscription");

    expect(subscriptions[1]?.close).toHaveBeenCalledWith(
      "directory profile subscription generation failed",
    );
  });

  it("recycles the owning relay when profile subscriptions never reach EOSE", async () => {
    vi.useFakeTimers();
    const subscriptions: SubscriptionRecord[] = [];
    const relayClose = vi.fn();
    const onFatalError = vi.fn();
    const relay = {
      close: relayClose,
      idleSince: undefined,
      ongoingOperations: 0,
      prepareSubscription: vi.fn(
        (
          filters: Filter[],
          handlers: SubscriptionRecord["handlers"],
        ): ReturnType<Relay["prepareSubscription"]> => {
          const close = vi.fn();
          subscriptions.push({ filters, handlers, close });
          return createSubscriptionStub(`sub:${subscriptions.length}`, close);
        },
      ),
      send: vi.fn(async () => {}),
    } as unknown as Relay;
    const directory = startBuzzDirectoryRelay({
      relay,
      relayPublicKey: RELAY_PUBLIC_KEY,
      state: new BuzzDirectoryState({
        publicKey: BOT_PUBLIC_KEY,
        fallbackProfileName: "OpenClaw",
        channelIds: [],
      }),
      onFatalError,
    });

    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, FIRST_MEMBER_PUBLIC_KEY]);
    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, SECOND_MEMBER_PUBLIC_KEY]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Timed out loading Buzz profile subscriptions" }),
    );
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.close).not.toHaveBeenCalled();
    expect(relayClose).toHaveBeenCalledOnce();

    directory.close();
    vi.useRealTimers();
  });

  it("defers query cleanup until the relay confirms EOSE", async () => {
    const abort = new AbortController();
    let handlers: SubscriptionRecord["handlers"] | undefined;
    const close = vi.fn();
    const relay = {
      idleSince: undefined,
      ongoingOperations: 0,
      prepareSubscription: vi.fn(
        (
          _filters: Filter[],
          nextHandlers: SubscriptionRecord["handlers"],
        ): ReturnType<Relay["prepareSubscription"]> => {
          handlers = nextHandlers;
          return createSubscriptionStub("sub:1", close);
        },
      ),
      send: vi.fn(async () => {}),
    } as unknown as Relay;
    const query = queryBuzzDirectoryRooms({
      relay,
      relayPublicKey: RELAY_PUBLIC_KEY,
      state: new BuzzDirectoryState({
        publicKey: BOT_PUBLIC_KEY,
        fallbackProfileName: "OpenClaw",
        channelIds: [],
      }),
      channelIds: ["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
      signal: abort.signal,
    });

    abort.abort(new Error("stop"));
    await expect(query).rejects.toThrow("stop");
    expect(close).not.toHaveBeenCalled();

    handlers?.oneose();
    expect(close).toHaveBeenCalledWith("directory query complete");
  });

  it("recycles the relay instead of closing a query before EOSE", async () => {
    vi.useFakeTimers();
    const subscriptionClose = vi.fn();
    const relayClose = vi.fn();
    const relay = {
      close: relayClose,
      idleSince: undefined,
      ongoingOperations: 0,
      prepareSubscription: vi.fn((): ReturnType<Relay["prepareSubscription"]> =>
        createSubscriptionStub("sub:1", subscriptionClose),
      ),
      send: vi.fn(async () => {}),
    } as unknown as Relay;
    const query = queryBuzzDirectoryRooms({
      relay,
      relayPublicKey: RELAY_PUBLIC_KEY,
      state: new BuzzDirectoryState({
        publicKey: BOT_PUBLIC_KEY,
        fallbackProfileName: "OpenClaw",
        channelIds: [],
      }),
      channelIds: ["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
    });

    const rejection = expect(query).rejects.toThrow("Timed out loading Buzz directory snapshot");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(subscriptionClose).not.toHaveBeenCalled();
    expect(relayClose).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("reports a fatal bus error before recycling a stalled active directory relay", async () => {
    vi.useFakeTimers();
    const subscriptionClose = vi.fn();
    const relayClose = vi.fn();
    const onFatalError = vi.fn();
    const relay = {
      close: relayClose,
      idleSince: undefined,
      ongoingOperations: 0,
      prepareSubscription: vi.fn((): ReturnType<Relay["prepareSubscription"]> =>
        createSubscriptionStub("sub:1", subscriptionClose),
      ),
      send: vi.fn(async () => {}),
    } as unknown as Relay;
    const directory = startBuzzDirectoryRelay({
      relay,
      relayPublicKey: RELAY_PUBLIC_KEY,
      state: new BuzzDirectoryState({
        publicKey: BOT_PUBLIC_KEY,
        fallbackProfileName: "OpenClaw",
        channelIds: [],
      }),
      onFatalError,
    });
    const refresh = directory.refreshRooms(["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"]);
    const rejection = expect(refresh).rejects.toThrow("Timed out loading Buzz directory snapshot");

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;

    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Timed out loading Buzz directory snapshot" }),
    );
    expect(subscriptionClose).not.toHaveBeenCalled();
    expect(relayClose).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
