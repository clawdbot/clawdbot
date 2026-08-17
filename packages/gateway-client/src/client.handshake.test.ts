// Gateway Client tests cover websocket opening-handshake timeout behavior.
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayClient } from "./client.js";

describe("GatewayClient websocket opening handshakeTimeout", () => {
  const servers: net.Server[] = [];
  const sockets: net.Socket[] = [];
  const clients: GatewayClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.stop();
    }
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    for (const server of servers) {
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
  });

  async function listen(server: net.Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return (server.address() as AddressInfo).port;
  }

  it("fails when a peer accepts TCP but never completes the websocket upgrade", async () => {
    // Accept TCP but never complete the websocket upgrade so missing
    // handshakeTimeout would leave start() waiting forever for open.
    const server = net.createServer((socket) => {
      sockets.push(socket);
    });
    const port = await listen(server);
    const handshakeTimeoutMs = 250;
    const startedAt = Date.now();
    const outcome = await new Promise<{
      errorMessage?: string;
      closed: boolean;
    }>((resolve) => {
      let settled = false;
      const finish = (result: { errorMessage?: string; closed: boolean }) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadline);
        resolve(result);
      };
      const deadline = setTimeout(() => {
        finish({ errorMessage: "deadline exceeded without close/error", closed: false });
      }, 2_000);
      deadline.unref?.();
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        preauthHandshakeTimeoutMs: handshakeTimeoutMs,
        connectChallengeTimeoutMs: handshakeTimeoutMs,
        onConnectError: (error) => {
          finish({
            errorMessage: error instanceof Error ? error.message : String(error),
            closed: false,
          });
        },
        onClose: () => {
          finish({ closed: true });
        },
      });
      clients.push(client);
      client.start();
    });
    const elapsedMs = Date.now() - startedAt;

    expect(
      outcome.errorMessage?.includes("Opening handshake has timed out") ||
        outcome.errorMessage?.toLowerCase().includes("timed out") ||
        outcome.closed,
    ).toBe(true);
    expect(elapsedMs).toBeGreaterThanOrEqual(handshakeTimeoutMs - 50);
    expect(elapsedMs).toBeLessThan(1_500);
    console.log(
      `[gateway-client handshake live proof] timed_out=true elapsed_ms=${elapsedMs} handshakeTimeout_ms=${handshakeTimeoutMs} error=${
        outcome.errorMessage ?? `closed=${outcome.closed}`
      }`,
    );
  });

  it("surfaces a rejected websocket upgrade body through the connection error", async () => {
    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Gateway websocket admission closed");
    });
    const port = await listen(server);
    const errors: Error[] = [];
    let resolveRetry = () => {};
    const retried = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    const closed = new Promise<{ code: number; connectError?: Error }>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        onConnectError: (error) => {
          errors.push(error);
          if (errors.length === 2) {
            resolveRetry();
          }
        },
        onClose: (code, _reason, info) => resolve({ code, connectError: info?.connectError }),
      });
      clients.push(client);
      client.start();
    });

    await expect(closed).resolves.toMatchObject({
      code: 1006,
      connectError: {
        name: "GatewayClientRequestError",
        message:
          "gateway rejected websocket upgrade (HTTP 503): Gateway websocket admission closed",
        gatewayCode: "UNAVAILABLE",
        retryable: true,
      },
    });
    await retried;
    expect(requestCount).toBe(2);
    expect(errors).toHaveLength(2);
    expect(errors.map((error) => error.message)).toEqual([
      "gateway rejected websocket upgrade (HTTP 503): Gateway websocket admission closed",
      "gateway rejected websocket upgrade (HTTP 503): Gateway websocket admission closed",
    ]);
  });

  it("caps a rejected websocket upgrade body before the peer ends it", async () => {
    const omittedTail = "omitted-tail-marker";
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.write(`${"x".repeat(3_000)}${omittedTail}`);
    });
    const port = await listen(server);
    const error = await new Promise<Error>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        onConnectError: resolve,
      });
      clients.push(client);
      client.start();
    });

    expect(error.message).toHaveLength(
      "gateway rejected websocket upgrade (HTTP 503): ".length + 2 * 1024,
    );
    expect(error.message).not.toContain(omittedTail);
  });

  it("times out while reading a stalled websocket upgrade response body", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.write("still suspending");
    });
    const port = await listen(server);
    const startedAt = Date.now();
    const error = await new Promise<Error>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        onConnectError: resolve,
      });
      clients.push(client);
      client.start();
    });

    expect(error.message).toBe("gateway rejected websocket upgrade (HTTP 503): still suspending");
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});
