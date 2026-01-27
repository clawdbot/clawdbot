import { describe, expect, it, vi } from "vitest";

const TEST_HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_PUBKEY = "f".repeat(64);

let lastPool: {
  publish: ReturnType<typeof vi.fn>;
  subscribeMany: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock("nostr-tools", async () => {
  const actual = await vi.importActual<typeof import("nostr-tools")>("nostr-tools");
  class MockPool {
    publish = vi.fn();
    subscribeMany = vi.fn(() => ({ close: vi.fn() }));
    constructor() {
      lastPool = this as unknown as {
        publish: ReturnType<typeof vi.fn>;
        subscribeMany: ReturnType<typeof vi.fn>;
      };
    }
  }
  return {
    ...actual,
    SimplePool: MockPool,
  };
});

vi.mock("nostr-tools/nip04", async () => {
  return {
    encrypt: vi.fn(async () => "cipher"),
    decrypt: vi.fn(async () => "plain"),
  };
});

vi.mock("./nostr-state-store.js", () => {
  return {
    readNostrBusState: vi.fn(async () => null),
    writeNostrBusState: vi.fn(async () => undefined),
    computeSinceTimestamp: vi.fn(() => 0),
    readNostrProfileState: vi.fn(async () => null),
    writeNostrProfileState: vi.fn(async () => undefined),
  };
});

describe("startNostrBus publish handling", () => {
  it("awaits publish rejections for DMs without unhandled rejection", async () => {
    const { startNostrBus } = await import("./nostr-bus.js");
    const onError = vi.fn();
    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: ["wss://relay.test"],
      onMessage: async () => {},
      onError,
    });

    expect(lastPool).not.toBeNull();
    lastPool?.publish.mockReturnValue([Promise.reject(new Error("rate-limited"))]);

    let unhandled: unknown;
    process.once("unhandledRejection", (reason) => {
      unhandled = reason;
    });

    await expect(bus.sendDm(TEST_PUBKEY, "hi")).rejects.toThrow("rate-limited");
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).toBeUndefined();
    expect(onError).toHaveBeenCalled();

    bus.close();
  });

  it("does not throw on typing publish failures", async () => {
    const { startNostrBus } = await import("./nostr-bus.js");
    const onError = vi.fn();
    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: ["wss://relay.test"],
      onMessage: async () => {},
      onError,
    });

    expect(lastPool).not.toBeNull();
    lastPool?.publish.mockReturnValue([Promise.reject(new Error("rate-limited"))]);

    let unhandled: unknown;
    process.once("unhandledRejection", (reason) => {
      unhandled = reason;
    });

    await expect(bus.sendTypingStart(TEST_PUBKEY)).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).toBeUndefined();
    expect(onError).toHaveBeenCalled();

    bus.close();
  });
});
