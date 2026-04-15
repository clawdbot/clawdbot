import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNostrBus } from "./nostr-bus.js";
import { TEST_HEX_PRIVATE_KEY } from "./test-fixtures.js";

const BOT_PUBKEY = "b".repeat(64);

const mockState = vi.hoisted(() => ({
  handlers: null as {
    onevent: (event: Record<string, unknown>) => void | Promise<void>;
    oneose?: () => void;
    onclose?: (reason: string[]) => void;
  } | null,
  verifyEvent: vi.fn(() => true),
  decrypt: vi.fn(() => "plaintext"),
  publishProfile: vi.fn(async () => ({
    createdAt: 0,
    eventId: "profile-event",
    successes: [],
    failures: [],
  })),
}));

vi.mock("nostr-tools", () => {
  class MockSimplePool {
    subscribeMany(
      _relays: string[],
      _filters: unknown,
      handlers: {
        onevent: (event: Record<string, unknown>) => void | Promise<void>;
        oneose?: () => void;
        onclose?: (reason: string[]) => void;
      },
    ) {
      mockState.handlers = handlers;
      return {
        close: vi.fn(),
      };
    }

    publish = vi.fn(async () => {});
  }

  return {
    SimplePool: MockSimplePool,
    finalizeEvent: vi.fn((event: unknown) => event),
    getPublicKey: vi.fn(() => BOT_PUBKEY),
    verifyEvent: mockState.verifyEvent,
    nip19: {
      decode: vi.fn(),
      npubEncode: vi.fn((value: string) => `npub-${value}`),
    },
  };
});

vi.mock("nostr-tools/nip04", () => ({
  decrypt: mockState.decrypt,
  encrypt: vi.fn(() => "ciphertext"),
}));

vi.mock("./nostr-state-store.js", () => ({
  readNostrBusState: vi.fn(async () => null),
  writeNostrBusState: vi.fn(async () => {}),
  computeSinceTimestamp: vi.fn(() => 0),
  readNostrProfileState: vi.fn(async () => null),
  writeNostrProfileState: vi.fn(async () => {}),
}));

vi.mock("./nostr-profile.js", () => ({
  publishProfile: mockState.publishProfile,
}));

function createEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    kind: 4,
    pubkey: "a".repeat(64),
    content: "ciphertext",
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", BOT_PUBKEY]],
    ...overrides,
  };
}

async function emitEvent(event: Record<string, unknown>) {
  if (!mockState.handlers) {
    throw new Error("missing subscription handlers");
  }
  await mockState.handlers.onevent(event);
}

