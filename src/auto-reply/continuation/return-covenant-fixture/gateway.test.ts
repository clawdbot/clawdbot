import type { ChildProcess } from "node:child_process";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { waitForReturnCovenantGatewayReady } from "./gateway-readiness.js";

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("return-covenant gateway ownership", () => {
  it("does not treat an unrelated listener as spawned-child readiness", async () => {
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test listener did not bind a TCP port");
    }

    await expect(
      waitForReturnCovenantGatewayReady(
        {
          child: { exitCode: null, signalCode: null } as ChildProcess,
          label: "unrelated-listener",
          pid: process.pid,
          stderr: "",
          stdout: "",
        },
        address.port,
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow(/spawned child/u);
  });
});
