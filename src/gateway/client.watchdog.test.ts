// Gateway client watchdog tests ensure managed proxy mode does not block direct
// loopback WebSocket connections needed by the OpenClaw wrapper.
import { describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayClient } from "./client.js";

function isIpv6UnavailableError(err: unknown): boolean {
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL";
}

describe("GatewayClient OpenClaw wrapper watchdog integration", () => {
  test("connects to IPv6 loopback while managed proxy Gateway-only mode is active", async () => {
    let wss: WebSocketServer | null = new WebSocketServer({ host: "::1", port: 0 });
    const bind = await new Promise<{ port: number } | null>((resolve, reject) => {
      wss?.once("listening", () => {
        const address = wss?.address();
        if (address === undefined || address === null || typeof address === "string") {
          reject(new Error("IPv6 WebSocket server did not bind to a TCP port"));
          return;
        }
        resolve({ port: address.port });
      });
      wss?.once("error", (err) => {
        if (isIpv6UnavailableError(err)) {
          wss = null;
          resolve(null);
          return;
        }
        reject(err);
      });
    });
    if (bind === null) {
      return;
    }

    const { startProxy, stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
    const handle = await startProxy({
      proxyUrl: "http://127.0.0.1:9",
      loopbackMode: "gateway-only",
    });
    const onConnectError = vi.fn();
    const connected = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("IPv6 loopback Gateway client did not connect"));
      }, 2000);
      wss?.once("connection", (socket) => {
        clearTimeout(timeout);
        socket.close(1000, "done");
        resolve();
      });
    });
    const client = new GatewayClient({
      url: `ws://[::1]:${bind.port}`,
      connectChallengeTimeoutMs: 1000,
      onConnectError,
    });

    try {
      expect(client.start()).toBeUndefined();
      await connected;
      expect(onConnectError).not.toHaveBeenCalled();
    } finally {
      client.stop();
      await stopProxy(handle);
      const server = wss;
      if (server !== null) {
        for (const socket of server.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    }
  }, 5000);
});
