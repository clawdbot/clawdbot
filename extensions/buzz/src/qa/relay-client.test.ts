import { getPublicKey, type Event, type Filter } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseBuzzQaCredentialPayload } from "./credentials.js";

const relayMocks = vi.hoisted(() => ({
  auth: vi.fn(async () => "ok"),
  close: vi.fn(),
  connect: vi.fn(async () => {}),
  publish: vi.fn(async () => "ok"),
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
      publish = relayMocks.publish;

      subscribe(
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
        }
        return { close: vi.fn() };
      }
    },
  };
});

import { createBuzzQaRelayDriver } from "./relay-client.js";

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
});
