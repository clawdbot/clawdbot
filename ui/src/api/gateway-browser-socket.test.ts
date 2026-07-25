/** @vitest-environment node */
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserGatewaySocket } from "./gateway-browser-socket.ts";

type MockSocketEvent = { code?: number; data?: unknown; reason?: string };
type MockSocketHandler = (event: MockSocketEvent) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly OPEN = 1;
  readonly close = vi.fn();
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
    expect(handlers.close).toHaveBeenCalledWith(1006, "");
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
});
