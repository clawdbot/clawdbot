import { EventEmitter } from "node:events";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";

// Hoist the factory so vi.mock can access it.
const mockCreateServer = vi.hoisted(() => vi.fn());

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  return { ...actual, createServer: mockCreateServer };
});

import { probePortFree, waitForPortBindable } from "./ports.js";

/** Build a minimal fake net.Server that emits a given error code on listen(). */
function makeErrServer(code: string): net.Server {
  const err = Object.assign(new Error(`bind error: ${code}`), {
    code,
  }) as NodeJS.ErrnoException;

  const fake = new EventEmitter() as unknown as net.Server;
  (fake as unknown as { close: (cb?: () => void) => net.Server }).close = (cb?: () => void) => {
    cb?.();
    return fake;
  };
  (fake as unknown as { unref: () => net.Server }).unref = () => fake;
  (fake as unknown as { listen: (...args: unknown[]) => net.Server }).listen = (
    ..._args: unknown[]
  ) => {
    setImmediate(() => fake.emit("error", err));
    return fake;
  };
  return fake;
}

async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}`);
}

describe("probePortFree", () => {
  it("resolves false (not rejects) when bind returns EADDRINUSE", async () => {
    mockCreateServer.mockReturnValue(makeErrServer("EADDRINUSE"));
    await expect(probePortFree(9999, "127.0.0.1")).resolves.toBe(false);
  });

  it("rejects immediately for EADDRNOTAVAIL (non-retryable: host address not on any interface)", async () => {
    mockCreateServer.mockReturnValue(makeErrServer("EADDRNOTAVAIL"));
    await expectRejectCode(probePortFree(9999, "192.0.2.1"), "EADDRNOTAVAIL");
  });

  it("rejects immediately for EACCES (non-retryable bind error)", async () => {
    mockCreateServer.mockReturnValue(makeErrServer("EACCES"));
    await expectRejectCode(probePortFree(80, "0.0.0.0"), "EACCES");
  });

  it("rejects immediately for other non-retryable errors", async () => {
    mockCreateServer.mockReturnValue(makeErrServer("EINVAL"));
    await expectRejectCode(probePortFree(9999, "0.0.0.0"), "EINVAL");
  });

  it("resolves true when the port is free", async () => {
    // Mock a successful bind: the "listening" event fires immediately without
    // acquiring a real socket, making this deterministic and avoiding TOCTOU races.
    // (A real-socket approach would bind to :0, release, then reprobe — the OS can
    // reassign the ephemeral port in between, causing a flaky EADDRINUSE failure.)
    const fakeServer = new EventEmitter() as unknown as net.Server;
    (fakeServer as unknown as { close: (cb?: () => void) => net.Server }).close = (
      cb?: () => void,
    ) => {
      cb?.();
      return fakeServer;
    };
    (fakeServer as unknown as { unref: () => net.Server }).unref = () => fakeServer;
    (fakeServer as unknown as { listen: (...args: unknown[]) => net.Server }).listen = (
      ..._args: unknown[]
    ) => {
      // Simulate a successful bind by firing the "listening" callback.
      const callback = _args.find((a) => typeof a === "function") as (() => void) | undefined;
      setImmediate(() => callback?.());
      return fakeServer;
    };
    mockCreateServer.mockReturnValue(fakeServer);

    const result = await probePortFree(9999, "127.0.0.1");
    expect(result).toBe(true);
  });
});

describe("waitForPortBindable", () => {
  it("probes the provided host when waiting for bindability", async () => {
    const listenCalls: Array<{ port: number; host: string }> = [];
    const fakeServer = new EventEmitter() as unknown as net.Server;
    (fakeServer as unknown as { close: (cb?: () => void) => net.Server }).close = (
      cb?: () => void,
    ) => {
      cb?.();
      return fakeServer;
    };
    (fakeServer as unknown as { unref: () => net.Server }).unref = () => fakeServer;
    (fakeServer as unknown as { listen: (...args: unknown[]) => net.Server }).listen = (
      ...args: unknown[]
    ) => {
      const [port, host] = args as [number, string];
      listenCalls.push({ port, host });
      const callback = args.find((a) => typeof a === "function") as (() => void) | undefined;
      setImmediate(() => callback?.());
      return fakeServer;
    };
    mockCreateServer.mockReturnValue(fakeServer);

    await expect(
      waitForPortBindable(9999, { timeoutMs: 100, intervalMs: 10, host: "127.0.0.1" }),
    ).resolves.toBe(0);
    expect(listenCalls[0]).toEqual({ port: 9999, host: "127.0.0.1" });
  });

  it("propagates EACCES rejection immediately without retrying", async () => {
    // Every call to createServer will emit EACCES — so if waitForPortBindable retried,
    // mockCreateServer would be called many times. We assert it's called exactly once.
    mockCreateServer.mockClear();
    mockCreateServer.mockReturnValue(makeErrServer("EACCES"));
    await expectRejectCode(waitForPortBindable(80, { timeoutMs: 5000, intervalMs: 50 }), "EACCES");
    // Only one probe should have been attempted — no spinning through the retry loop.
    expect(mockCreateServer).toHaveBeenCalledTimes(1);
  });
});
