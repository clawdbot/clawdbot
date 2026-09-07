// Real-TCP hang proof: streamContainerEvents honors caller timeoutMs for handshake.
import http from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { streamContainerEvents } from "./client-container.js";

const BUDGET_MS = 200;

function listenNeverUpgrade(): Promise<{ server: http.Server; sockets: Set<Socket> }> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", () => {});
    server.listen(0, "127.0.0.1", () => resolve({ server, sockets }));
  });
}

function serverPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP listen address");
  }
  return address.port;
}

async function closeServer(server: http.Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("streamContainerEvents handshake timeoutMs", () => {
  let server: http.Server | undefined;
  let sockets: Set<Socket> | undefined;

  afterEach(async () => {
    if (server && sockets) {
      await closeServer(server, sockets);
    }
    server = undefined;
    sockets = undefined;
  });

  it("settles a never-upgrade peer within caller timeoutMs (not the fixed 30s default)", async () => {
    ({ server, sockets } = await listenNeverUpgrade());
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;
    const started = Date.now();
    await streamContainerEvents({
      baseUrl,
      account: "proof",
      timeoutMs: BUDGET_MS,
      onEvent: () => {},
      logger: { log: () => {}, error: () => {} },
    });
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS - 40);
    expect(elapsedMs).toBeLessThan(BUDGET_MS + 400);
  });

  it("still opens against a real upgrading peer when timeoutMs is set", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => {
      wss.once("listening", () => {
        resolve();
      });
    });
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP listen address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const started = Date.now();
    const abort = new AbortController();
    const streamPromise = streamContainerEvents({
      baseUrl,
      account: "proof",
      timeoutMs: 5_000,
      abortSignal: abort.signal,
      onEvent: () => {},
      logger: { log: () => {}, error: () => {} },
    });
    // Give the client time to open, then abort so the stream promise settles.
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 50);
    });
    abort.abort();
    await streamPromise;
    expect(Date.now() - started).toBeLessThan(500);
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
});
