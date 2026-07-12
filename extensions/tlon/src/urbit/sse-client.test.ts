// Tlon tests cover sse client plugin behavior.
import { Readable } from "node:stream";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
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

    it("clamps oversized reconnect delays", () => {
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
        reconnectDelay: Number.MAX_SAFE_INTEGER,
        maxReconnectDelay: Number.MAX_SAFE_INTEGER,
      });

      expect(client.reconnectDelay).toBe(MAX_TIMER_TIMEOUT_MS);
      expect(client.maxReconnectDelay).toBe(MAX_TIMER_TIMEOUT_MS);
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
    it("logs malformed SSE JSON with an owned parser error", () => {
      const logger = { error: vi.fn() };
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
        logger,
      });

      client.processEvent("id: 1\ndata: {not json");

      expect(logger.error).toHaveBeenCalledWith(
        "Error parsing SSE event: Error: Tlon Urbit SSE event was malformed JSON",
      );
    });

    it("guards JSON.parse against oversized SSE payload to prevent OOM", () => {
      const errors: string[] = [];
      const logger = { error: (msg: string) => errors.push(msg) };
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", { logger });

      const cap = 16 * 1024 * 1024;
      // Valid JSON 1 KiB above the 16 MiB cap — size check fires before parse.
      const prefix = '{"json":{"ok":true,"x":"';
      const suffix = '"}}';
      const jsonOverhead = Buffer.byteLength(prefix + suffix, "utf8");
      const padLen = cap + 1024 - jsonOverhead;
      const hugeJson = prefix + "A".repeat(padLen) + suffix;

      client.processEvent(`id: 1\ndata: ${hugeJson}`);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(
        "Error parsing SSE event: Error: Tlon Urbit SSE payload exceeds 16 MiB limit",
      );
    });

    it("accepts SSE payload at the 16 MiB boundary", () => {
      const cap = 16 * 1024 * 1024;
      // Allocate valid JSON whose byteLength exactly equals cap.
      const prefix = '{"json":{"ok":true,"x":"';
      const suffix = '"}}';
      const jsonOverhead = Buffer.byteLength(prefix + suffix, "utf8");
      const padLen = cap - jsonOverhead;
      const hugeJson = prefix + "A".repeat(padLen) + suffix;

      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");
      const handler = vi.fn();
      client.eventHandlers.set(1, { event: handler });

      client.processEvent(`id: 1\ndata: ${hugeJson}`);
      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0]?.[0] as { ok?: boolean; x?: string } | undefined;
      expect(payload?.ok).toBe(true);
      expect(payload?.x).toHaveLength(padLen);
    });

    describe("stream buffer bounding", () => {
      it("rejects oversized stream buffer before unbounded accumulation", async () => {
        const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
          autoReconnect: false,
        });
        const oneMb = 1024 * 1024;
        const megaChunk = "x".repeat(oneMb);

        // Feed 17 chunks × 1 MiB with no \n\n — buffer exceeds 16 MiB cap.
        const stream = Readable.from(
          (async function* () {
            for (let i = 0; i < 17; i++) {
              yield megaChunk;
            }
          })(),
        );

        await expect(client.processStream(stream)).rejects.toThrow(
          "Tlon Urbit SSE stream buffer exceeded 16 MiB limit",
        );
      });

      it("drains a cross-chunk event boundary before retaining the next event", async () => {
        const cap = 16 * 1024 * 1024;
        const prefix = 'id: 1\ndata: {"json":{"value":"';
        const suffix = '"}}\n';
        const padLen = cap - Buffer.byteLength(prefix + suffix, "utf8") - 128;
        const nextValue = "b".repeat(256);
        const firstChunk = prefix + "a".repeat(padLen) + suffix;
        const secondChunk = `\nid: 1\ndata: {"json":{"value":"${nextValue}"}}\n\n`;
        expect(Buffer.byteLength(firstChunk + secondChunk, "utf8")).toBeGreaterThan(cap);

        const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
          autoReconnect: false,
        });
        const handler = vi.fn();
        client.eventHandlers.set(1, { event: handler });
        const stream = Readable.from([firstChunk, secondChunk]);

        await client.processStream(stream);
        expect(handler).toHaveBeenCalledTimes(2);
        expect((handler.mock.calls[0]?.[0] as { value?: string } | undefined)?.value).toHaveLength(
          padLen,
        );
        expect(handler.mock.calls[1]?.[0]).toEqual({ value: nextValue });
      });

      it("preserves split UTF-8 code points and split event delimiters", async () => {
        const encoded = Buffer.from('id: 1\ndata: {"json":{"text":"😀"}}\n\n');
        const emojiStart = encoded.indexOf(Buffer.from("😀"));
        const stream = Readable.from([
          encoded.subarray(0, emojiStart + 2),
          encoded.subarray(emojiStart + 2, -1),
          encoded.subarray(-1),
        ]);
        const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
          autoReconnect: false,
        });
        const handler = vi.fn();
        client.eventHandlers.set(1, { event: handler });

        await client.processStream(stream);
        expect(handler).toHaveBeenCalledWith({ text: "😀" });
      });

      it("accepts a boundary-sized event with split surrogate pair and delimiter", async () => {
        const cap = 16 * 1024 * 1024;
        const prefix = 'id: 1\ndata: {"json":{"text":"';
        const suffix = '"}}';
        const padLen = cap - Buffer.byteLength(prefix + "😀" + suffix, "utf8");
        const stream = Readable.from([
          prefix + "a".repeat(padLen) + "\uD83D",
          `\uDE00${suffix}\n`,
          "\n",
        ]);
        const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
          autoReconnect: false,
        });
        const handler = vi.fn();
        client.eventHandlers.set(1, { event: handler });

        await client.processStream(stream);
        const payload = handler.mock.calls[0]?.[0] as { text?: string } | undefined;
        expect(payload?.text).toHaveLength(padLen + 2);
        expect(payload?.text?.endsWith("😀")).toBe(true);
      });
    });

    it("ignores malformed event ids when deciding whether to ack", async () => {
      const mockUrbitFetch = vi.mocked(urbitFetch);
      mockUrbitFetch.mockResolvedValue({
        response: { ok: true, status: 200 } as unknown as Response,
        finalUrl: "https://example.com",
        release: vi.fn().mockResolvedValue(undefined),
      });
      const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");

      client.processEvent('id: 25abc\ndata: {"json":{"ok":true}}');
      await Promise.resolve();

      expect(mockUrbitFetch).not.toHaveBeenCalled();
      expect((client as unknown as { lastHeardEventId: number }).lastHeardEventId).toBe(-1);
    });

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
