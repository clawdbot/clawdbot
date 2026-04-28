import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: (...args: unknown[]) => spawnMock(...args),
    },
  );
});

let killProcessTree: typeof import("./kill-tree.js").killProcessTree;

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  }
}

describe("killProcessTree", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    ({ killProcessTree } = await import("./kill-tree.js"));
  });

  beforeEach(() => {
    spawnMock.mockClear();
    killSpy = vi.spyOn(process, "kill");
    vi.useFakeTimers();
  });

  afterEach(() => {
    killSpy.mockRestore();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("on Windows skips delayed force-kill when PID is already gone", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4242 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withPlatform("win32", async () => {
      killProcessTree(4242, { graceMs: 25 });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenNthCalledWith(
        1,
        "taskkill",
        ["/T", "/PID", "4242"],
        expect.objectContaining({ detached: true, stdio: "ignore" }),
      );

      await vi.advanceTimersByTimeAsync(25);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  it("on Windows force-kills after grace period only when PID still exists", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 5252 && signal === 0) {
        return true;
      }
      return true;
    }) as typeof process.kill);

    await withPlatform("win32", async () => {
      killProcessTree(5252, { graceMs: 10 });

      await vi.advanceTimersByTimeAsync(10);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnMock).toHaveBeenNthCalledWith(
        1,
        "taskkill",
        ["/T", "/PID", "5252"],
        expect.objectContaining({ detached: true, stdio: "ignore" }),
      );
      expect(spawnMock).toHaveBeenNthCalledWith(
        2,
        "taskkill",
        ["/F", "/T", "/PID", "5252"],
        expect.objectContaining({ detached: true, stdio: "ignore" }),
      );
    });
  });

  it("on Unix sends SIGTERM first and skips SIGKILL when process exits", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -3333 && signal === 0) {
        throw new Error("ESRCH");
      }
      if (pid === 3333 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withPlatform("linux", async () => {
      killProcessTree(3333, { graceMs: 10 });

      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(-3333, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-3333, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(3333, "SIGKILL");
    });
  });

  it("on Unix sends SIGKILL after grace period when process is still alive", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -4444 && signal === 0) {
        return true;
      }
      return true;
    }) as typeof process.kill);

    await withPlatform("linux", async () => {
      killProcessTree(4444, { graceMs: 5 });

      await vi.advanceTimersByTimeAsync(5);

      expect(killSpy).toHaveBeenCalledWith(-4444, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-4444, "SIGKILL");
    });
  });

  it("on Unix skips group kill when detached:false to avoid SIGTERMing the parent's own process group (#71662)", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 5555 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withPlatform("linux", async () => {
      killProcessTree(5555, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      // Direct pid kill is fine. Group kill (`-pid`) is FORBIDDEN here because
      // when the child wasn't spawned detached, its process group is the
      // gateway's group — `-pid` would SIGTERM the gateway itself.
      expect(killSpy).toHaveBeenCalledWith(5555, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-5555, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-5555, "SIGKILL");
    });
  });

  it("on Unix uses group kill by default (detached:true preserved as the existing behavior)", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -6666 && signal === 0) {
        throw new Error("ESRCH");
      }
      if (pid === 6666 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withPlatform("linux", async () => {
      killProcessTree(6666, { graceMs: 10 });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(-6666, "SIGTERM");
    });
  });
});
