/**
 * Unit tests for OpenAIWebSocketManager
 *
 * Uses a mock WebSocket implementation to avoid real network calls.
 * The mock simulates the ws package's EventEmitter-based API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientOptions } from "ws";
import type {
  ClientEvent,
  ErrorEvent,
  OpenAIWebSocketEvent,
  ResponseCompletedEvent,
  ResponseCreateEvent,
} from "./openai-ws-connection.js";
import { getOpenAIWebSocketErrorDetails, OpenAIWebSocketManager } from "./openai-ws-connection.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock WebSocket (hoisted so vi.mock factory can reference it)
// ─────────────────────────────────────────────────────────────────────────────

// vi.mock() factories are hoisted before ES module imports are resolved.
// vi.hoisted() allows us to define values that are available to both the
// factory AND the test body. We avoid importing EventEmitter here because
// ESM imports aren't available yet in the hoisted zone — instead we
// implement a minimal listener pattern inline.
const { MockWebSocket } = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => void;

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState: number = MockWebSocket.CONNECTING;
    url: string;
    options: ClientOptions | undefined;
    sentMessages: string[] = [];

    private _listeners: Map<string, AnyFn[]> = new Map();

    constructor(url: string, options?: ClientOptions) {
      this.url = url;
      this.options = options ?? {};
      MockWebSocket.lastInstance = this;
      MockWebSocket.instances.push(this);
    }

    // Minimal EventEmitter-compatible interface
    on(event: string, fn: AnyFn): this {
      const list = this._listeners.get(event) ?? [];
      list.push(fn);
      this._listeners.set(event, list);
      return this;
    }

    once(event: string, fn: AnyFn): this {
      const wrapper = (...args: unknown[]) => {
        this.off(event, wrapper);
        fn(...args);
      };
      return this.on(event, wrapper);
    }

    off(event: string, fn: AnyFn): this {
      const list = this._listeners.get(event) ?? [];
      this._listeners.set(
        event,
        list.filter((l) => l !== fn),
      );
      return this;
    }

    removeAllListeners(event?: string): this {
      if (event !== undefined) {
        this._listeners.delete(event);
      } else {
        this._listeners.clear();
      }
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const list = this._listeners.get(event) ?? [];
      for (const fn of list) {
        fn(...args);
      }
      return list.length > 0;
    }

    // ws-compatible send
    send(data: string): void {
      this.sentMessages.push(data);
    }

    // ws-compatible close — triggers async close event
    close(code = 1000, reason = ""): void {
      this.readyState = MockWebSocket.CLOSING;
      setImmediate(() => {
        this.readyState = MockWebSocket.CLOSED;
        this.emit("close", code, Buffer.from(reason));
      });
    }

    // ── Test helpers ──────────────────────────────────────────────────────

    simulateOpen(): void {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    }

    simulateMessage(event: unknown): void {
      this.emit("message", Buffer.from(JSON.stringify(event)));
    }

    simulateError(err: Error): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("error", err);
    }

    simulateClose(code = 1006, reason = "Connection lost"): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code, Buffer.from(reason));
    }

    static lastInstance: MockWebSocket | null = null;
    static instances: MockWebSocket[] = [];

    static reset(): void {
      MockWebSocket.lastInstance = null;
      MockWebSocket.instances = [];
    }
  }

  return { MockWebSocket };
});

// ─────────────────────────────────────────────────────────────────────────────
// Module Mock
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("ws", () => {
  // ws exports WebSocket as the default export; static constants (OPEN, etc.)
  // live on the class itself.
  return { default: MockWebSocket };
});

// ─────────────────────────────────────────────────────────────────────────────
// Type alias for the mock class (improves test readability)
// ─────────────────────────────────────────────────────────────────────────────

type MockWS = typeof MockWebSocket extends { new (...a: infer _): infer R } ? R : never;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function lastSocket(): MockWS {
  const sock = MockWebSocket.lastInstance;
  if (!sock) {
    throw new Error("No MockWebSocket instance created");
  }
  return sock;
}

function buildManager(opts?: ConstructorParameters<typeof OpenAIWebSocketManager>[0]) {
  return new OpenAIWebSocketManager({
    // Use faster backoff in tests to avoid slow timer waits
    backoffDelaysMs: [10, 20, 40, 80, 160],
    socketFactory: (url, options) => new MockWebSocket(url, options) as never,
    ...opts,
  });
}

function attachErrorCollector(manager: OpenAIWebSocketManager) {
  const errors: Error[] = [];
  manager.on("error", (e) => errors.push(e));
  return errors;
}

async function connectManagerAndGetSocket(manager: OpenAIWebSocketManager) {
  const connectPromise = manager.connect("sk-test");
  const sock = lastSocket();
  sock.simulateOpen();
  await connectPromise;
  return sock;
}

async function createConnectedManager(
  opts?: ConstructorParameters<typeof OpenAIWebSocketManager>[0],
): Promise<{ manager: OpenAIWebSocketManager; sock: MockWS }> {
  const manager = buildManager(opts);
  const sock = await connectManagerAndGetSocket(manager);
  return { manager, sock };
}

function connectIgnoringFailure(manager: OpenAIWebSocketManager): Promise<void> {
  return manager.connect("sk-test").catch(() => {
    /* ignore rejection */
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenAIWebSocketManager", () => {
  beforeEach(() => {
    MockWebSocket.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── connect() ─────────────────────────────────────────────────────────────

  describe("connect()", () => {
    it("opens a WebSocket with Bearer auth header", async () => {
      const manager = buildManager();
      const connectPromise = manager.connect("sk-test-key");

      const sock = lastSocket();
      expect(sock.url).toBe("wss://api.openai.com/v1/responses");
      expect(sock.options).toMatchObject({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test-key",
        }),
      });

      sock.simulateOpen();
      await connectPromise;
    });

    it("adds OpenClaw attribution headers on the native OpenAI websocket", async () => {
      const manager = buildManager();
      const connectPromise = manager.connect("sk-test-key");

      const sock = lastSocket();
      expect(sock.options).toMatchObject({
        headers: expect.objectContaining({
          originator: "openclaw",
          version: expect.any(String),
          "User-Agent": expect.stringMatching(/^openclaw\//),
        }),
      });

      sock.simulateOpen();
      await connectPromise;
    });

    it("merges native session headers into the websocket handshake", async () => {
      const manager = buildManager({
        headers: {
          "x-client-request-id": "session-123",
          "x-openclaw-session-id": "session-123",
        },
      });
      const connectPromise = manager.connect("sk-test-key");

      const sock = lastSocket();
      expect(sock.options).toMatchObject({
        headers: expect.objectContaining({
          "x-client-request-id": "session-123",
          "x-openclaw-session-id": "session-123",
        }),
      });

      sock.simulateOpen();
      await connectPromise;
    });

    it("does not add hidden attribution headers on custom websocket endpoints", async () => {
      const manager = buildManager({
        url: "wss://proxy.example.com/v1/responses",
      });
      const connectPromise = manager.connect("sk-test-key");

      const sock = lastSocket();
      expect(sock.options).toMatchObject({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test-key",
          "OpenAI-Beta": "responses-websocket=v1",
        }),
      });
      const headers = sock.options?.headers as Record<string, string>;
      expect(headers.originator).toBeUndefined();
      expect(headers.version).toBeUndefined();
      expect(headers["User-Agent"]).toBeUndefined();

      sock.simulateOpen();
      await connectPromise;
    });

    it("rejects insecure websocket TLS overrides", async () => {
      const manager = buildManager({
        request: {
          tls: {
            insecureSkipVerify: true,
          },
        },
      });

      await expect(manager.connect("sk-test-key")).rejects.toThrow(/insecureskipverify/i);
      expect(MockWebSocket.lastInstance).toBeNull();
    });

    it("resolves when the connection opens", async () => {
      const manager = buildManager();
      const connectPromise = manager.connect("sk-test");
      expect(manager.connectionState).toBe("connecting");
      lastSocket().simulateOpen();
      await expect(connectPromise).resolves.toBeUndefined();
      expect(manager.connectionState).toBe("open");
    });

    it("rejects when the initial connection fails (maxRetries=0)", async () => {
      const manager = buildManager({ maxRetries: 0 });
      const connectPromise = manager.connect("sk-test");

      lastSocket().simulateError(new Error("ECONNREFUSED"));

      await expect(connectPromise).rejects.toThrow("ECONNREFUSED");
    });

    it("sets isConnected() to true after open", async () => {
      const manager = buildManager();
      expect(manager.isConnected()).toBe(false);

      const connectPromise = manager.connect("sk-test");
      lastSocket().simulateOpen();
      await connectPromise;

      expect(manager.isConnected()).toBe(true);
    });

    it("uses the custom URL when provided", async () => {
      const manager = buildManager({ url: "ws://localhost:9999/v1/responses" });
      const connectPromise = manager.connect("sk-test");

      expect(lastSocket().url).toBe("ws://localhost:9999/v1/responses");
      lastSocket().simulateOpen();
      await connectPromise;
    });
  });

  // ─── send() ────────────────────────────────────────────────────────────────

  describe("send()", () => {
    it("sends a JSON-serialized event over the socket", async () => {
      const { manager, sock } = await createConnectedManager();

      const event: ResponseCreateEvent = {
        type: "response.create",
        model: "gpt-5.4",
        input: [{ type: "message", role: "user", content: "Hello" }],
      };
      manager.send(event);

      expect(sock.sentMessages).toHaveLength(1);
      expect(JSON.parse(sock.sentMessages[0] ?? "{}")).toEqual(event);
    });

    it("throws if the connection is not open", () => {
      const manager = buildManager();
      const event: ClientEvent = {
        type: "response.create",
        model: "gpt-5.4",
      };
      expect(() => manager.send(event)).toThrow(/cannot send/);
    });

    it("includes previous_response_id when provided", async () => {
      const { manager, sock } = await createConnectedManager();

      const event: ResponseCreateEvent = {
        type: "response.create",
        model: "gpt-5.4",
        previous_response_id: "resp_abc123",
        input: [{ type: "function_call_output", call_id: "call_1", output: "result" }],
      };
      manager.send(event);

      const sent = JSON.parse(sock.sentMessages[0] ?? "{}") as ResponseCreateEvent;
      expect(sent.previous_response_id).toBe("resp_abc123");
    });
  });

  // ─── onMessage() ───────────────────────────────────────────────────────────

  describe("onMessage()", () => {
    it("calls handler for each incoming message", async () => {
      const { manager, sock } = await createConnectedManager();

      const received: OpenAIWebSocketEvent[] = [];
      manager.onMessage((e) => received.push(e));

      const deltaEvent: OpenAIWebSocketEvent = {
        type: "response.output_text.delta",
        item_id: "item_1",
        output_index: 0,
        content_index: 0,
        delta: "Hello",
      };
      sock.simulateMessage(deltaEvent);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(deltaEvent);
    });

    it("returns an unsubscribe function that stops delivery", async () => {
      const { manager, sock } = await createConnectedManager();

      const received: OpenAIWebSocketEvent[] = [];
      const unsubscribe = manager.onMessage((e) => received.push(e));

      sock.simulateMessage({ type: "response.in_progress", response: makeResponse("r1") });
      unsubscribe();
      sock.simulateMessage({ type: "response.in_progress", response: makeResponse("r2") });

      expect(received).toHaveLength(1);
    });

    it("supports multiple simultaneous handlers", async () => {
      const { manager, sock } = await createConnectedManager();

      const calls: number[] = [];
      manager.onMessage(() => calls.push(1));
      manager.onMessage(() => calls.push(2));

      sock.simulateMessage({ type: "response.in_progress", response: makeResponse("r1") });

      expect(calls.toSorted((a, b) => a - b)).toEqual([1, 2]);
    });
  });

  // ─── previousResponseId ────────────────────────────────────────────────────

  describe("previousResponseId", () => {
    it("starts as null", () => {
      expect(new OpenAIWebSocketManager().previousResponseId).toBeNull();
    });

    it("is updated when a response.completed event is received", async () => {
      const { manager, sock } = await createConnectedManager();

      const completedEvent: ResponseCompletedEvent = {
        type: "response.completed",
        response: makeResponse("resp_done_42", "completed"),
      };
      sock.simulateMessage(completedEvent);

      expect(manager.previousResponseId).toBe("resp_done_42");
    });

    it("tracks the most recent completed response", async () => {
      const { manager, sock } = await createConnectedManager();

      sock.simulateMessage({
        type: "response.completed",
        response: makeResponse("resp_1", "completed"),
      });
      sock.simulateMessage({
        type: "response.completed",
        response: makeResponse("resp_2", "completed"),
      });

      expect(manager.previousResponseId).toBe("resp_2");
    });

    it("is not updated for non-completed events", async () => {
      const { manager, sock } = await createConnectedManager();

      sock.simulateMessage({ type: "response.in_progress", response: makeResponse("resp_x") });

      expect(manager.previousResponseId).toBeNull();
    });
  });

  // ─── isConnected() ─────────────────────────────────────────────────────────

  describe("isConnected()", () => {
    it("returns false before connect", () => {
      expect(buildManager().isConnected()).toBe(false);
    });

    it("returns true while open", async () => {
      const manager = buildManager();
      const p = manager.connect("sk-test");
      lastSocket().simulateOpen();
      await p;
      expect(manager.isConnected()).toBe(true);
    });

    it("returns false after close()", async () => {
      const manager = buildManager();
      const p = manager.connect("sk-test");
      lastSocket().simulateOpen();
      await p;
      manager.close();
      expect(manager.isConnected()).toBe(false);
    });
  });

  // ─── close() ───────────────────────────────────────────────────────────────

  describe("close()", () => {
    it("marks the manager as disconnected", async () => {
      const manager = buildManager();
      const p = manager.connect("sk-test");
      lastSocket().simulateOpen();
      await p;

      manager.close();

      expect(manager.isConnected()).toBe(false);
    });

    it("prevents reconnect after explicit close", async () => {
      const manager = buildManager();
      const p = manager.connect("sk-test");
      const sock = lastSocket();
      sock.simulateOpen();
      await p;

      const socketCountBefore = MockWebSocket.instances.length;
      manager.close();

      // Simulate a network drop — should NOT trigger reconnect
      sock.simulateClose(1006, "Network error");
      await vi.runAllTimersAsync();

      expect(MockWebSocket.instances.length).toBe(socketCountBefore);
    });

    it("is safe to call before connect()", () => {
      const manager = buildManager();
      expect(manager.close()).toBeUndefined();
      expect(manager.connectionState).toBe("closed");
    });
  });

  // ─── Auto-reconnect ────────────────────────────────────────────────────────

  describe("auto-reconnect", () => {
    it("reconnects on unexpected close", async () => {
      const manager = buildManager({ backoffDelaysMs: [10, 20, 40, 80, 160] });
      const p = manager.connect("sk-test");
      lastSocket().simulateOpen();
      await p;

      const sock1 = lastSocket();
      const instancesBefore = MockWebSocket.instances.length;

      // Simulate a network drop
      sock1.simulateClose(1006, "Network error");
      expect(manager.connectionState).toBe("reconnecting");
      expect(manager.lastCloseInfo).toEqual({
        code: 1006,
        reason: "Network error",
        retryable: true,
      });

      // Advance time to trigger first retry (10ms delay)
      await vi.advanceTimersByTimeAsync(15);

      // A new socket should have been created
      expect(MockWebSocket.instances.length).toBeGreaterThan(instancesBefore);
      expect(lastSocket()).not.toBe(sock1);
    });

    it("does not reconnect on non-retryable close codes", async () => {
      const manager = buildManager({ backoffDelaysMs: [10, 20] });
      const p = manager.connect("sk-test");
      lastSocket().simulateOpen();
      await p;

      const sock = lastSocket();
      const instancesBefore = MockWebSocket.instances.length;
      sock.simulateClose(1008, "policy violation");

      await vi.advanceTimersByTimeAsync(25);

      expect(MockWebSocket.instances.length).toBe(instancesBefore);
      expect(manager.connectionState).toBe("closed");
      expect(manager.lastCloseInfo).toEqual({
        code: 1008,
        reason: "policy violation",
        retryable: false,
      });
    });

    it("stops retrying after maxRetries", async () => {
      const manager = buildManager({ maxRetries: 2, backoffDelaysMs: [5, 5] });
      const p = manager.connect("sk-test");
      lastSocket().simulateOpen();
      await p;

      const errors: Error[] = [];
      manager.on("error", (e) => errors.push(e));

      // Drop repeatedly — each reconnect attempt also drops immediately
      for (let i = 0; i < 4; i++) {
        lastSocket().simulateClose(1006, "drop");
        await vi.advanceTimersByTimeAsync(20);
      }

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("max reconnect retries"),
          }),
        ]),
      );
    });

    it("does not double-count retries when error and close both fire on a reconnect attempt", async () => {
      // In the real `ws` library, a failed connection fires "error" followed
      // by "close". Previously, both the onClose handler AND the promise
      // .catch() in _scheduleReconnect called _scheduleReconnect(), which
      // double-incremented retryCount and exhausted the retry budget
      // prematurely (e.g. 3 retries became ~1-2 actual attempts).
      const manager = buildManager({ maxRetries: 3, backoffDelaysMs: [5, 5, 5] });
      const errors = attachErrorCollector(manager);
      const p = manager.connect("sk-test");
      lastSocket().simulateOpen();
      await p;

      // Drop the established connection — triggers first reconnect schedule
      lastSocket().simulateClose(1006, "Network error");

      // Advance past first retry delay — a new socket is created
      await vi.advanceTimersByTimeAsync(10);
      const sock2 = lastSocket();

      // Simulate a realistic failure: error fires first, then close follows.
      sock2.simulateError(new Error("ECONNREFUSED"));
      sock2.simulateClose(1006, "Connection failed");

      // Advance past second retry delay — another socket should be created
      // because we've only used 2 retries (not 3 from double-counting).
      await vi.advanceTimersByTimeAsync(10);
      const sock3 = lastSocket();
      expect(sock3).not.toBe(sock2);

      // Third attempt also fails with error+close
      sock3.simulateError(new Error("ECONNREFUSED"));
      sock3.simulateClose(1006, "Connection failed");

      // Advance past third retry delay — one more attempt (retry 3 of 3)
      await vi.advanceTimersByTimeAsync(10);
      const sock4 = lastSocket();
      expect(sock4).not.toBe(sock3);

      // Fourth socket also fails — now retries should be exhausted (3/3)
      sock4.simulateError(new Error("ECONNREFUSED"));
      sock4.simulateClose(1006, "Connection failed");
      await vi.advanceTimersByTimeAsync(10);

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("max reconnect retries"),
          }),
        ]),
      );
    });

    it("resets retry count after a successful reconnect", async () => {
      const manager = buildManager({ maxRetries: 3, backoffDelaysMs: [5, 10, 20] });
      const p = manager.connect("sk-test");
      lastSocket().simulateOpen();
      await p;

      // Drop and let first retry succeed
      lastSocket().simulateClose(1006, "drop");
      await vi.advanceTimersByTimeAsync(10);
      lastSocket().simulateOpen(); // second socket opens successfully

      const socketCountAfterReconnect = MockWebSocket.instances.length;

      // Drop again — should still retry (retry count was reset)
      lastSocket().simulateClose(1006, "drop again");
      await vi.advanceTimersByTimeAsync(10);

      expect(MockWebSocket.instances.length).toBeGreaterThan(socketCountAfterReconnect);
    });
  });

  // ─── warmUp() ──────────────────────────────────────────────────────────────

  describe("warmUp()", () => {
    it("sends a response.create event with generate: false", async () => {
      const { manager, sock } = await createConnectedManager();

      manager.warmUp({ model: "gpt-5.4", instructions: "You are helpful." });

      expect(sock.sentMessages).toHaveLength(1);
      const sent = JSON.parse(sock.sentMessages[0] ?? "{}") as Record<string, unknown>;
      expect(sent["type"]).toBe("response.create");
      expect(sent["generate"]).toBe(false);
      expect(sent["model"]).toBe("gpt-5.4");
      expect(sent["input"]).toEqual([]);
      expect(sent["instructions"]).toBe("You are helpful.");
    });

    it("includes tools when provided", async () => {
      const { manager, sock } = await createConnectedManager();

      manager.warmUp({
        model: "gpt-5.4",
        tools: [{ type: "function", name: "exec", description: "Run a command" }],
      });

      const sent = JSON.parse(sock.sentMessages[0] ?? "{}") as Record<string, unknown>;
      expect(sent["tools"]).toHaveLength(1);
      expect((sent["tools"] as Array<{ name?: string }>)[0]?.name).toBe("exec");
    });
  });

  // ─── Error handling ─────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("normalizes nested websocket error payloads", () => {
      const details = getOpenAIWebSocketErrorDetails({
        type: "error",
        status: 400,
        error: {
          type: "invalid_request_error",
          code: "previous_response_not_found",
          message: "Previous response with id 'resp_abc' not found.",
          param: "previous_response_id",
        },
      } satisfies ErrorEvent);

      expect(details).toEqual({
        status: 400,
        type: "invalid_request_error",
        code: "previous_response_not_found",
        message: "Previous response with id 'resp_abc' not found.",
        param: "previous_response_id",
      });
    });

    it("emits error event on malformed JSON message", async () => {
      const manager = buildManager();
      const sock = await connectManagerAndGetSocket(manager);
      const errors = attachErrorCollector(manager);

      sock.emit("message", Buffer.from("not valid json{{{{"));

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain("failed to parse message");
    });

    it("emits error event when message has no type field", async () => {
      const manager = buildManager();
      const sock = await connectManagerAndGetSocket(manager);
      const errors = attachErrorCollector(manager);

      sock.emit("message", Buffer.from(JSON.stringify({ foo: "bar" })));

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('no "type" field');
    });

    it("emits error event on WebSocket socket error", async () => {
      const manager = buildManager({ maxRetries: 0 });
      const p = connectIgnoringFailure(manager);
      const errors = attachErrorCollector(manager);

      lastSocket().simulateError(new Error("SSL handshake failed"));
      await p;

      expect(errors.map((error) => error.message)).toContain("SSL handshake failed");
    });

    it("handles multiple successive socket errors without crashing", async () => {
      const manager = buildManager({ maxRetries: 0 });
      const p = connectIgnoringFailure(manager);
      const errors = attachErrorCollector(manager);

      // Fire two errors in quick succession — previously the second would
      // be unhandled because .once("error") removed the handler after #1.
      lastSocket().simulateError(new Error("first error"));
      lastSocket().simulateError(new Error("second error"));
      await p;

      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors.map((error) => error.message)).toEqual(
        expect.arrayContaining(["first error", "second error"]),
      );
    });
  });

  // ─── Integration: full multi-turn sequence ────────────────────────────────

  describe("full turn sequence", () => {
    it("tracks previous_response_id across turns and sends continuation correctly", async () => {
      const { manager, sock } = await createConnectedManager();

      const received: OpenAIWebSocketEvent[] = [];
      manager.onMessage((e) => received.push(e));

      // Send initial turn
      manager.send({ type: "response.create", model: "gpt-5.4", input: "Hello" });

      // Simulate streaming events from server
      sock.simulateMessage({ type: "response.created", response: makeResponse("resp_1") });
      sock.simulateMessage({
        type: "response.output_text.delta",
        item_id: "i1",
        output_index: 0,
        content_index: 0,
        delta: "Hi!",
      });
      sock.simulateMessage({
        type: "response.completed",
        response: makeResponse("resp_1", "completed"),
      });

      expect(manager.previousResponseId).toBe("resp_1");
      expect(received).toHaveLength(3);

      // Send continuation turn using the tracked previous_response_id
      manager.send({
        type: "response.create",
        model: "gpt-5.4",
        previous_response_id: manager.previousResponseId!,
        input: [{ type: "function_call_output", call_id: "call_99", output: "tool result" }],
      });

      const lastSent = JSON.parse(sock.sentMessages[1] ?? "{}") as ResponseCreateEvent;
      expect(lastSent.previous_response_id).toBe("resp_1");
      expect(lastSent.input).toEqual([
        { type: "function_call_output", call_id: "call_99", output: "tool result" },
      ]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeResponse(
  id: string,
  status: ResponseCompletedEvent["response"]["status"] = "in_progress",
): ResponseCompletedEvent["response"] {
  return {
    id,
    object: "response",
    created_at: Date.now(),
    status,
    model: "gpt-5.4",
    output: [],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}
