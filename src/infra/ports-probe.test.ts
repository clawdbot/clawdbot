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
  it("rejects an already-aborted bind without opening a listener", async () => {
    const abortController = new AbortController();
    const reason = new Error("probe cancelled");
    abortController.abort(reason);

    await expect(
      tryListenOnPort({
        port: 0,
        host: "127.0.0.1",
        exclusive: true,
        signal: abortController.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("can bind and release an ephemeral loopback port", async () => {
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
    // Release proof stays tied to the allocated port: a lingering listener
    // would accept this probe, a released port refuses it. A rebind assertion
    // instead collides with any foreign outbound socket occupying the port on
    // busy runners (EADDRINUSE flake) without detecting leaks any better.
    await expect(
      new Promise<"accepted" | "unavailable">((resolve, reject) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        socket.once("connect", () => {
          socket.destroy();
          resolve("accepted");
        });
        socket.once("error", (err) => {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ECONNREFUSED" || code === "ECONNRESET") {
            resolve("unavailable");
            return;
          }
          reject(err);
        });
      }),
    ).resolves.toBe("unavailable");
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
