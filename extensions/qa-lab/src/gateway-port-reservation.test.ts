// Qa Lab tests cover Gateway port reservation behavior.
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { reserveQaGatewayPort } from "./gateway-port-reservation.js";

const servers = new Set<net.Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

async function bindReservedPort(port: number) {
  const server = net.createServer();
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

describe("reserveQaGatewayPort", () => {
  it("keeps the selected port unavailable until release", async () => {
    const reservation = await reserveQaGatewayPort(() => net.createServer());

    await expect(bindReservedPort(reservation.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    await reservation.release();

    await expect(bindReservedPort(reservation.port)).resolves.toBeInstanceOf(net.Server);
    await expect(reservation.release()).resolves.toBeUndefined();
  });
});
