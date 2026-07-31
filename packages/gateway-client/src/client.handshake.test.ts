// Gateway Client tests cover websocket opening-handshake timeout behavior.
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
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
  });

  it("fails when a peer accepts TCP but never completes the websocket upgrade", async () => {
    // Accept TCP but never complete the websocket upgrade so missing
    // handshakeTimeout would leave start() waiting forever for open.
    const server = net.createServer((socket) => {
      sockets.push(socket);
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
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
});