describe("startNostrBus inbound guards", () => {
  beforeEach(() => {
    mockState.handlers = null;
    mockState.verifyEvent.mockClear();
    mockState.verifyEvent.mockReturnValue(true);
    mockState.decrypt.mockClear();
    mockState.decrypt.mockReturnValue("plaintext");
  });

  afterEach(() => {
    mockState.handlers = null;
  });

  it("checks sender authorization after verify and before decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "block" as const);
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      authorizeSender,
      onMetric: () => {},
    });

    await emitEvent(createEvent());

    expect(authorizeSender).toHaveBeenCalledTimes(1);
    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(bus.getMetrics().eventsReceived).toBe(1);

    bus.close();
  });

  it("rejects invalid signatures before sender authorization", async () => {
    mockState.verifyEvent.mockReturnValueOnce(false);
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "allow" as const);
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      authorizeSender,
      onMetric: () => {},
    });

    await emitEvent(createEvent());

    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(authorizeSender).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(bus.getMetrics().eventsRejected.invalidSignature).toBe(1);

    bus.close();
  });

  it("dedupes replayed invalid-signature events before verify fans out again", async () => {
    mockState.verifyEvent.mockReturnValue(false);
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "allow" as const);
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      authorizeSender,
      onMetric: () => {},
    });

    const invalidEvent = createEvent({ id: "invalid-replay" });

    await emitEvent(invalidEvent);
    await emitEvent(invalidEvent);

    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(authorizeSender).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(bus.getMetrics().eventsRejected.invalidSignature).toBe(1);
    expect(bus.getMetrics().eventsDuplicate).toBe(1);

    bus.close();
  });

  it("dedupes replayed self-message events before other guards rerun", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "allow" as const);
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      authorizeSender,
      onMetric: () => {},
    });

    const selfEvent = createEvent({
      id: "self-replay",
      pubkey: BOT_PUBKEY,
    });

    await emitEvent(selfEvent);
    await emitEvent(selfEvent);

    expect(mockState.verifyEvent).not.toHaveBeenCalled();
    expect(authorizeSender).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(bus.getMetrics().eventsDuplicate).toBe(1);

    bus.close();
  });

  it("rate limits repeated events before decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      onMetric: () => {},
    });

    for (let i = 0; i < 21; i += 1) {
      await emitEvent(
        createEvent({
          id: `event-${i}`,
        }),
      );
    }

    const snapshot = bus.getMetrics();
    expect(snapshot.eventsRejected.rateLimited).toBe(1);
    expect(mockState.decrypt).toHaveBeenCalledTimes(20);
    expect(onMessage).toHaveBeenCalledTimes(20);

    bus.close();
  });

  it("does not let a blocked sender starve a different verified sender", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async ({ senderPubkey }: { senderPubkey: string }) =>
      senderPubkey.startsWith("blocked") ? ("block" as const) : ("allow" as const),
    );
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      authorizeSender,
      onMetric: () => {},
      guardPolicy: {
        rateLimit: {
          windowMs: 60_000,
          maxGlobalPerWindow: 2,
          maxPerSenderPerWindow: 1,
          maxTrackedSenderKeys: 32,
        },
      },
    });

    await emitEvent(
      createEvent({
        id: "blocked-event",
        pubkey: `blocked${"a".repeat(57)}`,
      }),
    );
    await emitEvent(
      createEvent({
        id: "allowed-event",
        pubkey: `allowed${"b".repeat(57)}`,
      }),
    );

    expect(authorizeSender).toHaveBeenCalledTimes(2);
    expect(mockState.decrypt).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(0);

    bus.close();
  });

  it("dedupes replayed verified events that authorization blocks", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "block" as const);
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      authorizeSender,
      onMetric: () => {},
    });

    const blockedEvent = createEvent({
      id: "blocked-replay",
      pubkey: `blocked${"a".repeat(57)}`,
    });

    await emitEvent(blockedEvent);
    await emitEvent(blockedEvent);

    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(authorizeSender).toHaveBeenCalledTimes(1);
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    bus.close();
  });

  it("retries a replayed event after the message handler fails", async () => {
    const onMessage = vi
      .fn<(sender: string, plaintext: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      onMetric: () => {},
    });

    const event = createEvent({
      id: "retry-after-handler-failure",
    });

    await emitEvent(event);
    await emitEvent(event);

    expect(mockState.verifyEvent).toHaveBeenCalledTimes(2);
    expect(mockState.decrypt).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(bus.getMetrics().eventsProcessed).toBe(1);

    bus.close();
  });

  it("does not rate limit an allowed sender while another authorization is still pending", async () => {
    const onMessage = vi.fn(async () => {});
    let resolveBlocked: ((value: "block") => void) | undefined;
    const blockedPromise = new Promise<"block">((resolve) => {
      resolveBlocked = resolve;
    });
    const authorizeSender = vi
      .fn<(params: { senderPubkey: string }) => Promise<"allow" | "block" | "pairing">>()
      .mockImplementationOnce(async () => await blockedPromise)
      .mockResolvedValueOnce("allow");
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      authorizeSender,
      onMetric: () => {},
      guardPolicy: {
        rateLimit: {
          windowMs: 60_000,
          maxGlobalPerWindow: 2,
          maxPerSenderPerWindow: 1,
          maxTrackedSenderKeys: 32,
        },
      },
    });

    const blockedEventPromise = emitEvent(
      createEvent({
        id: "blocked-pending",
        pubkey: `blocked${"a".repeat(57)}`,
      }),
    );
    await emitEvent(
      createEvent({
        id: "allowed-during-pending-auth",
        pubkey: `allowed${"b".repeat(57)}`,
      }),
    );
    resolveBlocked?.("block");
    await blockedEventPromise;

    expect(authorizeSender).toHaveBeenCalledTimes(2);
    expect(mockState.decrypt).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(0);

    bus.close();
  });

  it("rate limits repeated invalid signatures before authorization work fans out", async () => {
    mockState.verifyEvent.mockReturnValue(false);
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "allow" as const);
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      authorizeSender,
      onMetric: () => {},
      guardPolicy: {
        rateLimit: {
          windowMs: 60_000,
          maxGlobalPerWindow: 1,
          maxPerSenderPerWindow: 10,
          maxTrackedSenderKeys: 32,
        },
      },
    });

    await emitEvent(createEvent({ id: "invalid-1" }));
    await emitEvent(createEvent({ id: "invalid-2" }));

    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(authorizeSender).not.toHaveBeenCalled();
    expect(bus.getMetrics().eventsRejected.invalidSignature).toBe(1);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(1);

    bus.close();
  });

  it("counts oversized ciphertext toward the global inbound rate limit", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      onMetric: () => {},
      guardPolicy: {
        maxCiphertextBytes: 4,
        rateLimit: {
          windowMs: 60_000,
          maxGlobalPerWindow: 1,
          maxPerSenderPerWindow: 10,
          maxTrackedSenderKeys: 32,
        },
      },
    });

    await emitEvent(
      createEvent({
        id: "oversized-global-1",
        pubkey: `sender1${"a".repeat(57)}`,
        content: "ciphertext-too-large",
      }),
    );
    await emitEvent(
      createEvent({
        id: "oversized-global-2",
        pubkey: `sender2${"b".repeat(57)}`,
        content: "ciphertext-too-large",
      }),
    );

    expect(bus.getMetrics().eventsRejected.oversizedCiphertext).toBe(1);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(1);
    expect(mockState.verifyEvent).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    bus.close();
  });

  it("does not spend per-sender buckets on oversized ciphertext before verification", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      onMetric: () => {},
      guardPolicy: {
        maxCiphertextBytes: 4,
        rateLimit: {
          windowMs: 60_000,
          maxGlobalPerWindow: 10,
          maxPerSenderPerWindow: 1,
          maxTrackedSenderKeys: 32,
        },
      },
    });

    await emitEvent(
      createEvent({
        id: "oversized-sender-1",
        content: "ciphertext-too-large",
      }),
    );
    await emitEvent(
      createEvent({
        id: "oversized-sender-2",
        content: "ciphertext-too-large",
      }),
    );
    await emitEvent(
      createEvent({
        id: "allowed-after-oversized",
        content: "ok",
      }),
    );

    expect(bus.getMetrics().eventsRejected.oversizedCiphertext).toBe(2);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(0);
    expect(mockState.verifyEvent).toHaveBeenCalledTimes(1);
    expect(mockState.decrypt).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);

    bus.close();
  });

  it("rejects far-future events before crypto", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      onMetric: () => {},
    });

    await emitEvent(
      createEvent({
        created_at: Math.floor(Date.now() / 1000) + 600,
      }),
    );

    const snapshot = bus.getMetrics();
    expect(snapshot.eventsRejected.future).toBe(1);
    expect(mockState.verifyEvent).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    bus.close();
  });

  it("rejects oversized ciphertext before verify/decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      onMetric: () => {},
    });

    await emitEvent(
      createEvent({
        content: "x".repeat(20_000),
      }),
    );

    const snapshot = bus.getMetrics();
    expect(snapshot.eventsRejected.oversizedCiphertext).toBe(1);
    expect(mockState.verifyEvent).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    bus.close();
  });
});
