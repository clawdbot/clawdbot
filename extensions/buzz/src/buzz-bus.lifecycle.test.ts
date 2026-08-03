import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEvent, getPublicKey, type Event, type Filter } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relayMocks = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  auth: vi.fn<() => Promise<string>>(),
  publish: vi.fn<(event: Event) => Promise<string>>(),
  send: vi.fn<(message: string) => Promise<void>>(),
  close: vi.fn(),
  connected: true,
  stallProfileQueryEose: false,
  stallRoomEoseChannelId: undefined as string | undefined,
  membershipEvents: [] as Event[],
  roomMetadataEvents: [] as Event[],
  profileEvents: [] as Event[],
  roomHistoryEvents: [] as Event[],
  beforeRoomHistoryEvent: undefined as ((event: Event) => void) | undefined,
  subscriptions: [] as Array<{
    filter: Filter;
    filters: Filter[];
    handlers: {
      onevent: (event: Event) => void;
      oneose?: () => void;
      onclose: (reason: string) => void;
    };
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      onauth?: (template: unknown) => Promise<unknown>;
      idleSince: number | undefined;
      ongoingOperations = 0;
      get connected() {
        return relayMocks.connected;
      }
      connect = relayMocks.connect;
      auth = relayMocks.auth;
      publish = relayMocks.publish;
      send = relayMocks.send;
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
        const filter = filters[0] ?? {};
        const close = vi.fn();
        relayMocks.subscriptions.push({ filter, filters, handlers, close });
        if (filter.kinds?.includes(39002)) {
          for (const event of relayMocks.membershipEvents) {
            handlers.onevent(event);
          }
          handlers.oneose?.();
        } else if (filter.kinds?.includes(40099) || filter.kinds?.includes(9002)) {
          const roomId = filter["#h"]?.[0];
          for (const currentFilter of filters) {
            for (const event of relayMocks.roomHistoryEvents) {
              const eventRoomId = event.tags.find((tag) => tag[0] === "h")?.[1];
              if (
                currentFilter.kinds?.includes(event.kind) &&
                currentFilter["#h"]?.includes(eventRoomId ?? "")
              ) {
                relayMocks.beforeRoomHistoryEvent?.(event);
                handlers.onevent(event);
              }
            }
          }
          if (roomId !== relayMocks.stallRoomEoseChannelId) {
            handlers.oneose?.();
          }
        } else if (filter.kinds?.includes(39000)) {
          for (const event of relayMocks.roomMetadataEvents) {
            const roomId = event.tags.find((tag) => tag[0] === "d")?.[1];
            if (!filter["#d"] || (roomId && filter["#d"]?.includes(roomId))) {
              handlers.onevent(event);
            }
          }
          handlers.oneose?.();
        } else if (filter.kinds?.includes(0)) {
          for (const event of relayMocks.profileEvents) {
            if (!filter.authors || filter.authors.includes(event.pubkey)) {
              handlers.onevent(event);
            }
          }
          const isProfileSyncQuery = filters.some((entry) => entry.kinds?.includes(10_100));
          if (!isProfileSyncQuery || !relayMocks.stallProfileQueryEose) {
            handlers.oneose?.();
          }
        }
        return {
          id: `sub:${relayMocks.subscriptions.length}`,
          close,
          closed: false,
        };
      }
    },
  };
});

import { sendBuzzTextOneShot, startBuzzBus, type BuzzBus } from "./buzz-bus.js";
import {
  BUZZ_DIFF_MESSAGE_KIND,
  BUZZ_INBOUND_MESSAGE_KINDS,
  type BuzzInboundMessage,
} from "./message-event.js";

const BUZZ_RICH_MESSAGE_KIND = 40_002;
const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const SENDER_PRIVATE_KEY = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const ACCOUNT_ID = "default";
const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const SECOND_CHANNEL_ID = "45cedd86-f853-45b7-8fea-812b7fe63d7a";
const BOT_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const SENDER_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")));
const SENDER_SECRET_KEY = Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex"));
const RELAY_PUBLIC_KEY = "f".repeat(64);
const tempDirs = new Set<string>();
let previousStateDir: string | undefined;
let stateDir: string;

function startTestBus(
  overrides: Partial<Parameters<typeof startBuzzBus>[0]> = {},
): Promise<BuzzBus> {
  return startBuzzBus({
    accountId: ACCOUNT_ID,
    relayUrl: "wss://buzz.example.com",
    privateKey: PRIVATE_KEY,
    channelIds: [CHANNEL_ID],
    onMessage: async () => {},
    ...overrides,
  });
}

