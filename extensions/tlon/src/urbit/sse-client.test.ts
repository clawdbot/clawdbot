import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { urbitFetch } from "./fetch.js";
import { UrbitSSEClient } from "./sse-client.js";

// Mock urbitFetch to avoid real network calls
vi.mock("./fetch.js", () => ({
  urbitFetch: vi.fn(),
}));

// Mock channel-ops to avoid real channel operations
vi.mock("./channel-ops.js", () => ({
  ensureUrbitChannelOpen: vi.fn().mockResolvedValue(undefined),
  pokeUrbitChannel: vi.fn().mockResolvedValue(undefined),
  scryUrbitPath: vi.fn().mockResolvedValue({}),
}));

function requireFirstMockCall(calls: readonly unknown[][], label: string): unknown[] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`Expected ${label} call`);
  }
  return call;
}

describe("UrbitSSEClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("subscribe", () => {
    it("sends subscriptions added after connect", async () => {
      const mockUrbitFetch = vi.mocked(urbitFetch);
      mockUrbitFetch.mockResolvedValue({
        response: { ok: true, status: 200 } as unknown as Response,
        finalUrl: "https://example.com",
        release: vi.fn().mockResolvedValue(undefined),
      });

      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");
      // Simulate connected state
      (client as { isConnected: boolean }).isConnected = true;

      await client.subscribe({
        app: "chat",
        path: "/dm/~zod",
        event: () => {},
      });

      expect(mockUrbitFetch).toHaveBeenCalledTimes(1);
      const callArgs = requireFirstMockCall(mockUrbitFetch.mock.calls, "urbit fetch")[0] as
        | Parameters<typeof urbitFetch>[0]
        | undefined;
      if (!callArgs) {
        throw new Error("Expected urbit fetch arguments");
      }
      expect(callArgs.path).toContain("/~/channel/");
      expect(callArgs.init?.method).toBe("PUT");

      const body = JSON.parse(callArgs.init?.body as string);
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({
        id: 1,
        action: "subscribe",
        ship: "example",
        app: "chat",
        path: "/dm/~zod",
      });
    });

    it("queues subscriptions before connect", async () => {
      const mockUrbitFetch = vi.mocked(urbitFetch);

      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");
      // Not connected yet

      await client.subscribe({
        app: "chat",
        path: "/dm/~zod",
        event: () => {},
      });

      // Should not call urbitFetch since not connected
      expect(mockUrbitFetch).not.toHaveBeenCalled();
      // But subscription should be queued
      expect(client.subscriptions).toHaveLength(1);
      expect(client.subscriptions[0]).toEqual({
        id: 1,
        action: "subscribe",
        ship: "example",
        app: "chat",
        path: "/dm/~zod",
      });
    });
  });

  describe("updateCookie", () => {
    it("normalizes cookie when updating", () => {
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");

      // Cookie with extra parts that should be stripped
      client.updateCookie("urbauth-~zod=456; Path=/; HttpOnly");

      expect(client.cookie).toBe("urbauth-~zod=456");
    });

    it("handles simple cookie values", () => {
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");

      client.updateCookie("urbauth-~zod=newvalue");

      expect(client.cookie).toBe("urbauth-~zod=newvalue");
    });
  });

  describe("reconnection", () => {
    it("has autoReconnect enabled by default", () => {
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");
      expect(client.autoReconnect).toBe(true);
    });

    it("can disable autoReconnect via options", () => {
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
        autoReconnect: false,
      });
      expect(client.autoReconnect).toBe(false);
    });

    it("stores onReconnect callback", () => {
      const onReconnect = vi.fn();
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
        onReconnect,
      });
      expect(client.onReconnect).toBe(onReconnect);
    });

    it("resets reconnect attempts on successful connect", async () => {
      const mockUrbitFetch = vi.mocked(urbitFetch);

      // Mock a response that returns a readable stream
      const mockStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockUrbitFetch.mockResolvedValue({
        response: {
          ok: true,
          status: 200,
          body: mockStream,
        } as unknown as Response,
        finalUrl: "https://example.com",
        release: vi.fn().mockResolvedValue(undefined),
      });

      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
        autoReconnect: false, // Disable to prevent reconnect loop
      });
      client.reconnectAttempts = 5;

      await client.connect();

      expect(client.reconnectAttempts).toBe(0);
    });
  });

  describe("event acking", () => {
    it("tracks lastHeardEventId and ackThreshold", () => {
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");

      // Access private properties for testing
      const lastHeardEventId = (client as unknown as { lastHeardEventId: number }).lastHeardEventId;
      const ackThreshold = (client as unknown as { ackThreshold: number }).ackThreshold;

      expect(lastHeardEventId).toBe(-1);
      expect(ackThreshold).toBeGreaterThan(0);
    });
  });

  describe("constructor", () => {
    it("generates unique channel ID", () => {
      const client1 = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");
      const client2 = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");

      expect(client1.channelId).not.toBe(client2.channelId);
    });

    it("normalizes cookie in constructor", () => {
      const client = new UrbitSSEClient(
        "https://example.com",
        "urbauth-~zod=123; Path=/; HttpOnly",
      );

      expect(client.cookie).toBe("urbauth-~zod=123");
    });

    it("sets default reconnection parameters", () => {
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");

      expect(client.maxReconnectAttempts).toBe(10);
      expect(client.reconnectDelay).toBe(1000);
      expect(client.maxReconnectDelay).toBe(30000);
    });

    it("allows overriding reconnection parameters", () => {
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
        maxReconnectAttempts: 5,
        reconnectDelay: 500,
        maxReconnectDelay: 10000,
      });

      expect(client.maxReconnectAttempts).toBe(5);
      expect(client.reconnectDelay).toBe(500);
      expect(client.maxReconnectDelay).toBe(10000);
    });
  });
});
