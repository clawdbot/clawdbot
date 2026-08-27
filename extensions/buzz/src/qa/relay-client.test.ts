import { getPublicKey, type Event, type Filter } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseBuzzQaCredentialPayload } from "./credentials.js";

const relayMocks = vi.hoisted(() => ({
  auth: vi.fn(async () => "ok"),
  close: vi.fn(),
  connect: vi.fn(async () => {}),
  publish: vi.fn(async () => "ok"),
  send: vi.fn(async () => {}),
  replayedMessage: undefined as Event | undefined,
  subscriptions: [] as Array<{
    filter: Filter;
    handlers: {
      onevent?: (event: Event) => void;
      oneose?: () => void;
      onclose?: (reason: string) => void;
    };
  }>,
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      onauth?: (template: unknown) => Promise<unknown>;
      auth = relayMocks.auth;
      close = relayMocks.close;
      connect = relayMocks.connect;
      idleSince: number | undefined;
      ongoingOperations = 0;
      publish = relayMocks.publish;
      scheduleIdleClose = vi.fn();
      send = relayMocks.send;

      prepareSubscription(
        filters: Filter[],
        handlers: (typeof relayMocks.subscriptions)[number]["handlers"],
      ) {
        const filter = filters[0] ?? {};
        relayMocks.subscriptions.push({ filter, handlers });
        if (filter.kinds?.includes(39002)) {
          handlers.onevent?.({
            id: "membership",
            kind: 39002,
            pubkey: "f".repeat(64),
            created_at: 1_750_000_000,
            content: "",
            sig: "e".repeat(128),
            tags: [
              ["d", "123e4567-e89b-42d3-a456-426614174000"],
              [
                "p",
                getPublicKey(Uint8Array.from(Buffer.from("01".repeat(32), "hex"))),
                "",
                "member",
              ],
              ["p", getPublicKey(Uint8Array.from(Buffer.from("02".repeat(32), "hex"))), "", "bot"],
            ],
          });
          handlers.oneose?.();
        } else {
          if (relayMocks.replayedMessage) {
            handlers.onevent?.(relayMocks.replayedMessage);
          }
          handlers.oneose?.();
        }
        return { id: `sub:${relayMocks.subscriptions.length}`, close: vi.fn() };
      }
    },
  };
});

import { createBuzzQaRelayDriver } from "./relay-client.js";

const RELAY_PUBLIC_KEY = "f".repeat(64);
const credentials = parseBuzzQaCredentialPayload({
  relayUrl: "wss://relay.qa.example",
  roomId: "123e4567-e89b-42d3-a456-426614174000",
  driverPrivateKey: "01".repeat(32),
  sutPrivateKey: "02".repeat(32),
});

describe("Buzz QA relay driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relayMocks.subscriptions.length = 0;
    relayMocks.replayedMessage = undefined;
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

  it("authenticates, verifies membership, and publishes a native mentioned thread event", async () => {
    const driver = await createBuzzQaRelayDriver({
      credentials,
      onMessage: vi.fn(async () => {}),
    });

    const sent = await driver.sendMessage({
      text: "@openclaw hello",
      mentionSut: true,
      threadId: "root-event",
      replyToId: "parent-event",
    });

    expect(sent.eventId).toMatch(/^[a-f0-9]{64}$/u);
    expect(relayMocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sent.eventId,
        kind: 9,
        content: "@openclaw hello",
        tags: [
          ["h", credentials.roomId],
          ["e", "root-event", "", "root"],
          ["e", "parent-event", "", "reply"],
          ["p", credentials.sutPublicKey],
        ],
      }),
    );
    await driver.close();
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("ignores retained SUT messages before the observer reaches live events", async () => {
    const onMessage = vi.fn(async () => {});
    relayMocks.replayedMessage = {
      id: "retained-sut-message",
      kind: 9,
      pubkey: credentials.sutPublicKey,
      created_at: 1_750_000_000,
      content: "old response",
      sig: "e".repeat(128),
      tags: [["h", credentials.roomId]],
    };

    const driver = await createBuzzQaRelayDriver({ credentials, onMessage });

    expect(onMessage).not.toHaveBeenCalled();
    await driver.close();
  });
});
