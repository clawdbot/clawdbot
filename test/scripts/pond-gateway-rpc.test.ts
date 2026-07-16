import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PondGatewayRpc } from "../../scripts/e2e/lib/pond-gateway-rpc.mjs";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class FakeWebSocket extends EventEmitter {
  readyState = CONNECTING;
  sent: Array<{ id: string; method: string }> = [];
  terminated = false;
  sendError: Error | undefined;
  respondToConnect = true;

  open(): void {
    this.readyState = OPEN;
    this.emit("open");
  }

  send(payload: string, callback: (error?: Error) => void): void {
    const frame = JSON.parse(payload) as { id: string; method: string };
    this.sent.push(frame);
    callback(this.sendError);
    if (frame.method === "connect" && !this.sendError && this.respondToConnect) {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({ type: "res", id: frame.id, ok: true }));
      });
    }
  }

  close(): void {
    this.readyState = CLOSED;
    this.emit("close", 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = CLOSED;
    this.emit("close", 1006, Buffer.alloc(0));
  }
}

function createRpc(socket: FakeWebSocket, openTimeoutMs = 100) {
  return new PondGatewayRpc({
    url: "ws://127.0.0.1:18789",
    token: String(),
    scopes: ["operator.read"],
    openTimeoutMs,
    webSocketFactory: () => socket,
  });
}

async function connect(rpc: PondGatewayRpc, socket: FakeWebSocket): Promise<void> {
  const connecting = rpc.connect();
  socket.open();
  await connecting;
}

describe("Pond gateway RPC", () => {
  it("terminates a stalled websocket handshake at the connection deadline", async () => {
    const socket = new FakeWebSocket();
    const rpc = createRpc(socket, 1);
    const keepAlive = setTimeout(() => {}, 100);

    try {
      await expect(rpc.connect()).rejects.toThrow("Gateway connect timeout: ws://127.0.0.1:18789");
    } finally {
      clearTimeout(keepAlive);
    }

    expect(socket.terminated).toBe(true);
  });

  it("closes the websocket when the gateway connect RPC stalls", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      socket.respondToConnect = false;
      const rpc = createRpc(socket);
      const connecting = rpc.connect();
      const rejected = expect(connecting).rejects.toThrow("Gateway RPC timeout: connect");
      socket.open();

      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(socket.readyState).toBe(CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pending RPCs when an open websocket emits an error", async () => {
    const socket = new FakeWebSocket();
    const rpc = createRpc(socket);
    await connect(rpc, socket);

    const request = rpc.request("node.list");
    socket.emit("error", new Error("invalid websocket frame"));

    await expect(request).rejects.toThrow("invalid websocket frame");
    await expect(rpc.request("node.list")).rejects.toThrow("invalid websocket frame");
  });

  it("rejects pending RPCs when an open websocket closes", async () => {
    const socket = new FakeWebSocket();
    const rpc = createRpc(socket);
    await connect(rpc, socket);

    const request = rpc.request("node.list");
    socket.readyState = CLOSED;
    socket.emit("close", 1006, Buffer.from("gateway stopped"));

    await expect(request).rejects.toThrow("Gateway socket closed (1006): gateway stopped");
  });

  it("rejects an RPC when the websocket send callback reports failure", async () => {
    const socket = new FakeWebSocket();
    const rpc = createRpc(socket);
    await connect(rpc, socket);
    socket.sendError = new Error("send failed");

    await expect(rpc.request("node.list")).rejects.toThrow("send failed");
  });
});
