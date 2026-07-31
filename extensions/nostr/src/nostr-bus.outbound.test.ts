// Nostr tests cover outbound relay failover behavior.
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

const BAD_RELAY = "wss://bad-relay.example";
const GOOD_RELAY = "wss://good-relay.example";
const RECIPIENT_PUBKEY = "b".repeat(64);

const mocks = vi.hoisted(() => ({
  poolPublish: vi.fn(),
  close: vi.fn(),
}));

vi.mock("nostr-tools", () => {
  class MockSimplePool {
    subscribeMany() {
      return { close: vi.fn() };
    }

    publish(relays: string[]) {
      return mocks.poolPublish(relays);
    }

    close(relays: string[]) {
      mocks.close(relays);
    }
  }

  return {
    SimplePool: MockSimplePool,
    finalizeEvent: vi.fn((event: unknown) => event),
    getPublicKey: vi.fn(() => "a".repeat(64)),
    verifyEvent: vi.fn(() => true),
    nip19: {
      decode: vi.fn(),
      npubEncode: vi.fn(),
    },
  };
});

vi.mock("nostr-tools/nip04", () => ({
  decrypt: vi.fn(),
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
  publishProfile: vi.fn(),
}));

let stateDir = "";

describe("Nostr outbound relay failover", () => {
  beforeEach(async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-outbound-"));
    stateDir = await fs.realpath(created);
    const ingressQueue = createChannelIngressQueueForTests<Record<string, unknown>>({
      channelId: "nostr",
      accountId: "default",
      stateDir,
    });
    setNostrRuntime({
      state: {
        openChannelIngressQueue: () => ingressQueue,
      },
    } as unknown as PluginRuntime);
    mocks.poolPublish
      .mockReset()
      .mockImplementation((relays: string[]) => [
        Promise.resolve(
          relays[0] === BAD_RELAY ? "connection failure: connection failed" : "saved",
        ),
      ]);
    mocks.close.mockReset();
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("tries the next relay when the first relay cannot connect", async () => {
    const bus = await startNostrBus({
      privateKey: "1".repeat(64),
      relays: [BAD_RELAY, GOOD_RELAY],
      onMessage: vi.fn(async () => {}),
      onMetric: () => {},
    });

    await bus.sendDm(RECIPIENT_PUBKEY, "hello");

    expect(mocks.poolPublish.mock.calls.map(([relays]) => relays)).toEqual([
      [BAD_RELAY],
      [GOOD_RELAY],
    ]);
    await bus.close();
  });

  it("preserves string connection failures when every relay fails", async () => {
    const onError = vi.fn();
    const bus = await startNostrBus({
      privateKey: "1".repeat(64),
      relays: [BAD_RELAY],
      onMessage: vi.fn(async () => {}),
      onError,
      onMetric: () => {},
    });

    await expect(bus.sendDm(RECIPIENT_PUBKEY, "hello")).rejects.toThrow(
      "Failed to publish to any relay: connection failed",
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error), `publish to ${BAD_RELAY}`);

    await bus.close();
  });
});
