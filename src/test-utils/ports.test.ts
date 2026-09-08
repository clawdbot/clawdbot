import { createServer as createRealServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "./env.js";

const host = vi.hoisted(() => ({
  platform: vi.fn(() => "linux"),
  range: "32768\t60999\n",
  reads: vi.fn(),
  cacheKey: Symbol("test port host"),
  rejectPort: vi.fn<(...args: [number]) => string | undefined>(() => undefined),
}));

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      const listen = server.listen.bind(server);
      vi.spyOn(server, "listen").mockImplementation((...listenArgs) => {
        const port = listenArgs[0];
        const code = typeof port === "number" ? host.rejectPort(port) : undefined;
        if (code) {
          queueMicrotask(() => server.emit("error", Object.assign(new Error(code), { code })));
          return server;
        }
        return listen(...listenArgs);
      });
      return server;
    },
  };
});

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: host.platform,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === "/proc/sys/net/ipv4/ip_local_port_range") {
        host.reads();
        return host.range;
      }
      return actual.readFileSync(...args);
    },
  };
});
vi.mock("../shared/global-singleton.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/global-singleton.js")>();
  return {
    ...actual,
    resolveGlobalSingleton: (...args: Parameters<typeof actual.resolveGlobalSingleton>) => {
      if (args[0] === Symbol.for("openclaw.testPortPool")) {
        args[0] = host.cacheKey;
      }
      return actual.resolveGlobalSingleton(...args);
    },
  };
});

const listeners: ReturnType<typeof createRealServer>[] = [];

beforeEach(() => {
  vi.resetModules();
  host.platform.mockReturnValue("linux");
  host.reads.mockClear();
  host.rejectPort.mockReset();
  host.cacheKey = Symbol("test port host");
});

