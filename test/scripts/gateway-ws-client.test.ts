import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createGatewayWsClient } from "../../scripts/dev/gateway-ws-client.js";

let server: Server | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    wss?.close(() => resolve());
    if (!wss) {
      resolve();
    }
  });
  wss = undefined;

  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    if (!server) {
      resolve();
    }
  });
  server = undefined;
});

async function listen(handler: (ws: WebSocket) => void): Promise<string> {
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", handler);
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test websocket server did not get a TCP address");
  }
  return `ws://127.0.0.1:${address.port}`;
}

async function listenStalledUpgrade(): Promise<{ close: () => Promise<void>; url: string }> {
  const stalledServer = createServer();
  const sockets = new Set<import("node:net").Socket>();
  stalledServer.on("upgrade", (_req, socket) => {
    // Keep the socket open without completing the websocket handshake.
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => {
    stalledServer.listen(0, "127.0.0.1", resolve);
  });
  const address = stalledServer.address();
  if (!address || typeof address === "string") {
    throw new Error("test websocket server did not get a TCP address");
  }
  return {
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        stalledServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
    url: `ws://127.0.0.1:${address.port}`,
  };
}

describe("createGatewayWsClient", () => {
  it("rejects pending RPC requests when the client closes", async () => {
    const url = await listen(() => {});
    const client = createGatewayWsClient({ url });
    await client.waitOpen();

    const pending = client.request("health", {}, 1000);
    client.close();

    await expect(pending).rejects.toThrow("gateway websocket client closed");
  });

  it("rejects pending RPC requests when the gateway closes the socket", async () => {
    const url = await listen((ws) => {
      ws.on("message", () => {
        ws.close(1011, "boom");
      });
    });
    const client = createGatewayWsClient({ url });
    await client.waitOpen();

    await expect(client.request("health", {}, 1000)).rejects.toThrow(
      "gateway websocket closed (1011): boom",
    );
    client.close();
  });

  it("terminates stalled websocket handshakes after the open timeout", async () => {
    const stalled = await listenStalledUpgrade();
    const client = createGatewayWsClient({ openTimeoutMs: 5, url: stalled.url });
    try {
      await expect(client.waitOpen()).rejects.toThrow("ws open timeout");
      await waitFor(() => client.ws.readyState === WebSocket.CLOSED);
    } finally {
      client.close();
      await stalled.close();
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
