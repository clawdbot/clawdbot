import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { readGatewayNetworkClientConnectTimeoutMs } from "../../scripts/e2e/lib/gateway-network/limits.mjs";
import { waitForWebSocketOpen } from "../../scripts/e2e/lib/gateway-network/open-websocket.mjs";

class FakeWebSocket extends EventEmitter {
  terminated = false;
  closed = false;

  terminate(): void {
    this.terminated = true;
    queueMicrotask(() => {
      this.emit("error", new Error("socket abort after terminate"));
      this.emit("close");
    });
  }

  close(): void {
    this.closed = true;
  }
}

describe("gateway network WebSocket open guard", () => {
  it("rejects loose client timeout env values instead of parsing prefixes", () => {
    expect(() =>
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: "100ms",
      }),
    ).toThrow("invalid OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: 100ms");
    expect(() =>
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: 1e3");
    expect(() =>
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: "0",
      }),
    ).toThrow("invalid OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: 0");
  });

  it("prefers the explicit client timeout over the connect-ready fallback", () => {
    expect(
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: "5000",
        OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: "1000",
      }),
    ).toBe(5000);
    expect(
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: "3000",
      }),
    ).toBe(3000);
  });

  it("consumes abort errors after open timeouts", async () => {
    const ws = new FakeWebSocket();
    const keepAlive = setTimeout(() => {}, 100);

    try {
      await expect(waitForWebSocketOpen(ws, 1)).rejects.toThrow("ws open timeout");
    } finally {
      clearTimeout(keepAlive);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(ws.terminated).toBe(true);
    expect(ws.listenerCount("open")).toBe(0);
    expect(ws.listenerCount("error")).toBe(0);
  });

  it("cleans listeners after successful opens", async () => {
    const ws = new FakeWebSocket();
    const opened = waitForWebSocketOpen(ws, 100);

    ws.emit("open");

    await expect(opened).resolves.toBeUndefined();
    expect(ws.terminated).toBe(false);
    expect(ws.listenerCount("open")).toBe(0);
    expect(ws.listenerCount("error")).toBe(0);
  });
});
