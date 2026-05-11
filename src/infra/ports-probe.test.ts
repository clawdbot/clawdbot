import net from "node:net";
import { describe, expect, it } from "vitest";
import { tryListenOnPort } from "./ports-probe.js";

async function withListeningServer(cb: (address: net.AddressInfo) => Promise<void>): Promise<void> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return;
    }
    throw err;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected tcp address");
  }

  try {
    await cb(address);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("tryListenOnPort", () => {
  it("can bind and release an ephemeral loopback port", async () => {
    let listened = false;
    try {
      await tryListenOnPort({ port: 0, host: "127.0.0.1", exclusive: true });
      listened = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw err;
    }
    expect(listened).toBe(true);
  });

  it("rejects when the port is already in use", async () => {
    await withListeningServer(async (address) => {
      let rejection: NodeJS.ErrnoException | undefined;
      try {
        await tryListenOnPort({ port: address.port, host: "127.0.0.1" });
      } catch (err) {
        rejection = err as NodeJS.ErrnoException;
      }

      expect(rejection).toBeInstanceOf(Error);
      expect(rejection?.code).toBe("EADDRINUSE");
      const listenError = rejection as
        | (NodeJS.ErrnoException & { address?: string; port?: number })
        | undefined;
      expect(listenError?.address).toBe("127.0.0.1");
      expect(listenError?.port).toBe(address.port);
      expect(rejection?.syscall).toBe("listen");
    });
  });
});
