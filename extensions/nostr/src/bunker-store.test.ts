import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  connectBunker,
  disconnectBunker,
  getBunkerConnection,
  getFirstBunkerConnection,
  getAllBunkerConnections,
  isBunkerConnected,
  hasAnyBunkerConnected,
  resetClientSecretKey,
  loadPersistedState,
  savePersistedState,
  stripBunkerSecret,
  getClientSecretKey,
  clearPersistedState,
} from "./bunker-store.js";

// Mock runtime
vi.mock("./runtime.js", () => ({
  getNostrRuntime: vi.fn(() => ({
    state: {
      resolveStateDir: vi.fn(() => "/tmp/test-clawdbot"),
    },
  })),
}));

// Mock nostr-tools/nip46
vi.mock("nostr-tools/nip46", () => {
  const mockSigner = {
    connect: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue("ack"),
    getPublicKey: vi.fn().mockResolvedValue("user123pubkey456"),
    close: vi.fn().mockResolvedValue(undefined),
    signEvent: vi.fn(),
  };

  return {
    parseBunkerInput: vi.fn(),
    BunkerSigner: {
      fromBunker: vi.fn().mockReturnValue(mockSigner),
    },
  };
});

// Mock nostr-tools
vi.mock("nostr-tools", () => ({
  generateSecretKey: vi.fn().mockReturnValue(new Uint8Array(32).fill(1)),
  SimplePool: vi.fn().mockImplementation(() => ({
    publish: vi.fn().mockReturnValue([Promise.resolve("ok")]),
    get: vi.fn().mockResolvedValue(null), // Default: no relay list found
  })),
}));

// Mock nostr-tools/kinds
vi.mock("nostr-tools/kinds", () => ({
  RelayList: 10002,
}));

// Mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

