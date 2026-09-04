// Gateway E2E harness real-transport tests cover failed client cleanup.
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectGatewayStatusClient } from "./gateway-e2e-harness.js";

describe("connectGatewayStatusClient real transport", () => {
  let server: net.Server | undefined;
  let socket: net.Socket | undefined;

  afterEach(async () => {
    socket?.destroy();
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("closes a real transport after the status handshake times out", async () => {
    let resolveAccepted = () => {};
    const accepted = new Promise<void>((resolve) => {
      resolveAccepted = resolve;
    });
    let resolveUpgrade = () => {};
    const upgradeRequested = new Promise<void>((resolve) => {
      resolveUpgrade = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      server = net.createServer((clientSocket) => {
        socket = clientSocket;
        resolveAccepted();
        let request = "";
        clientSocket.on("data", (data) => {
          request += data.toString("utf8");
          if (request.includes("Upgrade: websocket")) {
            resolveUpgrade();
          }
        });
        clientSocket.once("close", resolve);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const port = (server?.address() as AddressInfo).port;
    const attempt = connectGatewayStatusClient(
      {
        homeDir: "",
        name: "real-timeout",
        port,
        gatewayToken: "token",
      } as Parameters<typeof connectGatewayStatusClient>[0],
      100,
    );

    await accepted;
    await upgradeRequested;
    await expect(attempt).rejects.toThrow("timeout waiting for status client hello");
    await expect(
      Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]),
    ).resolves.toBe(true);
    console.log(
      "[gateway-e2e real proof] handshake_failed=true upgrade_requested=true transport_closed=true cleanup_observed=true",
    );
  });
});
