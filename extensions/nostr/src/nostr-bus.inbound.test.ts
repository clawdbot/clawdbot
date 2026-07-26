// Nostr tests cover nostr bus.inbound plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { startNostrBus } from "./nostr-bus.js";
import { setNostrRuntime } from "./runtime.js";
import { buildResolvedNostrAccount, TEST_HEX_PRIVATE_KEY } from "./test-fixtures.js";

const BOT_PUBKEY = "b".repeat(64);

type TestNostrBusState = {
  version: 2;
  lastProcessedAt: number | null;
  gatewayStartedAt: number | null;
  recentEventIds: string[];
};

const mockState = vi.hoisted(() => ({
  handlers: [] as Array<{
    onevent: (event: Record<string, unknown>) => void | Promise<void>;
    oneose?: () => void;
    onclose?: (reason: string[]) => void;
  }>,
  subscribeMany: vi.fn(),
  publish: vi.fn((_relays: string[], _event: unknown) => [Promise.resolve("ok")]),
  close: vi.fn(),
  subscriptionClose: vi.fn(),
  finalizeEvent: vi.fn((event: unknown) => event),
  readNostrBusState: vi.fn(async (): Promise<TestNostrBusState | null> => null),
  writeNostrBusState: vi.fn(
    async (_state: { lastProcessedAt: number; gatewayStartedAt: number }) => {},
  ),
  computeSinceTimestamp: vi.fn(() => 0),
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
    onRelayConnectionSuccess?: (relay: string) => void;

    subscribeMany(
      relays: string[],
      filters: unknown,
      handlers: {
        onevent: (event: Record<string, unknown>) => void | Promise<void>;
        oneose?: () => void;
        onclose?: (reason: string[]) => void;
      },
    ) {
      mockState.subscribeMany(relays, filters, handlers);
      const relay = relays[0];
      if (relay) {
        this.onRelayConnectionSuccess?.(new URL(relay).toString());
      }
      mockState.handlers.push(handlers);
      return {
        close: mockState.subscriptionClose,
      };
    }

    publish(relays: string[], event: unknown) {
      return mockState.publish(relays, event);
    }

    close(relays: string[]) {
      mockState.close(relays);
    }
  }

  return {
    SimplePool: MockSimplePool,
    finalizeEvent: mockState.finalizeEvent,
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
  readNostrBusState: mockState.readNostrBusState,
  writeNostrBusState: mockState.writeNostrBusState,
  computeSinceTimestamp: mockState.computeSinceTimestamp,
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
    sig: "test-signature",
    ...overrides,
  };
}

async function emitEvent(event: Record<string, unknown>) {
  const handlers = mockState.handlers[0];
  if (!handlers) {
    throw new Error("missing subscription handlers");
  }
  void handlers.onevent(event);
  while (ingressTasks.length > 0) {
    await Promise.all(ingressTasks.splice(0));
  }
}

let stateDir = "";
let ingressQueue: ReturnType<typeof createChannelIngressQueueForTests<Record<string, unknown>>>;
let ingressTasks: Promise<void>[] = [];

function startTestNostrBus(options: Parameters<typeof startNostrBus>[0]) {
  return startNostrBus({
    ...options,
    trackIngressTask: (task) => ingressTasks.push(task),
  });
}

describe("startNostrBus inbound guards", () => {
  beforeEach(async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-ingress-"));
    stateDir = await fs.realpath(created);
    ingressQueue = createChannelIngressQueueForTests<Record<string, unknown>>({
      channelId: "nostr",
      accountId: "default",
      stateDir,
    });
    setNostrRuntime({
      state: {
        openChannelIngressQueue: () => ingressQueue,
      },
    } as unknown as PluginRuntime);
    mockState.handlers = [];
    ingressTasks = [];
    mockState.subscribeMany.mockClear();
    mockState.publish.mockReset();
    mockState.publish.mockReturnValue([Promise.resolve("ok")]);
    mockState.close.mockClear();
    mockState.subscriptionClose.mockReset();
    mockState.finalizeEvent.mockClear();
    mockState.readNostrBusState.mockReset();
    mockState.readNostrBusState.mockResolvedValue(null);
    mockState.writeNostrBusState.mockReset();
    mockState.writeNostrBusState.mockResolvedValue(undefined);
    mockState.computeSinceTimestamp.mockReset();
    mockState.computeSinceTimestamp.mockReturnValue(0);
    mockState.verifyEvent.mockClear();
    mockState.verifyEvent.mockReturnValue(true);
    mockState.decrypt.mockClear();
    mockState.decrypt.mockReturnValue("plaintext");
  });

  afterEach(async () => {
    mockState.handlers = [];
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("subscribes to DMs with a single Nostr filter object", async () => {
    const bus = await startTestNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage: vi.fn(async () => {}),
      onMetric: () => {},
    });

    expect(mockState.subscribeMany).toHaveBeenCalledTimes(2);
    for (const [relayList, filters] of mockState.subscribeMany.mock.calls) {
      expect(relayList).toHaveLength(1);
      expect(Array.isArray(filters)).toBe(false);
      expect(filters).toMatchObject({
        kinds: [4],
        "#p": [BOT_PUBKEY],
        since: 0,
      });
    }

    await bus.close();
  });

  it("reports successful relay connections through onConnect", async () => {
    const onConnect = vi.fn();
    const bus = await startTestNostrBus({
      ...buildResolvedNostrAccount({ relays: ["wss://relay.example"] }),
      onMessage: vi.fn(async () => {}),
      onConnect,
      onMetric: () => {},
    });

    expect(onConnect).toHaveBeenCalledOnce();
    expect(onConnect).toHaveBeenCalledWith("wss://relay.example/");

    await bus.close();
  });

  it("waits for EOSE before persisting a durable relay cursor", async () => {
    const bus = await startTestNostrBus({
      ...buildResolvedNostrAccount(),
      onMessage: vi.fn(async () => {}),
      onMetric: () => {},
    });

    await emitEvent(createEvent({ id: "cursor-newer" }));
    await emitEvent(
      createEvent({
        id: "cursor-older",
        created_at: Math.floor(Date.now() / 1000) - 60,
      }),
    );
    expect(mockState.writeNostrBusState).toHaveBeenCalledTimes(1);

    mockState.handlers[0]?.oneose?.();
    await bus.close();
    expect(mockState.writeNostrBusState).toHaveBeenCalledTimes(2);
  });

  it("rewinds unflushed cursor progress to retain a rejected event in overlap", async () => {
    mockState.readNostrBusState.mockResolvedValueOnce({
      version: 2,
      lastProcessedAt: 1_000,
      gatewayStartedAt: 900,
      recentEventIds: [],
    });
    mockState.computeSinceTimestamp.mockReturnValue(1_000);
    const bus = await startTestNostrBus({
      ...buildResolvedNostrAccount(),
      onMessage: vi.fn(async () => {}),
      onMetric: () => {},
      guardPolicy: { rateLimit: { maxGlobalPerWindow: 1 } },
    });

    await emitEvent(createEvent({ id: "cursor-durable", created_at: 2_000 }));
    mockState.handlers[0]?.oneose?.();
    await emitEvent(createEvent({ id: "cursor-rejected", created_at: 900 }));
    await bus.close();

    expect(mockState.writeNostrBusState.mock.calls.at(-1)?.[0]?.lastProcessedAt).toBe(1_020);
  });

  it("preserves the prior replay baseline until EOSE-gated progress", async () => {
    mockState.readNostrBusState.mockResolvedValueOnce({
      version: 2,
      lastProcessedAt: 1_000,
      gatewayStartedAt: 900,
      recentEventIds: [],
    });
    const bus = await startTestNostrBus({
      ...buildResolvedNostrAccount(),
      onMessage: vi.fn(async () => {}),
      onMetric: () => {},
    });

    expect(mockState.writeNostrBusState).toHaveBeenCalledWith(
      expect.objectContaining({ lastProcessedAt: 1_000, gatewayStartedAt: 900 }),
    );
    await bus.close();
  });

  it("does not advance the cursor when one relay closes before a real EOSE", async () => {
    mockState.readNostrBusState.mockResolvedValueOnce({
      version: 2,
      lastProcessedAt: 1_000,
      gatewayStartedAt: 900,
      recentEventIds: [],
    });
    mockState.computeSinceTimestamp.mockReturnValue(1_000);
    const bus = await startTestNostrBus({
      ...buildResolvedNostrAccount({
        relays: ["wss://one.example", "wss://two.example"],
      }),
      onMessage: vi.fn(async () => {}),
      onMetric: () => {},
    });

    await emitEvent(createEvent({ id: "cursor-high", created_at: 2_000 }));
    mockState.handlers[0]?.oneose?.();
    mockState.handlers[1]?.oneose?.();
    mockState.handlers[1]?.onclose?.(["relay closed"]);
    await Promise.resolve();
    await bus.close();

    expect(mockState.subscribeMany).toHaveBeenCalledTimes(2);
    expect(mockState.writeNostrBusState).toHaveBeenCalledTimes(1);
    expect(mockState.writeNostrBusState).toHaveBeenLastCalledWith(
      expect.objectContaining({ lastProcessedAt: 1_000 }),
    );
  });

  it("delivers recovered old claims while fencing old live relay events", async () => {
    const recoveredId = "recovered-old";
    const recoveredPubkey = "a".repeat(64);
    const recovered = createEvent({
      id: recoveredId,
      pubkey: recoveredPubkey,
      created_at: 1_000,
    });
    await ingressQueue.enqueue(
      recoveredId,
      { version: 1, receivedAt: Date.now(), rawEvent: JSON.stringify(recovered) },
      { laneKey: `direct:${recoveredPubkey}` },
    );
    const enqueue = vi.spyOn(ingressQueue, "enqueue");
    mockState.computeSinceTimestamp.mockReturnValue(2_000);
    const onMessage = vi.fn(async () => {});
    const bus = await startTestNostrBus({
      ...buildResolvedNostrAccount(),
      onMessage,
      onMetric: () => {},
    });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    await emitEvent(createEvent({ id: "live-old", created_at: 1_001 }));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(bus.getMetrics().eventsRejected.stale).toBe(1);

    await bus.close();
  });

  it("closes the relay pool when the bus closes", async () => {
    const bus = await startTestNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      relays: ["wss://relay.example"],
      onMessage: vi.fn(async () => {}),
      onMetric: () => {},
    });

    await bus.close();

    await vi.waitFor(() => {
      expect(mockState.close).toHaveBeenCalledWith(["wss://relay.example"]);
    });
  });

  it("closes the relay pool after the active subscription closes", async () => {
    let releaseClose = () => {};
    const subscriptionClosed = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    mockState.subscriptionClose.mockImplementationOnce(async () => {
      await subscriptionClosed;
    });
    const bus = await startTestNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      relays: ["wss://relay.example"],
      onMessage: vi.fn(async () => {}),
      onMetric: () => {},
    });

    const closing = bus.close();

    expect(mockState.subscriptionClose).toHaveBeenCalledWith("closed by caller");
    expect(mockState.close).not.toHaveBeenCalled();

    releaseClose();
    await closing;
    expect(mockState.close).toHaveBeenCalledWith(["wss://relay.example"]);
  });

  it("checks sender authorization after verify and before decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "block" as const);
    const bus = await startTestNostrBus({
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

    await bus.close();
  });

  it("terminates the relay subscription when durable admission fails", async () => {
    const appendError = new Error("sqlite unavailable");
    setNostrRuntime({
      state: {
        openChannelIngressQueue: () => ({
          ...ingressQueue,
          enqueue: vi.fn().mockRejectedValue(appendError),
        }),
      },
    } as unknown as PluginRuntime);
    const onMessage = vi.fn(async () => {});
    const onError = vi.fn();
    const bus = await startTestNostrBus({
      ...buildResolvedNostrAccount(),
      relays: ["wss://relay.example"],
      onMessage,
      onError,
      onMetric: () => {},
    });

    await emitEvent(createEvent({ id: "admission-failure" }));

    expect(mockState.subscriptionClose).toHaveBeenCalledWith("durable admission failed");
    expect(mockState.close).toHaveBeenCalledWith(["wss://relay.example"]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("durable admission failed") }),
      "durable admission for event admission-failure",
    );
    expect(onMessage).not.toHaveBeenCalled();
    await bus.close();
  });

  it("keeps relays open after rejecting one oversized raw event", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startTestNostrBus({
      ...buildResolvedNostrAccount(),
      onMessage,
      onMetric: () => {},
    });

    await emitEvent(createEvent({ id: "raw-oversized", content: "x".repeat(40_000) }));
    expect(mockState.subscriptionClose).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    await emitEvent(createEvent({ id: "after-raw-oversized", content: "ok" }));
    expect(mockState.subscriptionClose).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);

    await bus.close();
  });

  it("stops the ingress drain when startup state persistence fails", async () => {
    const startupError = new Error("state unavailable");
    const claimNext = vi.spyOn(ingressQueue, "claimNext");
    mockState.writeNostrBusState.mockRejectedValueOnce(startupError);

    await expect(
      startTestNostrBus({
        ...buildResolvedNostrAccount(),
        onMessage: vi.fn(async () => {}),
        onMetric: () => {},
      }),
    ).rejects.toThrow("state unavailable");

    const callsAfterCleanup = claimNext.mock.calls.length;
    await new Promise((resolve) => {
      setTimeout(resolve, 600);
    });
    expect(claimNext).toHaveBeenCalledTimes(callsAfterCleanup);
  });

  it("links authorization replies to the inbound NIP-04 event", async () => {
    const inboundEventId = "c".repeat(64);
    const senderPubkey = "a".repeat(64);
    const authorizeSender = vi.fn(async ({ reply }: { reply: (text: string) => Promise<void> }) => {
      await reply("pairing reply");
      return "pairing" as const;
    });
    const bus = await startTestNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      relays: ["wss://relay.example"],
      onMessage: vi.fn(async () => {}),
      authorizeSender,
      onMetric: () => {},
    });

    await emitEvent(createEvent({ id: inboundEventId, pubkey: senderPubkey }));

    expect(mockState.finalizeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: [
          ["p", senderPubkey],
          ["e", inboundEventId],
        ],
      }),
      expect.any(Uint8Array),
    );

    await bus.close();
  });

  it("rejects invalid signatures before sender authorization", async () => {
    mockState.verifyEvent.mockReturnValueOnce(false);
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "allow" as const);
    const bus = await startTestNostrBus({
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

    await bus.close();
  });

  it("dedupes replayed invalid-signature events before verify fans out again", async () => {
    mockState.verifyEvent.mockReturnValue(false);
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "allow" as const);
    const bus = await startTestNostrBus({
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

    await bus.close();
  });

  it("dedupes replayed self-message events before other guards rerun", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "allow" as const);
    const bus = await startTestNostrBus({
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

    await bus.close();
  });

  it("rate limits repeated events before decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startTestNostrBus({
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

    await bus.close();
  });

  it("bounds the global admission rate before durable append", async () => {
    const enqueue = vi.spyOn(ingressQueue, "enqueue");
    const onMessage = vi.fn(async () => {});
    const bus = await startTestNostrBus({
      ...buildResolvedNostrAccount(),
      onMessage,
      onMetric: () => {},
      guardPolicy: { rateLimit: { maxGlobalPerWindow: 1 } },
    });

    await emitEvent(createEvent({ id: "admission-rate-1" }));
    await emitEvent(createEvent({ id: "admission-rate-2" }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(1);
    expect(mockState.subscriptionClose).not.toHaveBeenCalled();

    await bus.close();
  });

  it("does not let a blocked sender starve a different verified sender", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async ({ senderPubkey }: { senderPubkey: string }) =>
      senderPubkey.startsWith("blocked") ? ("block" as const) : ("allow" as const),
    );
    const bus = await startTestNostrBus({
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

    await bus.close();
  });

  it("dedupes replayed verified events that authorization blocks", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "block" as const);
    const bus = await startTestNostrBus({
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

    await bus.close();
  });

  it("retries a replayed event after the message handler fails", async () => {
    const onMessage = vi
      .fn<(sender: string, plaintext: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const bus = await startTestNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      onMetric: () => {},
    });

    const event = createEvent({
      id: "retry-after-handler-failure",
    });

    await emitEvent(event);
    await emitEvent(event);
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2), { timeout: 3_000 });

    expect(mockState.verifyEvent).toHaveBeenCalledTimes(2);
    expect(mockState.decrypt).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(bus.getMetrics().eventsProcessed).toBe(1);

    await bus.close();
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
    const bus = await startTestNostrBus({
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

    const handlers = mockState.handlers[0];
    if (!handlers) {
      throw new Error("missing subscription handlers");
    }
    void handlers.onevent(
      createEvent({ id: "blocked-pending", pubkey: `blocked${"a".repeat(57)}` }),
    );
    await vi.waitFor(() => expect(authorizeSender).toHaveBeenCalledTimes(1));
    void handlers.onevent(
      createEvent({
        id: "allowed-during-pending-auth",
        pubkey: `allowed${"b".repeat(57)}`,
      }),
    );
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    resolveBlocked?.("block");
    await Promise.all(ingressTasks.splice(0));

    expect(authorizeSender).toHaveBeenCalledTimes(2);
    expect(mockState.decrypt).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(bus.getMetrics().eventsRejected.rateLimited).toBe(0);

    await bus.close();
  });

  it("rate limits repeated invalid signatures before authorization work fans out", async () => {
    mockState.verifyEvent.mockReturnValue(false);
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "allow" as const);
    const bus = await startTestNostrBus({
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

    await bus.close();
  });

  it("counts oversized ciphertext toward the global inbound rate limit", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startTestNostrBus({
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

    await bus.close();
  });

  it("does not spend per-sender buckets on oversized ciphertext before verification", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startTestNostrBus({
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

    await bus.close();
  });

  it("rejects far-future events before crypto", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startTestNostrBus({
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

    await bus.close();
    const persisted = mockState.writeNostrBusState.mock.calls.at(-1)?.[0];
    expect(persisted?.lastProcessedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("rejects oversized ciphertext before verify/decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startTestNostrBus({
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

    await bus.close();
  });
});