function sendTestTextOneShot(
  overrides: Partial<Parameters<typeof sendBuzzTextOneShot>[0]> = {},
): Promise<string> {
  return sendBuzzTextOneShot({
    relayUrl: "wss://buzz.example.com",
    privateKey: PRIVATE_KEY,
    channelId: CHANNEL_ID,
    text: "hello",
    ...overrides,
  });
}

function signSenderEvent(template: Parameters<typeof finalizeEvent>[0]): Event {
  return finalizeEvent(template, SENDER_SECRET_KEY);
}

function subscriptionIncludesKind(
  subscription: (typeof relayMocks.subscriptions)[number],
  kind: number,
): boolean {
  return subscription.filters.some((filter) => filter.kinds?.includes(kind));
}

function abortReasonAsError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("aborted", { cause: reason });
}

describe("Buzz bus lifecycle", () => {
  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    // openclaw-temp-dir: allow extension tests cannot import root test helpers.
    stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-buzz-dedupe-"));
    tempDirs.add(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    vi.clearAllMocks();
    relayMocks.subscriptions.length = 0;
    relayMocks.profileEvents = [];
    relayMocks.roomMetadataEvents = [];
    relayMocks.roomHistoryEvents = [];
    relayMocks.beforeRoomHistoryEvent = undefined;
    relayMocks.membershipEvents = [
      {
        id: "membership-1",
        kind: 39002,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: 1_700_000_000,
        content: "",
        sig: "e".repeat(128),
        tags: [
          ["d", CHANNEL_ID],
          ["p", BOT_PUBLIC_KEY, "", "bot"],
          ["p", SENDER_PUBLIC_KEY, "", "member"],
        ],
      },
    ];
    relayMocks.connect.mockResolvedValue();
    relayMocks.auth.mockRejectedValue(new Error("auth rejected"));
    relayMocks.publish.mockResolvedValue("");
    relayMocks.send.mockResolvedValue();
    relayMocks.connected = true;
    relayMocks.stallProfileQueryEose = false;
    relayMocks.stallRoomEoseChannelId = undefined;
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

  afterEach(() => {
    vi.useRealTimers();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("rejects an over-capacity room set before opening the relay", async () => {
    await expect(
      startTestBus({
        channelIds: Array.from({ length: 1_021 }, (_, index) => `room-${index}`),
      }),
    ).rejects.toThrow("Buzz supports at most 1020 configured rooms per account");

    expect(relayMocks.connect).not.toHaveBeenCalled();
  });

  it("closes the relay and aborts NIP-11 discovery when authentication fails", async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            fetchSignal = init?.signal ?? undefined;
            fetchSignal?.addEventListener("abort", () => reject(abortReasonAsError(fetchSignal)), {
              once: true,
            });
          }),
      ),
    );

    await expect(startTestBus()).rejects.toThrow("auth rejected");

    expect(relayMocks.connect).toHaveBeenCalledOnce();
    expect(relayMocks.close).toHaveBeenCalledOnce();
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("bounds stalled Buzz relay session setup", async () => {
    vi.useFakeTimers();
    relayMocks.auth.mockResolvedValue("ok");
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            fetchSignal = init?.signal ?? undefined;
            fetchSignal?.addEventListener("abort", () => reject(abortReasonAsError(fetchSignal)), {
              once: true,
            });
          }),
      ),
    );
    const start = startTestBus();
    const rejection = expect(start).rejects.toThrow("Timed out setting up Buzz relay session");

    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;

    expect(fetchSignal?.aborted).toBe(true);
    expect(relayMocks.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("publishes and closes a standalone authenticated send", async () => {
    relayMocks.auth.mockResolvedValue("ok");

    const messageId = await sendTestTextOneShot({
      threadId: "root-id",
      replyToId: "parent-id",
    });

    const event = relayMocks.publish.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      id: messageId,
      kind: 9,
      content: "hello",
      tags: [
        ["h", CHANNEL_ID],
        ["e", "root-id", "", "root"],
        ["e", "parent-id", "", "reply"],
      ],
    });
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("sends room and thread typing without waiting for a relay acknowledgement", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const bus = await startTestBus();

    await bus.sendTyping({
      channelId: CHANNEL_ID,
      threadId: "root-id",
      replyToId: "parent-id",
    });

    const messageFrame = relayMocks.send.mock.calls
      .map(([raw]) => JSON.parse(raw) as [string, Event])
      .find(([type]) => type === "EVENT");
    const frame = messageFrame ?? ["", {} as Event];
    expect(frame[0]).toBe("EVENT");
    expect(frame[1]).toMatchObject({
      kind: 20_002,
      content: "",
      pubkey: BOT_PUBLIC_KEY,
      tags: [
        ["h", CHANNEL_ID],
        ["e", "root-id", "", "root"],
        ["e", "parent-id", "", "reply"],
      ],
    });
    expect(relayMocks.publish).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 20_002 }));
    await bus.close();

    relayMocks.send.mockClear();
    await bus.sendTyping({ channelId: CHANNEL_ID });
    expect(relayMocks.send).not.toHaveBeenCalled();
  });

  it("drops typing while the active relay is disconnected", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const bus = await startTestBus();
    relayMocks.connected = false;
    relayMocks.send.mockClear();

    await bus.sendTyping({ channelId: CHANNEL_ID });

    expect(relayMocks.send).not.toHaveBeenCalled();
    await bus.close();
  });

  it("opens room-scoped live subscriptions for every configured room", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.membershipEvents.push({
      ...relayMocks.membershipEvents[0]!,
      id: "membership-2",
      tags: [
        ["d", SECOND_CHANNEL_ID],
        ["p", BOT_PUBLIC_KEY, "", "bot"],
        ["p", SENDER_PUBLIC_KEY, "", "member"],
      ],
    });

    const bus = await startTestBus({
      channelIds: [CHANNEL_ID, SECOND_CHANNEL_ID],
    });

    expect(relayMocks.subscriptions[0]?.filter.kinds).toEqual([39_000]);
    expect(relayMocks.subscriptions[1]?.filter.kinds).toEqual([44_100, 44_101]);
    expect(relayMocks.subscriptions[2]?.filter.kinds).toEqual([39_002]);
    for (const kind of [9, 9_002, 40_099]) {
      const roomFilters = relayMocks.subscriptions
        .filter((entry) => subscriptionIncludesKind(entry, kind))
        .map((entry) => entry.filters.find((filter) => filter.kinds?.includes(kind))?.["#h"]);
      expect(roomFilters).toEqual([[CHANNEL_ID], [SECOND_CHANNEL_ID]]);
    }
    expect(
      relayMocks.subscriptions.filter((entry) => subscriptionIncludesKind(entry, 40_099)),
    ).toHaveLength(2);
    for (const subscription of relayMocks.subscriptions.filter((entry) =>
      subscriptionIncludesKind(entry, 9),
    )) {
      expect(subscription.filters.find((filter) => filter.kinds?.includes(9))?.limit).toBe(100);
    }

    await bus.close();
  });

  it("dispatches room history without buffering behind another room EOSE", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.membershipEvents.push({
      ...relayMocks.membershipEvents[0]!,
      id: "membership-2",
      tags: [
        ["d", SECOND_CHANNEL_ID],
        ["p", BOT_PUBLIC_KEY, "", "bot"],
        ["p", SENDER_PUBLIC_KEY, "", "member"],
      ],
    });
    relayMocks.roomHistoryEvents = [
      signSenderEvent({
        kind: 9,
        created_at: 1_700_000_000,
        content: "historical message",
        tags: [["h", CHANNEL_ID]],
      }),
    ];
    relayMocks.stallRoomEoseChannelId = SECOND_CHANNEL_ID;
    const onMessage = vi.fn(async (_message: BuzzInboundMessage) => {});

    const start = startTestBus({
      channelIds: [CHANNEL_ID, SECOND_CHANNEL_ID],
      onMessage,
    });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    const stalledSubscription = relayMocks.subscriptions.find(
      (entry) => entry.filter["#h"]?.[0] === SECOND_CHANNEL_ID,
    );
    stalledSubscription?.handlers.oneose?.();
    const bus = await start;
    await bus.close();
  });

  it("bounds replay dispatch when a relay ignores the historical limit", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.roomHistoryEvents = Array.from({ length: 1_033 }, (_, index) => ({
      id: index.toString(16).padStart(64, "0"),
      kind: 9,
      pubkey: SENDER_PUBLIC_KEY,
      created_at: 1_700_000_000 + index,
      content: `historical message ${index}`,
      sig: "e".repeat(128),
      tags: [["h", CHANNEL_ID]],
    }));
    let releaseMessages: (() => void) | undefined;
    const messageGate = new Promise<void>((resolve) => {
      releaseMessages = resolve;
    });
    const onMessage = vi.fn(async () => {
      await messageGate;
    });
    const onFatalError = vi.fn();

    const bus = await startTestBus({
      onMessage,
      onFatalError,
    });

    await vi.waitFor(() => {
      expect(onFatalError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Buzz inbound replay exceeded the 1024-message pending limit",
        }),
      );
    });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(8));
    expect(relayMocks.close).not.toHaveBeenCalled();

    let closed = false;
    const close = bus.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(relayMocks.close).not.toHaveBeenCalled();

    releaseMessages?.();
    await Promise.all(onMessage.mock.results.map((result) => result.value));
    await close;
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("aborts active inbound dispatch before waiting for bus shutdown", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.roomHistoryEvents = [
      {
        id: "d".repeat(64),
        kind: 9,
        pubkey: SENDER_PUBLIC_KEY,
        created_at: 1_700_000_000,
        content: "historical message",
        sig: "e".repeat(128),
        tags: [["h", CHANNEL_ID]],
      },
    ];
    let dispatchSignal: AbortSignal | undefined;
    const onMessage = vi.fn(
      async (_message: BuzzInboundMessage, _bus: BuzzBus, signal: AbortSignal) => {
        dispatchSignal = signal;
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    const bus = await startTestBus({
      onMessage,
    });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    expect(dispatchSignal?.aborted).toBe(false);

    await bus.close();

    expect(dispatchSignal?.aborted).toBe(true);
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("leaves room subscription shutdown to the relay", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const bus = await startTestBus();
    const roomSubscription = relayMocks.subscriptions.find((entry) =>
      subscriptionIncludesKind(entry, 9),
    );

    await bus.close();

    expect(roomSubscription?.close).not.toHaveBeenCalled();
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("refreshes relay-signed room metadata after a live edit", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const onRoomDirectoryChanged = vi.fn();
    relayMocks.roomMetadataEvents = [
      {
        id: "room-metadata-1",
        kind: 39_000,
        pubkey: "f".repeat(64),
        created_at: 1_700_000_000,
        content: "",
        sig: "e".repeat(128),
        tags: [
          ["d", CHANNEL_ID],
          ["name", "Engineering"],
        ],
      },
    ];
    const bus = await startTestBus({
      onRoomDirectoryChanged,
    });
    await vi.waitFor(() => expect(bus.directory.listGroups({})[0]?.name).toBe("Engineering"));

    relayMocks.roomMetadataEvents = [
      {
        ...relayMocks.roomMetadataEvents[0]!,
        id: "room-metadata-2",
        created_at: 1_700_000_001,
        tags: [
          ["d", CHANNEL_ID],
          ["name", "Platform"],
        ],
      },
    ];
    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, 9_002))
      ?.handlers.onevent({
        id: "edit-metadata-1",
        kind: 9_002,
        pubkey: SENDER_PUBLIC_KEY,
        created_at: 1_700_000_001,
        content: "",
        sig: "e".repeat(128),
        tags: [
          ["h", CHANNEL_ID],
          ["name", "Untrusted event name"],
        ],
      });

    await vi.waitFor(() => expect(bus.directory.listGroups({})[0]?.name).toBe("Platform"));
    expect(onRoomDirectoryChanged).toHaveBeenCalledOnce();
    await bus.close();
  });

  it("refreshes room metadata edits replayed during startup", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.roomMetadataEvents = [
      {
        id: "room-metadata-active",
        kind: 39_000,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: 1_700_000_000,
        content: "",
        sig: "e".repeat(128),
        tags: [
          ["d", CHANNEL_ID],
          ["name", "Engineering"],
        ],
      },
    ];
    relayMocks.roomHistoryEvents = [
      {
        id: "archive-room-during-startup",
        kind: 9_002,
        pubkey: SENDER_PUBLIC_KEY,
        created_at: 1_700_000_001,
        content: "",
        sig: "e".repeat(128),
        tags: [["h", CHANNEL_ID]],
      },
    ];
    relayMocks.beforeRoomHistoryEvent = () => {
      relayMocks.roomMetadataEvents = [
        {
          id: "room-metadata-archived",
          kind: 39_000,
          pubkey: RELAY_PUBLIC_KEY,
          created_at: 1_700_000_001,
          content: "",
          sig: "e".repeat(128),
          tags: [
            ["d", CHANNEL_ID],
            ["name", "Engineering"],
            ["archived", "true"],
          ],
        },
      ];
    };
    const onFatalError = vi.fn();

    const bus = await startTestBus({
      onFatalError,
    });

    await vi.waitFor(() =>
      expect(onFatalError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `Buzz room ${CHANNEL_ID} archive status changed; rebuilding subscriptions`,
        }),
      ),
    );
    await bus.close();
  });

  it("loads room metadata and current member profiles on the active bus", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.profileEvents = [
      signSenderEvent({
        kind: 0,
        created_at: 1_700_000_000,
        content: JSON.stringify({
          display_name: "Alice",
          picture: "https://example.com/alice.png",
        }),
        tags: [],
      }),
    ];
    relayMocks.roomMetadataEvents = [
      {
        id: "room-metadata-1",
        kind: 39_000,
        pubkey: "f".repeat(64),
        created_at: 1_700_000_000,
        content: "",
        sig: "e".repeat(128),
        tags: [
          ["d", CHANNEL_ID],
          ["name", "Engineering"],
        ],
      },
    ];

    const bus = await startTestBus({
      profileName: "OpenClaw",
    });

    await vi.waitFor(() =>
      expect(bus.directory.listGroups({})).toEqual([
        expect.objectContaining({
          id: `buzz:${CHANNEL_ID}`,
          name: "Engineering",
        }),
      ]),
    );
    expect(bus.directory.resolveSenderName(SENDER_PUBLIC_KEY)).toBe("Alice");
    expect(bus.directory.listPeers({})).toEqual([
      expect.objectContaining({
        id: SENDER_PUBLIC_KEY,
        name: "Alice",
        avatarUrl: "https://example.com/alice.png",
      }),
    ]);
    expect(bus.directory.listGroupMembers({ groupId: CHANNEL_ID })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: BOT_PUBLIC_KEY }),
        expect.objectContaining({ id: SENDER_PUBLIC_KEY, name: "Alice" }),
      ]),
    );

    await bus.close();
  });

  it("refreshes profile subscriptions after a signed room membership change", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const joinedPrivateKey = "02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021";
    const joinedPublicKey = getPublicKey(Uint8Array.from(Buffer.from(joinedPrivateKey, "hex")));
    relayMocks.profileEvents = [
      finalizeEvent(
        {
          kind: 0,
          created_at: 1_700_000_000,
          content: JSON.stringify({ display_name: "New Member" }),
          tags: [],
        },
        Uint8Array.from(Buffer.from(joinedPrivateKey, "hex")),
      ),
    ];
    const bus = await startTestBus();
    expect(bus.directory.listPeers({}).map((entry) => entry.id)).not.toContain(joinedPublicKey);

    relayMocks.membershipEvents = [
      {
        ...relayMocks.membershipEvents[0]!,
        id: "membership-2",
        created_at: 1_700_000_001,
        tags: [
          ["d", CHANNEL_ID],
          ["p", BOT_PUBLIC_KEY, "", "bot"],
          ["p", SENDER_PUBLIC_KEY, "", "member"],
          ["p", joinedPublicKey, "", "member"],
        ],
      },
    ];
    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, 40_099))
      ?.handlers.onevent({
        id: "system-join-1",
        kind: 40_099,
        pubkey: "f".repeat(64),
        created_at: 1_700_000_001,
        content: JSON.stringify({ type: "member_joined", target: joinedPublicKey }),
        sig: "e".repeat(128),
        tags: [["h", CHANNEL_ID]],
      });

    await vi.waitFor(
      () =>
        expect(bus.directory.listPeers({})).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: joinedPublicKey, name: "New Member" }),
          ]),
        ),
      { timeout: 2_000 },
    );

    await bus.close();
  });

  it("closes a standalone relay when publishing fails", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.publish.mockRejectedValue(new Error("rejected"));

    await expect(sendTestTextOneShot()).rejects.toThrow("rejected");

    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("deduplicates replayed relay events by event id", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const onMessage = vi.fn(async (_message: BuzzInboundMessage) => {});
    const bus = await startTestBus({ onMessage });
    const event = signSenderEvent({
      kind: 9,
      created_at: 1_700_000_000,
      content: "hello",
      tags: [["h", CHANNEL_ID]],
    });

    const messageSubscription = relayMocks.subscriptions.find((entry) =>
      subscriptionIncludesKind(entry, 9),
    );
    messageSubscription?.handlers.onevent(event);
    messageSubscription?.handlers.onevent(event);

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    await bus.close();
  });

  it("subscribes to and dispatches every supported Buzz timeline message kind", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const receivedKinds: number[] = [];
    const onMessage = vi.fn(async (message: BuzzInboundMessage) => {
      receivedKinds.push(message.kind);
    });
    const bus = await startTestBus({ onMessage });
    const messageSubscription = relayMocks.subscriptions.find((entry) =>
      subscriptionIncludesKind(entry, 9),
    );
    expect(messageSubscription?.filters.find((filter) => filter.kinds?.includes(9))?.kinds).toEqual(
      [...BUZZ_INBOUND_MESSAGE_KINDS],
    );

    const richEvent = signSenderEvent({
      kind: BUZZ_RICH_MESSAGE_KIND,
      created_at: 1_700_000_000,
      content: "**rich**",
      tags: [["h", CHANNEL_ID]],
    });
    const diffEvent = signSenderEvent({
      kind: BUZZ_DIFF_MESSAGE_KIND,
      created_at: 1_700_000_001,
      content: "@@ -1 +1 @@\n-old\n+new",
      tags: [
        ["h", CHANNEL_ID],
        ["repo", "https://github.com/openclaw/openclaw"],
        ["commit", "abcdef1"],
      ],
    });

    messageSubscription?.handlers.onevent(richEvent);
    messageSubscription?.handlers.onevent(diffEvent);

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2));
    expect(receivedKinds).toEqual([BUZZ_RICH_MESSAGE_KIND, BUZZ_DIFF_MESSAGE_KIND]);
    await bus.close();
  });

  it("isolates message failures from fatal relay failures", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.profileEvents = [
      finalizeEvent(
        {
          kind: 0,
          created_at: 1_700_000_000,
          content: JSON.stringify({ display_name: "Existing Buzz Name", about: "kept" }),
          tags: [],
        },
        Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")),
      ),
    ];
    const onMessageError = vi.fn();
    const onFatalError = vi.fn();
    const onProfilePublished = vi.fn();
    const bus = await startTestBus({
      onMessage: async () => {
        throw new Error("dispatch failed");
      },
      profileName: "Configured Agent Name",
      onMessageError,
      onFatalError,
      onProfilePublished,
    });
    const event = signSenderEvent({
      kind: 9,
      created_at: 1_700_000_000,
      content: "hello",
      tags: [["h", CHANNEL_ID]],
    });

    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, 9))
      ?.handlers.onevent(event);

    await vi.waitFor(() => expect(onMessageError).toHaveBeenCalledWith(expect.any(Error)));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(
      relayMocks.publish.mock.calls.some(([publishedEvent]) => publishedEvent.kind === 0),
    ).toBe(false);
    expect(
      relayMocks.publish.mock.calls.some(([publishedEvent]) => publishedEvent.kind === 10_100),
    ).toBe(true);
    expect(onProfilePublished).toHaveBeenCalledOnce();
    expect(onFatalError).not.toHaveBeenCalled();
    await bus.close();
  });

  it("recycles the Buzz bus when profile synchronization never reaches EOSE", async () => {
    vi.useFakeTimers();
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.stallProfileQueryEose = true;
    const onFatalError = vi.fn();
    const onProfileError = vi.fn();
    const bus = await startTestBus({
      profileName: "Configured Agent Name",
      onFatalError,
      onProfileError,
    });

    expect(
      relayMocks.subscriptions.some((entry) =>
        entry.filters.some((filter) => filter.kinds?.includes(10_100)),
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Timed out loading current Buzz profile" }),
    );
    expect(relayMocks.close).toHaveBeenCalledOnce();
    expect(onProfileError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Timed out loading current Buzz profile" }),
    );

    await bus.close();
  });

  it("deduplicates replayed events after the bus restarts", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const event = signSenderEvent({
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content: "hello",
      tags: [["h", CHANNEL_ID]],
    });
    const firstOnMessage = vi.fn(async () => {});
    const firstBus = await startTestBus({ onMessage: firstOnMessage });
    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, 9))
      ?.handlers.onevent(event);
    await vi.waitFor(() => expect(firstOnMessage).toHaveBeenCalledOnce());
    await firstBus.close();

    const secondOnMessage = vi.fn(async () => {});
    const secondBus = await startTestBus({ onMessage: secondOnMessage });
    relayMocks.subscriptions
      .findLast((entry) => subscriptionIncludesKind(entry, 9))
      ?.handlers.onevent(event);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(secondOnMessage).not.toHaveBeenCalled();
    await secondBus.close();
  });
});
