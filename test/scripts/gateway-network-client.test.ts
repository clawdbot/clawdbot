// Gateway Network Client tests cover gateway network client script behavior.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readGatewayNetworkClientConnectTimeoutMs } from "../../scripts/e2e/lib/gateway-network/limits.mjs";
import { onceFrame } from "../../scripts/e2e/lib/gateway-network/ws-frames.mjs";

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

  it("resolves matching frames and ignores unrelated frames", async () => {
    const ws = new EventEmitter();
    const frame = onceFrame(ws, (message) => message?.id === "target", 1000);

    ws.emit("message", JSON.stringify({ id: "noise" }));
    ws.emit("message", JSON.stringify({ id: "target", ok: true }));

    await expect(frame).resolves.toEqual({ id: "target", ok: true });
  });

  it("times out when no matching frame arrives", async () => {
    const ws = new EventEmitter();
    const frame = onceFrame(ws, () => false, 10);

    ws.emit("message", JSON.stringify({ id: "noise" }));

    await expect(frame).rejects.toThrow("timeout");
  });

  it("rejects frame waits immediately when the socket closes", async () => {
    const ws = new EventEmitter();
    const startedAt = Date.now();
    const frame = onceFrame(ws, () => false, 1000);

    ws.emit("close", 1006, Buffer.from("bye"));

    await expect(frame).rejects.toThrow("closed before frame: 1006 bye");
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("rejects frame waits immediately on socket errors", async () => {
    const ws = new EventEmitter();
    const frame = onceFrame(ws, () => false, 1000);

    ws.emit("error", new Error("socket exploded"));

    await expect(frame).rejects.toThrow("socket exploded");
  });

  it("rejects invalid JSON frames instead of crashing the process", async () => {
    const ws = new EventEmitter();
    const frame = onceFrame(ws, () => false, 1000);

    ws.emit("message", "{nope");

    await expect(frame).rejects.toThrow();
  });

  it("proves health after the authenticated connect handshake", () => {
    const client = readFileSync("scripts/e2e/lib/gateway-network/client.mjs", "utf8");
    const connectIndex = client.indexOf('method: "connect"');
    const healthIndex = client.indexOf('method: "health"');

    expect(connectIndex).toBeGreaterThanOrEqual(0);
    expect(healthIndex).toBeGreaterThan(connectIndex);
    expect(client).toContain('responseError("health", healthRes)');
    expect(client).toContain('message.includes("closed before open")');
    expect(client).toContain('message.includes("closed before frame")');
  });
});