afterEach(async () => {
  Reflect.deleteProperty(globalThis, host.cacheKey);
  await Promise.all(
    listeners.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("deterministic test port blocks", () => {
  it.each([
    [32768, 60999],
    [20000, 65000],
  ])(
    "excludes the kernel client range %i–%i from every worker's listener block",
    async (low, high) => {
      host.range = `${low}\t${high}\n`;
      const { getDeterministicFreePortBlock } = await import("./ports.js");
      const offsets = [0, 1, 2, 3, 4];
      for (let worker = 0; worker < 64; worker += 1) {
        const port = await withEnvAsync({ VITEST_WORKER_ID: String(worker) }, () =>
          getDeterministicFreePortBlock({ offsets }),
        );
        for (const offset of offsets) {
          expect(port + offset).toBeGreaterThanOrEqual(1024);
          expect(port + offset).toBeLessThanOrEqual(65535);
          expect(port + offset < low || port + offset > high).toBe(true);
        }
      }
      expect(host.reads).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps returned adjacent blocks bindable and separate from live listeners", async () => {
    host.range = "32768\t60999\n";
    const { getDeterministicFreePortBlock } = await import("./ports.js");
    const bound = new Set<number>();
    for (let block = 0; block < 2; block += 1) {
      const port = await getDeterministicFreePortBlock();
      for (const offset of [0, 1, 2, 3, 4]) {
        expect(bound.has(port + offset)).toBe(false);
        const server = createRealServer();
        listeners.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port + offset, "127.0.0.1", resolve);
        });
        bound.add(port + offset);
      }
    }
  });

  it.each([
    { first: 1720, last: 1720, offsets: [0] },
    { first: 1712, last: 1719, offsets: [0, 7] },
  ])(
    "does not return an HTTP-blocked base or derived port ($first–$last)",
    async ({ first, last, offsets }) => {
      host.range = "2024 65535";
      host.rejectPort.mockImplementation((port) =>
        (port >= first && port <= last) || (port >= 1800 && port <= 1807)
          ? undefined
          : "EADDRINUSE",
      );
      const { getDeterministicFreePortBlock, isPortFree } = await import("./ports.js");
      await expect(isPortFree(last)).resolves.toBe(true);
      await expect(fetch(`http://127.0.0.1:${last}/`)).rejects.toMatchObject({
        cause: { message: "bad port" },
      });
      const port = await getDeterministicFreePortBlock({ offsets });
      for (const offset of offsets) {
        expect(port + offset).toBeGreaterThanOrEqual(1800);
        expect(port + offset).toBeLessThanOrEqual(1807);
      }
    },
  );

  it.each(["darwin", "win32"])(
    "preserves the existing %s pool without Linux host reads",
    async (os) => {
      host.platform.mockReturnValue(os);
      const { getDeterministicFreePortBlock } = await import("./ports.js");
      const port = await getDeterministicFreePortBlock();
      expect(port).toBeGreaterThanOrEqual(30000);
      expect(port + 4).toBeLessThanOrEqual(64999);
      expect(host.reads).not.toHaveBeenCalled();
    },
  );

  it("falls back outside both an occupied worker shard and the kernel client range", async () => {
    host.range = "32768\t60999\n";
    let occupiedStart: number | undefined;
    host.rejectPort.mockImplementation((port) => {
      occupiedStart ??= port;
      return port === 0 || (port >= occupiedStart && port < occupiedStart + 1000)
        ? "EADDRINUSE"
        : undefined;
    });
    const { getDeterministicFreePortBlock } = await import("./ports.js");
    const port = await getDeterministicFreePortBlock();
    expect(occupiedStart).toBeDefined();
    for (const offset of [0, 1, 2, 3, 4]) {
      const candidate = port + offset;
      expect(candidate < occupiedStart! || candidate >= occupiedStart! + 1000).toBe(true);
      expect(candidate < 32768 || candidate > 60999).toBe(true);
      expect(host.rejectPort).toHaveBeenCalledWith(candidate);
    }
    expect(host.rejectPort).not.toHaveBeenCalledWith(0);
  });

  it.each(["EPERM", "EACCES"])(
    "keeps permission-denied Linux blocks outside the client range for %s",
    async (code) => {
      host.range = "32768\t60999\n";
      host.rejectPort.mockReturnValue(code);
      const { getFreePortBlockWithPermissionFallback } = await import("./ports.js");
      const offsets = [0, 1, 2, 4];
      const port = await getFreePortBlockWithPermissionFallback({ offsets, fallbackBase: 44000 });
      for (const offset of offsets) {
        expect(port + offset >= 1024 && port + offset <= 65535).toBe(true);
        expect(port + offset < 32768 || port + offset > 60999).toBe(true);
      }
      expect(host.rejectPort.mock.calls.map(([candidate]) => candidate)).toEqual(
        offsets.map((offset) => port + offset),
      );
    },
  );

  it("skips HTTP-blocked derived ports before accepting a denied Linux block", async () => {
    host.range = "1 1711";
    host.rejectPort.mockReturnValue("EPERM");
    const { getFreePortBlockWithPermissionFallback } = await import("./ports.js");
    // Select the first safe shard so +7 first hits Fetch-blocked port 1719.
    await withEnvAsync({ VITEST_WORKER_ID: String(64 - (process.pid % 64)) }, async () => {
      const port = await getFreePortBlockWithPermissionFallback({
        offsets: [0, 7],
        fallbackBase: 44000,
      });
      expect(port).toBe(1728);
      expect(host.rejectPort.mock.calls.map(([candidate]) => candidate)).toEqual([1728, 1735]);
    });
  });

  it.each(["darwin", "win32"])("preserves the explicit %s permission fallback", async (os) => {
    host.platform.mockReturnValue(os);
    host.rejectPort.mockReturnValue("EACCES");
    const { getFreePortBlockWithPermissionFallback } = await import("./ports.js");
    await expect(
      getFreePortBlockWithPermissionFallback({ offsets: [0, 1, 2, 4], fallbackBase: 44000 }),
    ).resolves.toBe(44000 + (process.pid % 10000));
    expect(host.reads).not.toHaveBeenCalled();
  });

  it.each(["1024 65535", "invalid"])(
    "does not fall back to ephemeral ports for host range %s",
    async (range) => {
      host.range = range;
      const { getDeterministicFreePortBlock } = await import("./ports.js");
      await expect(getDeterministicFreePortBlock()).rejects.toThrow(/ephemeral TCP (port )?range/);
      expect(host.rejectPort).not.toHaveBeenCalled();
    },
  );

  it("does not mistake denied host facts for permission to use an unchecked fallback", async () => {
    host.reads.mockImplementationOnce(() => {
      throw Object.assign(new Error("proc access denied"), { code: "EACCES" });
    });
    const { getFreePortBlockWithPermissionFallback } = await import("./ports.js");
    await expect(
      getFreePortBlockWithPermissionFallback({ offsets: [0, 1, 2, 4], fallbackBase: 44000 }),
    ).rejects.toThrow("failed to read Linux ephemeral TCP port range");
    expect(host.rejectPort).not.toHaveBeenCalled();
  });
});
