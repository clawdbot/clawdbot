import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEvent, getPublicKey, nip19, type Event, type Filter } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relayMocks = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  auth: vi.fn<() => Promise<string>>(),
  publish: vi.fn<(event: Event) => Promise<string>>(),
  send: vi.fn<(message: string) => Promise<void>>(),
  close: vi.fn(),
  profileEvents: [] as Event[],
  membershipEvents: [] as Event[],
  subscriptions: [] as Array<{
    filters: Filter[];
    handlers: {
      onevent: (event: Event) => void;
      oneose?: () => void;
      onclose?: (reason: string) => void;
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
      connected = true;
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
          onclose?: (reason: string) => void;
        },
      ) {
        const close = vi.fn();
        relayMocks.subscriptions.push({ filters, handlers, close });
        if (filters.some((filter) => filter.kinds?.includes(39002))) {
          for (const event of relayMocks.membershipEvents) {
            handlers.onevent(event);
          }
        } else if (filters.some((filter) => filter.kinds?.includes(0))) {
          for (const event of relayMocks.profileEvents) {
            handlers.onevent(event);
          }
        }
        handlers.oneose?.();
        return {
          id: `sub:${relayMocks.subscriptions.length}`,
          close,
          closed: false,
        };
      }
    },
  };
});

import { sendBuzzTextOneShot, startBuzzBus } from "./buzz-bus.js";

const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const SENDER_PRIVATE_KEY = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const ACCOUNT_ID = "default";
const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const BOT_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const SENDER_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")));
const RELAY_PUBLIC_KEY = "f".repeat(64);
let previousStateDir: string | undefined;
let stateDir: string;

function subscriptionIncludesKind(
  subscription: (typeof relayMocks.subscriptions)[number],
  kind: number,
): boolean {
  return subscription.filters.some((filter) => filter.kinds?.includes(kind));
}

describe("Buzz mention delivery", () => {
  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    // openclaw-temp-dir: allow extension tests cannot import root test helpers.
    stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-buzz-mentions-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    vi.clearAllMocks();
    relayMocks.profileEvents = [];
    relayMocks.subscriptions.length = 0;
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
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.publish.mockResolvedValue("");
    relayMocks.send.mockResolvedValue();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          self: RELAY_PUBLIC_KEY,
          software: "https://github.com/block/buzz",
        }),
      ),
    );
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("resolves standalone native mentions from the room snapshot before publishing", async () => {
    relayMocks.profileEvents = [
      finalizeEvent(
        {
          kind: 0,
          created_at: 1_700_000_000,
          content: JSON.stringify({ display_name: "Alice" }),
          tags: [],
        },
        Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")),
      ),
    ];

    await sendBuzzTextOneShot({
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelId: CHANNEL_ID,
      text: "Hello @Alice",
      threadId: "root-id",
    });

    expect(relayMocks.publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 9,
      content: "Hello @Alice",
      tags: [
        ["h", CHANNEL_ID],
        ["e", "root-id", "", "reply"],
        ["p", SENDER_PUBLIC_KEY],
      ],
    });
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 39002))).toBe(
      true,
    );
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 0))).toBe(true);
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("skips profile discovery for an explicit standalone NIP-27 mention", async () => {
    await sendBuzzTextOneShot({
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelId: CHANNEL_ID,
      text: `Hello nostr:${nip19.npubEncode(SENDER_PUBLIC_KEY)}`,
    });

    expect(relayMocks.publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 9,
      tags: [
        ["h", CHANNEL_ID],
        ["p", SENDER_PUBLIC_KEY],
      ],
    });
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 39002))).toBe(
      true,
    );
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 0))).toBe(
      false,
    );
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("closes a standalone relay when mention preflight rejects the message", async () => {
    await expect(
      sendBuzzTextOneShot({
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        channelId: CHANNEL_ID,
        text: "Hello @Missing",
      }),
    ).rejects.toThrow('Buzz mention "@missing" does not match a current room member');

    expect(relayMocks.publish).not.toHaveBeenCalled();
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("resolves active-bus mentions for proactive sends and agent replies", async () => {
    relayMocks.profileEvents = [
      finalizeEvent(
        {
          kind: 0,
          created_at: 1_700_000_000,
          content: JSON.stringify({ display_name: "Alice" }),
          tags: [],
        },
        Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")),
      ),
    ];
    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage: async () => {},
    });

    await bus.sendText({
      channelId: CHANNEL_ID,
      text: "Hello @Alice",
      threadId: "root-id",
      replyToId: "parent-id",
    });

    const event = relayMocks.publish.mock.calls
      .map(([published]) => published)
      .find((published) => published.kind === 9);
    expect(event).toMatchObject({
      kind: 9,
      content: "Hello @Alice",
      tags: [
        ["h", CHANNEL_ID],
        ["e", "root-id", "", "root"],
        ["e", "parent-id", "", "reply"],
        ["p", SENDER_PUBLIC_KEY],
      ],
    });
    expect(relayMocks.connect).toHaveBeenCalledOnce();

    await bus.close();
  });

  it("stops mentioning a removed member before the signed roster refresh completes", async () => {
    const explicitSender = `nostr:${nip19.npubEncode(SENDER_PUBLIC_KEY)}`;
    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage: async () => {},
    });

    await bus.sendText({ channelId: CHANNEL_ID, text: explicitSender });
    relayMocks.publish.mockClear();
    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, 40_099))
      ?.handlers.onevent({
        id: "member-removed-1",
        kind: 40_099,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: 1_700_000_001,
        content: JSON.stringify({ type: "member_removed", target: SENDER_PUBLIC_KEY }),
        sig: "e".repeat(128),
        tags: [["h", CHANNEL_ID]],
      });

    expect(bus.directory.mentionMembers(CHANNEL_ID)).toEqual([
      expect.objectContaining({ publicKey: BOT_PUBLIC_KEY }),
    ]);
    await expect(bus.sendText({ channelId: CHANNEL_ID, text: explicitSender })).rejects.toThrow(
      "is not a current room member",
    );
    expect(relayMocks.publish).not.toHaveBeenCalled();

    await bus.close();
  });

  it("keeps mention-free active sends off the room roster path", async () => {
    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage: async () => {},
    });
    const mentionMembers = vi.spyOn(bus.directory, "mentionMembers");

    await bus.sendText({
      channelId: CHANNEL_ID,
      text: "Plain message without a mention",
    });

    expect(mentionMembers).not.toHaveBeenCalled();
    expect(relayMocks.publish.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 9,
      tags: [["h", CHANNEL_ID]],
    });

    await bus.close();
  });
});
