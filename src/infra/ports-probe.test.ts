// Tests local port probing and availability detection.
import net from "node:net";
import { describe, expect, it } from "vitest";
import { probePortUsage, tryListenOnPort } from "./ports-probe.js";

async function withListeningServer(
  cb: (address: net.AddressInfo) => Promise<void>,
  host = "127.0.0.1",
): Promise<void> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => resolve());
    });
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === "EPERM" ||
      (err as NodeJS.ErrnoException).code === "EADDRNOTAVAIL"
    ) {
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
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

describe("tryListenOnPort", () => {
  it("can bind and release an ephemeral loopback port", async () => {
    // The rebind proves release completed. A foreign process can steal the
    // freed port between attempts on shared CI runners, so retry the whole
    // cycle on a fresh ephemeral port; a real release regression fails every
    // attempt because the collision is with our own lingering listener.
    let lastRebindError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let port;
      try {
        port = await tryListenOnPort({ port: 0, host: "127.0.0.1", exclusive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
          return;
        }
        throw err;
      }
      expect(port).toBeGreaterThan(0);
      try {
        await tryListenOnPort({ port, host: "127.0.0.1", exclusive: true });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
          throw err;
        }
        lastRebindError = err;
      }
    }
    throw lastRebindError;
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

describe("probePortUsage", () => {
  it("reports an IPv4-only loopback listener as busy", async () => {
    await withListeningServer(async (address) => {
      await expect(probePortUsage(address.port)).resolves.toBe("busy");
    });
  });

  it("can scope a probe to a free loopback address when another address owns the port", async () => {
    await withListeningServer(async (address) => {
      await expect(probePortUsage(address.port)).resolves.toBe("busy");
      await expect(probePortUsage(address.port, ["127.0.0.1"])).resolves.toBe("free");
    }, "127.0.0.2");
  });
});
