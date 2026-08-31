/** @vitest-environment node */
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserGatewaySocket } from "./gateway-browser-socket.ts";

type MockSocketEvent = { code?: number; data?: unknown; reason?: string };
type MockSocketHandler = (event: MockSocketEvent) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly OPEN = 1;
  readonly close = vi.fn((code?: number, _reason?: string) => {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("invalid code", "InvalidAccessError");
    }
  });
  readonly handlers = new Map<string, MockSocketHandler[]>();
  readyState = 0;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, handler: MockSocketHandler) {
    const handlers = this.handlers.get(type) ?? [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }

  send(_data: string) {}

  emit(type: string, event: MockSocketEvent = {}) {
    for (const handler of this.handlers.get(type) ?? []) {
      handler(event);
    }
  }
}

function createHandlers() {
  return {
    open: vi.fn(),
    message: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
  };
}

describe("createBrowserGatewaySocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes a websocket that never finishes opening", async () => {
    const handlers = createHandlers();
    createBrowserGatewaySocket("wss://gateway.example", handlers);
    const socket = sockets[0];

    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.error.mock.calls[0]?.[0]).toEqual(
      new Error(
        `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
      ),
    );
    expect(socket?.close).toHaveBeenCalledOnce();

    socket?.emit("error");
    socket?.emit("close", { code: 1006, reason: "" });
    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.close).toHaveBeenCalledWith(
      1006,
      `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
    );
  });

  it("preserves a real close reason when an opening timeout also occurred", async () => {
    const handlers = createHandlers();
    createBrowserGatewaySocket("wss://gateway.example", handlers);

    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    sockets[0]?.emit("close", { code: 1006, reason: "gateway supplied a close reason" });

    expect(handlers.close).toHaveBeenCalledWith(1006, "gateway supplied a close reason");
  });

  it("clears the opening deadline after the socket opens", async () => {
    const handlers = createHandlers();
    createBrowserGatewaySocket("wss://gateway.example", handlers);
    const socket = sockets[0];

    if (socket) {
      socket.readyState = MockWebSocket.OPEN;
      socket.emit("open");
    }
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.open).toHaveBeenCalledOnce();
    expect(handlers.error).not.toHaveBeenCalled();
    expect(socket?.close).not.toHaveBeenCalled();
  });

  it("clears the opening deadline after a native transport failure", async () => {
    const handlers = createHandlers();
    createBrowserGatewaySocket("wss://gateway.example", handlers);
    const socket = sockets[0];

    socket?.emit("error");
    socket?.emit("close", { code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.error).toHaveBeenCalledWith(new Error("websocket error"));
    expect(handlers.close).toHaveBeenCalledWith(1006, "");
    expect(socket?.close).not.toHaveBeenCalled();
  });

  it("clears the opening deadline when the client closes the socket", async () => {
    const handlers = createHandlers();
    const socketAdapter = createBrowserGatewaySocket("wss://gateway.example", handlers);
    const socket = sockets[0];

    socketAdapter.close(1000, "stopped");
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(socket?.close).toHaveBeenCalledWith(1000, "stopped");
    expect(handlers.error).not.toHaveBeenCalled();
  });

  it("maps protocol policy-violation closes to the browser-safe connect failure code", () => {
    const handlers = createHandlers();
    const socketAdapter = createBrowserGatewaySocket("wss://gateway.example", handlers);

    expect(() => socketAdapter.close(1008, "connect failed")).not.toThrow();
    expect(sockets[0]?.close).toHaveBeenCalledWith(4008, "connect failed");
  });

  it.each([1000, 3000, 4000, 4008, 4013, 4999])("preserves browser-valid close code %i", (code) => {
    const handlers = createHandlers();
    const socketAdapter = createBrowserGatewaySocket("wss://gateway.example", handlers);

    expect(() => socketAdapter.close(code, "valid close")).not.toThrow();
    expect(sockets[0]?.close).toHaveBeenCalledWith(code, "valid close");
  });

  it("does not normalize other invalid browser close codes", () => {
    const handlers = createHandlers();
    const socketAdapter = createBrowserGatewaySocket("wss://gateway.example", handlers);

    expect(() => socketAdapter.close(1009, "invalid client close")).toThrow(
      expect.objectContaining({ name: "InvalidAccessError" }),
    );
  });

  it("preserves policy-violation closes received from the gateway", () => {
    const handlers = createHandlers();
    createBrowserGatewaySocket("wss://gateway.example", handlers);

    sockets[0]?.emit("close", { code: 1008, reason: "pairing required" });

    expect(handlers.close).toHaveBeenCalledWith(1008, "pairing required");
  });
});