describe("bunker-store", () => {
  let mockParseBunkerInput: ReturnType<typeof vi.fn>;
  let mockBunkerSigner: {
    fromBunker: ReturnType<typeof vi.fn>;
  };
  let mockSignerInstance: {
    connect: ReturnType<typeof vi.fn>;
    sendRequest: ReturnType<typeof vi.fn>;
    getPublicKey: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    signEvent: ReturnType<typeof vi.fn>;
  };

  const accountId = "test-account";
  const bunkerIndex = 0;

  beforeEach(async () => {
    // Reset state between tests
    await disconnectBunker(accountId, bunkerIndex);
    resetClientSecretKey(accountId, bunkerIndex);
    vi.clearAllMocks();

    // Get mocked modules
    const nip46 = await import("nostr-tools/nip46");
    mockParseBunkerInput = nip46.parseBunkerInput as ReturnType<typeof vi.fn>;
    mockBunkerSigner = nip46.BunkerSigner as unknown as {
      fromBunker: ReturnType<typeof vi.fn>;
    };
    mockSignerInstance = mockBunkerSigner.fromBunker() as {
      connect: ReturnType<typeof vi.fn>;
      sendRequest: ReturnType<typeof vi.fn>;
      getPublicKey: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      signEvent: ReturnType<typeof vi.fn>;
    };
  });

  afterEach(async () => {
    await disconnectBunker(accountId, bunkerIndex);
  });

  describe("connectBunker", () => {
    it("connects successfully with valid bunker URL", async () => {
      const mockPool = {
        publish: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      } as unknown as import("nostr-tools").SimplePool;
      const bunkerUrl = "bunker://fa984bd7deb8@wss://relay.example.com?secret=abc123";

      mockParseBunkerInput.mockResolvedValue({
        pubkey: "fa984bd7deb8",
        relays: ["wss://relay.example.com"],
        secret: "abc123",
      });
      mockSignerInstance.sendRequest.mockResolvedValue("ack");
      mockSignerInstance.getPublicKey.mockResolvedValue("user123pubkey456");

      const { connection: conn, isReconnect } = await connectBunker({
        accountId,
        bunkerIndex,
        bunkerUrl,
        pool: mockPool,
      });

      expect(conn.userPubkey).toBe("user123pubkey456");
      expect(conn.bunkerPubkey).toBe("fa984bd7deb8");
      expect(conn.relays).toEqual(["wss://relay.example.com"]);
      expect(conn.userWriteRelays).toEqual([]); // No relay list found
      expect(conn.connectedAt).toBeLessThanOrEqual(Date.now());
      expect(conn.accountId).toBe(accountId);
      expect(conn.bunkerIndex).toBe(bunkerIndex);
      expect(isReconnect).toBe(false);
    });

    it("fetches user write relays from NIP-65 relay list", async () => {
      const mockPool = {
        publish: vi.fn(),
        get: vi.fn().mockResolvedValue({
          kind: 10002,
          tags: [
            ["r", "wss://write.relay.com", "write"],
            ["r", "wss://both.relay.com"], // no marker = both read/write
            ["r", "wss://read.relay.com", "read"], // read-only, should be excluded from write
          ],
        }),
      } as unknown as import("nostr-tools").SimplePool;
      const bunkerUrl = "bunker://fa984bd7deb8@wss://relay.example.com?secret=abc123";

      mockParseBunkerInput.mockResolvedValue({
        pubkey: "fa984bd7deb8",
        relays: ["wss://relay.example.com"],
        secret: "abc123",
      });
      mockSignerInstance.sendRequest.mockResolvedValue("ack");
      mockSignerInstance.getPublicKey.mockResolvedValue("user123pubkey456");

      const { connection: conn } = await connectBunker({
        accountId,
        bunkerIndex,
        bunkerUrl,
        pool: mockPool,
      });

      expect(conn.userWriteRelays).toEqual([
        "wss://write.relay.com",
        "wss://both.relay.com",
      ]);
      expect(conn.userReadRelays).toEqual([
        "wss://both.relay.com",
        "wss://read.relay.com",
      ]);
    });

    it("throws on invalid bunker URL (parseBunkerInput returns null)", async () => {
      const mockPool = {
        publish: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      } as unknown as import("nostr-tools").SimplePool;

      mockParseBunkerInput.mockResolvedValue(null);

      await expect(
        connectBunker({ accountId, bunkerIndex, bunkerUrl: "invalid-url", pool: mockPool })
      ).rejects.toThrow("Invalid bunker URL format");
    });

    it("throws when bunker URL has no relays", async () => {
      const mockPool = {
        publish: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      } as unknown as import("nostr-tools").SimplePool;

      mockParseBunkerInput.mockResolvedValue({
        pubkey: "fa984bd7deb8",
        relays: [],
        secret: "abc123",
      });

      await expect(
        connectBunker({ accountId, bunkerIndex, bunkerUrl: "bunker://fa984bd7deb8", pool: mockPool })
      ).rejects.toThrow("No relays in bunker URL");
    });

    it("handles 'already connected' error gracefully", async () => {
      const mockPool = {
        publish: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      } as unknown as import("nostr-tools").SimplePool;
      const bunkerUrl = "bunker://fa984bd7deb8@wss://relay.example.com?secret=abc123";

      mockParseBunkerInput.mockResolvedValue({
        pubkey: "fa984bd7deb8",
        relays: ["wss://relay.example.com"],
        secret: "abc123",
      });
      // First call with secret fails with "already connected"
      mockSignerInstance.sendRequest
        .mockRejectedValueOnce(new Error("already connected"))
        .mockResolvedValueOnce("ack"); // Retry without secret succeeds
      mockSignerInstance.getPublicKey.mockResolvedValue("user123pubkey456");

      const { connection: conn, isReconnect } = await connectBunker({
        accountId,
        bunkerIndex,
        bunkerUrl,
        pool: mockPool,
      });

      expect(conn.userPubkey).toBe("user123pubkey456");
      expect(isReconnect).toBe(true); // Should be marked as reconnect
      // Should have been called twice: once with secret, once without
      expect(mockSignerInstance.sendRequest).toHaveBeenCalledTimes(2);
    });

    it("retries without secret on 'invalid secret' error", async () => {
      const mockPool = {
        publish: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      } as unknown as import("nostr-tools").SimplePool;
      const bunkerUrl = "bunker://fa984bd7deb8@wss://relay.example.com?secret=abc123";

      mockParseBunkerInput.mockResolvedValue({
        pubkey: "fa984bd7deb8",
        relays: ["wss://relay.example.com"],
        secret: "abc123",
      });
      // First call with secret fails with "invalid secret"
      mockSignerInstance.sendRequest
        .mockRejectedValueOnce(new Error("invalid secret"))
        .mockResolvedValueOnce("ack"); // Retry without secret succeeds
      mockSignerInstance.getPublicKey.mockResolvedValue("user123pubkey456");

      const { connection: conn, isReconnect } = await connectBunker({
        accountId,
        bunkerIndex,
        bunkerUrl,
        pool: mockPool,
      });

      expect(conn.userPubkey).toBe("user123pubkey456");
      expect(isReconnect).toBe(true);
      expect(mockSignerInstance.sendRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe("getBunkerConnection", () => {
    it("returns null when not connected", () => {
      expect(getBunkerConnection(accountId, bunkerIndex)).toBeNull();
    });

    it("returns connection after connecting", async () => {
      const mockPool = {
        publish: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      } as unknown as import("nostr-tools").SimplePool;

      mockParseBunkerInput.mockResolvedValue({
        pubkey: "test-bunker",
        relays: ["wss://relay.example.com"],
        secret: "secret",
      });
      mockSignerInstance.sendRequest.mockResolvedValue("ack");
      mockSignerInstance.getPublicKey.mockResolvedValue("test-user-pubkey");

      await connectBunker({ accountId, bunkerIndex, bunkerUrl: "bunker://test", pool: mockPool });

      const conn = getBunkerConnection(accountId, bunkerIndex);
      expect(conn).not.toBeNull();
      expect(conn?.userPubkey).toBe("test-user-pubkey");
    });
  });

  describe("getFirstBunkerConnection", () => {
    it("returns null when no bunker connected", () => {
      expect(getFirstBunkerConnection(accountId)).toBeNull();
    });

    it("returns the first connected bunker", async () => {
      const mockPool = {
        publish: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      } as unknown as import("nostr-tools").SimplePool;

      mockParseBunkerInput.mockResolvedValue({
        pubkey: "test-bunker",
        relays: ["wss://relay.example.com"],
        secret: "secret",
      });
      mockSignerInstance.sendRequest.mockResolvedValue("ack");
      mockSignerInstance.getPublicKey.mockResolvedValue("test-user-pubkey");

      await connectBunker({ accountId, bunkerIndex: 0, bunkerUrl: "bunker://test", pool: mockPool });

      const conn = getFirstBunkerConnection(accountId);
      expect(conn).not.toBeNull();
      expect(conn?.bunkerIndex).toBe(0);
    });
  });

  describe("getAllBunkerConnections", () => {
    it("returns empty array when no bunkers connected", () => {
      expect(getAllBunkerConnections(accountId)).toEqual([]);
    });
  });

  describe("disconnectBunker", () => {
    it("returns false when no connection exists", async () => {
      const result = await disconnectBunker(accountId, bunkerIndex);
      expect(result).toBe(false);
    });

    it("returns true and cleans up when connected", async () => {
      const mockPool = {
        publish: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      } as unknown as import("nostr-tools").SimplePool;

      mockParseBunkerInput.mockResolvedValue({
        pubkey: "test-bunker",
        relays: ["wss://relay.example.com"],
        secret: "secret",
      });
      mockSignerInstance.sendRequest.mockResolvedValue("ack");
      mockSignerInstance.getPublicKey.mockResolvedValue("test-user-pubkey");

      await connectBunker({ accountId, bunkerIndex, bunkerUrl: "bunker://test", pool: mockPool });
      expect(isBunkerConnected(accountId, bunkerIndex)).toBe(true);

      const result = await disconnectBunker(accountId, bunkerIndex);

      expect(result).toBe(true);
      expect(isBunkerConnected(accountId, bunkerIndex)).toBe(false);
      expect(getBunkerConnection(accountId, bunkerIndex)).toBeNull();
      expect(mockSignerInstance.close).toHaveBeenCalled();
    });
  });

  describe("isBunkerConnected", () => {
    it("returns false when not connected", () => {
      expect(isBunkerConnected(accountId, bunkerIndex)).toBe(false);
    });

    it("returns true when connected", async () => {
      const mockPool = {
        publish: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      } as unknown as import("nostr-tools").SimplePool;

      mockParseBunkerInput.mockResolvedValue({
        pubkey: "test-bunker",
        relays: ["wss://relay.example.com"],
        secret: "secret",
      });
      mockSignerInstance.sendRequest.mockResolvedValue("ack");
      mockSignerInstance.getPublicKey.mockResolvedValue("test-user-pubkey");

      await connectBunker({ accountId, bunkerIndex, bunkerUrl: "bunker://test", pool: mockPool });

      expect(isBunkerConnected(accountId, bunkerIndex)).toBe(true);
    });
  });

  describe("hasAnyBunkerConnected", () => {
    it("returns false when no bunker connected", () => {
      expect(hasAnyBunkerConnected(accountId)).toBe(false);
    });

    it("returns true when any bunker connected", async () => {
      const mockPool = {
        publish: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      } as unknown as import("nostr-tools").SimplePool;

      mockParseBunkerInput.mockResolvedValue({
        pubkey: "test-bunker",
        relays: ["wss://relay.example.com"],
        secret: "secret",
      });
      mockSignerInstance.sendRequest.mockResolvedValue("ack");
      mockSignerInstance.getPublicKey.mockResolvedValue("test-user-pubkey");

      await connectBunker({ accountId, bunkerIndex, bunkerUrl: "bunker://test", pool: mockPool });

      expect(hasAnyBunkerConnected(accountId)).toBe(true);
    });
  });

  describe("stripBunkerSecret", () => {
    it("strips secret from bunker URL", () => {
      const url = "bunker://abc123?relay=wss://r.com&secret=mysecret";
      const result = stripBunkerSecret(url);
      // Secret should be removed, relay should remain
      expect(result).not.toContain("secret");
      expect(result).toContain("relay=");
      expect(result).toContain("bunker://abc123");
    });

    it("returns URL without secret if no secret present", () => {
      const url = "bunker://abc123?relay=wss://r.com";
      const result = stripBunkerSecret(url);
      // Should be essentially unchanged (maybe URL-normalized)
      expect(result).not.toContain("secret");
      expect(result).toContain("relay=");
      expect(result).toContain("bunker://abc123");
    });

    it("handles invalid URLs gracefully", () => {
      const url = "not-a-valid-url";
      expect(stripBunkerSecret(url)).toBe("not-a-valid-url");
    });
  });
});
