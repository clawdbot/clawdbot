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
  subscriptionClose: vi.fn(),
  close: vi.fn(),
  connected: true,
  membershipEvents: [] as Event[],
  profileEvents: [] as Event[],
  subscriptions: [] as Array<{
    filter: Filter;
    handlers: {
      onevent: (event: Event) => void;
      oneose?: () => void;
      onclose: (reason: string) => void;
    };
  }>,
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      onauth?: (template: unknown) => Promise<unknown>;
      get connected() {
        return relayMocks.connected;
      }
      connect = relayMocks.connect;
      auth = relayMocks.auth;
      publish = relayMocks.publish;
      send = relayMocks.send;
      close = relayMocks.close;

      subscribe(
        filters: Filter[],
        handlers: {
          onevent: (event: Event) => void;
          oneose?: () => void;
          onclose: (reason: string) => void;
        },
      ) {
        const filter = filters[0] ?? {};
        relayMocks.subscriptions.push({ filter, handlers });
        if (filter.kinds?.includes(39002)) {
          for (const event of relayMocks.membershipEvents) {
            handlers.onevent(event);
          }
          handlers.oneose?.();
        } else if (filter.kinds?.includes(40099)) {
          handlers.oneose?.();
        } else if (filter.kinds?.includes(0)) {
          for (const event of relayMocks.profileEvents) {
            handlers.onevent(event);
          }
          handlers.oneose?.();
        }
        return { close: relayMocks.subscriptionClose };
      }
    },
  };
});

import { sendBuzzTextOneShot, startBuzzBus } from "./buzz-bus.js";
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
const BOT_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const SENDER_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")));
const tempDirs = new Set<string>();
let previousStateDir: string | undefined;
let stateDir: string;

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
    relayMocks.membershipEvents = [
      {
        id: "membership-1",
        kind: 39002,
        pubkey: "f".repeat(64),
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
  });

  afterEach(() => {
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

  it("closes a connected relay when authentication fails", async () => {
    await expect(
      startBuzzBus({
        accountId: ACCOUNT_ID,
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        channelIds: [CHANNEL_ID],
        onMessage: async () => {},
      }),
    ).rejects.toThrow("auth rejected");

    expect(relayMocks.connect).toHaveBeenCalledOnce();
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("publishes and closes a standalone authenticated send", async () => {
    relayMocks.auth.mockResolvedValue("ok");

    const messageId = await sendBuzzTextOneShot({
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelId: CHANNEL_ID,
      text: "hello",
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
    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage: async () => {},
    });

    await bus.sendTyping({
      channelId: CHANNEL_ID,
      threadId: "root-id",
      replyToId: "parent-id",
    });

    const frame = JSON.parse(relayMocks.send.mock.calls[0]?.[0] ?? "null") as [string, Event];
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
    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage: async () => {},
    });
    relayMocks.connected = false;

    await bus.sendTyping({ channelId: CHANNEL_ID });

    expect(relayMocks.send).not.toHaveBeenCalled();
    await bus.close();
  });

  it("closes a standalone relay when publishing fails", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.publish.mockRejectedValue(new Error("rejected"));

    await expect(
      sendBuzzTextOneShot({
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        channelId: CHANNEL_ID,
        text: "hello",
      }),
    ).rejects.toThrow("rejected");

    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("deduplicates replayed relay events by event id", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const onMessage = vi.fn(async (_message: BuzzInboundMessage) => {});
    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage,
    });
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: 1_700_000_000,
        content: "hello",
        tags: [["h", CHANNEL_ID]],
      },
      Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")),
    );

    const messageSubscription = relayMocks.subscriptions.find((entry) =>
      entry.filter.kinds?.includes(9),
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
    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage,
    });
    const messageSubscription = relayMocks.subscriptions.find((entry) =>
      entry.filter.kinds?.includes(9),
    );
    expect(messageSubscription?.filter.kinds).toEqual([...BUZZ_INBOUND_MESSAGE_KINDS]);

    const richEvent = finalizeEvent(
      {
        kind: BUZZ_RICH_MESSAGE_KIND,
        created_at: 1_700_000_000,
        content: "**rich**",
        tags: [["h", CHANNEL_ID]],
      },
      Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")),
    );
    const diffEvent = finalizeEvent(
      {
        kind: BUZZ_DIFF_MESSAGE_KIND,
        created_at: 1_700_000_001,
        content: "@@ -1 +1 @@\n-old\n+new",
        tags: [
          ["h", CHANNEL_ID],
          ["repo", "https://github.com/openclaw/openclaw"],
          ["commit", "abcdef1"],
        ],
      },
      Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")),
    );

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
    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage: async () => {
        throw new Error("dispatch failed");
      },
      profileName: "Configured Agent Name",
      onMessageError,
      onFatalError,
      onProfilePublished,
    });
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: 1_700_000_000,
        content: "hello",
        tags: [["h", CHANNEL_ID]],
      },
      Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")),
    );

    relayMocks.subscriptions
      .find((entry) => entry.filter.kinds?.includes(9))
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

  it("deduplicates replayed events after the bus restarts", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        content: "hello",
        tags: [["h", CHANNEL_ID]],
      },
      Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")),
    );
    const firstOnMessage = vi.fn(async () => {});
    const firstBus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage: firstOnMessage,
    });
    relayMocks.subscriptions
      .find((entry) => entry.filter.kinds?.includes(9))
      ?.handlers.onevent(event);
    await vi.waitFor(() => expect(firstOnMessage).toHaveBeenCalledOnce());
    await firstBus.close();

    const secondOnMessage = vi.fn(async () => {});
    const secondBus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      onMessage: secondOnMessage,
    });
    relayMocks.subscriptions
      .findLast((entry) => entry.filter.kinds?.includes(9))
      ?.handlers.onevent(event);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(secondOnMessage).not.toHaveBeenCalled();
    await secondBus.close();
  });
});
