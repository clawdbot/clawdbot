import { getPublicKey, type Event, type Filter } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const relayMocks = vi.hoisted(() => ({
  roomMetadataEvents: [] as Event[],
  subscriptions: [] as Array<{
    filters: Filter[];
    handlers: {
      onevent: (event: Event) => void;
      oneose?: () => void;
      onclose: (reason: string) => void;
    };
  }>,
  close: vi.fn(),
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      connected = true;
      onauth?: (template: unknown) => Promise<unknown>;
      connect = vi.fn(async () => {});
      auth = vi.fn(async () => "ok");
      publish = vi.fn(async () => "");
      send = vi.fn(async () => {});
      close = relayMocks.close;
      scheduleIdleClose = vi.fn();

      prepareSubscription(
        filters: Filter[],
        handlers: {
          onevent: (event: Event) => void;
          oneose?: () => void;
          onclose: (reason: string) => void;
        },
      ) {
        relayMocks.subscriptions.push({ filters, handlers });
        const filter = filters[0] ?? {};
        if (filter.kinds?.includes(39_000)) {
          for (const event of relayMocks.roomMetadataEvents) {
            const roomId = event.tags.find((tag) => tag[0] === "d")?.[1];
            if (!filter["#d"] || (roomId && filter["#d"]?.includes(roomId))) {
              handlers.onevent(event);
            }
          }
        } else if (filter.kinds?.includes(39_002)) {
          handlers.onevent(MEMBERSHIP_EVENT);
        }
        handlers.oneose?.();
        return {
          id: `sub:${relayMocks.subscriptions.length}`,
          close: vi.fn(),
          closed: false,
        };
      }
    },
  };
});

import { startBuzzBus } from "./buzz-bus.js";
import { BUZZ_MEMBER_ADDED_NOTIFICATION_KIND } from "./room-membership-notification.js";

const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const BOT_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const RELAY_PUBLIC_KEY = "f".repeat(64);
const MEMBERSHIP_EVENT: Event = {
  id: "membership-1",
  kind: 39_002,
  pubkey: RELAY_PUBLIC_KEY,
  created_at: 1_700_000_000,
  content: "",
  sig: "e".repeat(128),
  tags: [
    ["d", CHANNEL_ID],
    ["p", BOT_PUBLIC_KEY, "", "bot"],
  ],
};

function roomMetadata(params: { id: string; createdAt: number; archived: boolean }): Event {
  return {
    id: params.id,
    kind: 39_000,
    pubkey: RELAY_PUBLIC_KEY,
    created_at: params.createdAt,
    content: "",
    sig: "e".repeat(128),
    tags: [
      ["d", CHANNEL_ID],
      ["name", params.archived ? "Archived room" : "Active room"],
      ...(params.archived ? [["archived", "true"]] : []),
    ],
  };
}

function subscriptionIncludesKind(
  subscription: (typeof relayMocks.subscriptions)[number],
  kind: number,
): boolean {
  return subscription.filters.some((filter) => filter.kinds?.includes(kind));
}

describe("Buzz archived room lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relayMocks.subscriptions.length = 0;
    relayMocks.roomMetadataEvents = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          self: RELAY_PUBLIC_KEY,
          software: "https://github.com/block/buzz",
        }),
      })),
    );
  });

  it("does not subscribe to configured rooms whose relay metadata marks them archived", async () => {
    relayMocks.roomMetadataEvents = [
      roomMetadata({ id: "room-metadata-archived", createdAt: 1_700_000_000, archived: true }),
    ];

    const bus = await startBuzzBus({
      accountId: "default",
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage: async () => {},
    });

    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 9))).toBe(
      false,
    );
    expect(
      relayMocks.subscriptions.some((entry) =>
        subscriptionIncludesKind(entry, BUZZ_MEMBER_ADDED_NOTIFICATION_KIND),
      ),
    ).toBe(true);
    expect(bus.directory.activeRoomIds()).toEqual([]);
    expect(bus.directory.listGroups({})).toEqual([]);
    await bus.close();
  });

  it("rebuilds room subscriptions when an active room becomes archived", async () => {
    relayMocks.roomMetadataEvents = [
      roomMetadata({ id: "room-metadata-active", createdAt: 1_700_000_000, archived: false }),
    ];
    const onFatalError = vi.fn();
    const bus = await startBuzzBus({
      accountId: "default",
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage: async () => {},
      onFatalError,
    });
    relayMocks.roomMetadataEvents = [
      roomMetadata({ id: "room-metadata-archived", createdAt: 1_700_000_001, archived: true }),
    ];

    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, 9_002))
      ?.handlers.onevent({
        id: "archive-room",
        kind: 9_002,
        pubkey: "a".repeat(64),
        created_at: 1_700_000_001,
        content: "",
        sig: "e".repeat(128),
        tags: [["h", CHANNEL_ID]],
      });

    await vi.waitFor(() =>
      expect(onFatalError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `Buzz room ${CHANNEL_ID} archive status changed; rebuilding subscriptions`,
        }),
      ),
    );
    expect(relayMocks.close).toHaveBeenCalledOnce();
    await bus.close();
  });

  it("rebuilds room subscriptions when an archived room becomes active", async () => {
    relayMocks.roomMetadataEvents = [
      roomMetadata({ id: "room-metadata-archived", createdAt: 1_700_000_000, archived: true }),
    ];
    const onFatalError = vi.fn();
    const bus = await startBuzzBus({
      accountId: "default",
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage: async () => {},
      onFatalError,
    });
    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, BUZZ_MEMBER_ADDED_NOTIFICATION_KIND))
      ?.handlers.onevent({
        id: "restore-room",
        kind: BUZZ_MEMBER_ADDED_NOTIFICATION_KIND,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: 1_700_000_001,
        content: JSON.stringify({ type: "member_added", channel_id: CHANNEL_ID }),
        sig: "e".repeat(128),
        tags: [
          ["p", BOT_PUBLIC_KEY],
          ["h", CHANNEL_ID],
        ],
      });

    expect(onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `Buzz room ${CHANNEL_ID} membership changed; rebuilding subscriptions`,
      }),
    );
    await bus.close();
  });
});
