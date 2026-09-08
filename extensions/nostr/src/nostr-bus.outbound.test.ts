// Nostr outbound tests exercise signed EVENT/OK frames through the real pool.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getPublicKey } from "nostr-tools";
import { decrypt } from "nostr-tools/nip04";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { startNostrBus, type NostrBusHandle } from "./nostr-bus.js";
import { createNostrRelayFixture, PREFIX_ACK_REASON } from "./nostr-relay.test-harness.js";
import { setNostrRuntime } from "./runtime.js";
import { TEST_HEX_PRIVATE_KEY } from "./test-fixtures.js";

// Keep existing state persistence isolation; transport, signatures and NIP-04 are real.
vi.mock("./nostr-state-store.js", () => ({
  readNostrBusState: vi.fn(async () => null),
  writeNostrBusState: vi.fn(async () => {}),
  computeSinceTimestamp: vi.fn(() => 0),
  readNostrProfileState: vi.fn(async () => null),
  writeNostrProfileState: vi.fn(async () => {}),
}));

const RECIPIENT_KEY = new Uint8Array(32).fill(2);
const RECIPIENT_PUBKEY = getPublicKey(RECIPIENT_KEY);
let stateDir = "";
let buses: NostrBusHandle[] = [];
let relays: Array<Awaited<ReturnType<typeof createNostrRelayFixture>>> = [];

async function relay(options: Parameters<typeof createNostrRelayFixture>[0] = {}) {
  const result = await createNostrRelayFixture(options);
  relays.push(result);
  return result;
}

async function startBus(urls: string[], onError?: Parameters<typeof startNostrBus>[0]["onError"]) {
  const bus = await startNostrBus({
    privateKey: TEST_HEX_PRIVATE_KEY,
    relays: urls,
    onMessage: async () => {},
    onError,
  });
  buses.push(bus);
  return bus;
}

describe("Nostr outbound relay failover", () => {
  beforeEach(async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-outbound-"));
    stateDir = await fs.realpath(created);
    buses = [];
    relays = [];
    const ingressQueue = createChannelIngressQueueForTests<Record<string, unknown>>({
      channelId: "nostr",
      accountId: "default",
      stateDir,
    });
    setNostrRuntime({
      state: { openChannelIngressQueue: () => ingressQueue },
    } as unknown as PluginRuntime);
  });

  afterEach(async () => {
    const busResults = await Promise.allSettled(buses.map((bus) => bus.close()));
    const relayResults = await Promise.allSettled(relays.map((entry) => entry.close()));
    try {
      const failures = [...busResults, ...relayResults].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Nostr outbound cleanup failed");
      }
      for (const entry of relays) {
        expect(entry.endpoints()).toEqual({ listening: false, connections: 0, clients: 0 });
        expect(entry.errors).toEqual([]);
      }
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("accepts a real positive OK even when its reason starts with connection failure", async () => {
    const first = await relay({ reason: PREFIX_ACK_REASON });
    const second = await relay();
    const bus = await startBus([first.url, second.url]);

    const id = await bus.sendDm(RECIPIENT_PUBKEY, "hello");

    expect(first.events).toHaveLength(1);
    expect(first.acknowledgements).toEqual([["OK", id, true, PREFIX_ACK_REASON]]);
    expect(second.events).toEqual([]);
    expect(first.events[0]).toMatchObject({ id, kind: 4, tags: [["p", RECIPIENT_PUBKEY]] });
    expect(decrypt(RECIPIENT_KEY, bus.publicKey, first.events[0]!.content)).toBe("hello");
  });

  it.each([
    { failure: "negative OK", rejectUpgrade: false },
    { failure: "HTTP upgrade refusal", rejectUpgrade: true },
  ])("tries the next relay after a real $failure", async ({ rejectUpgrade }) => {
    const order: string[] = [];
    const first = await relay({ accepted: false, reason: PREFIX_ACK_REASON, rejectUpgrade });
    const second = await relay({ onEvent: () => order.push("second-event") });
    const errors: Error[] = [];
    const bus = await startBus([first.url, second.url], (error, context) => {
      if (context === `publish to ${first.url}`) {
        errors.push(error);
        order.push("first-publish-error");
      }
    });

    const id = await bus.sendDm(RECIPIENT_PUBKEY, "hello");

    expect(order).toEqual(["first-publish-error", "second-event"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("connection failure:");
    expect(first.upgradeAttempts()).toBeGreaterThan(0);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.id).toBe(id);
    expect(second.acknowledgements).toEqual([["OK", id, true, "saved"]]);
    expect(decrypt(RECIPIENT_KEY, bus.publicKey, second.events[0]!.content)).toBe("hello");
    if (rejectUpgrade) {
      expect(first.events).toEqual([]);
    } else {
      expect(first.events).toEqual(second.events);
      expect(first.acknowledgements).toEqual([["OK", id, false, PREFIX_ACK_REASON]]);
    }
  });

  it("preserves real failures when every relay rejects", async () => {
    const first = await relay({ rejectUpgrade: true });
    const second = await relay({ accepted: false, reason: PREFIX_ACK_REASON });
    const bus = await startBus([first.url, second.url]);

    await expect(bus.sendDm(RECIPIENT_PUBKEY, "hello")).rejects.toThrow(
      `Failed to publish to any relay: ${PREFIX_ACK_REASON}`,
    );

    expect(first.events).toEqual([]);
    expect(second.events).toHaveLength(1);
    expect(second.acknowledgements).toEqual([
      ["OK", second.events[0]!.id, false, PREFIX_ACK_REASON],
    ]);
  });
});
