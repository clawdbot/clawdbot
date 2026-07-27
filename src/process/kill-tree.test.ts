// Kill tree tests cover process tree termination and platform-specific fallbacks.
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const { readFileSyncMock, spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: (...args: unknown[]) => spawnMock(...args),
      spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    },
  );
});

let killProcessTree: typeof import("./kill-tree.js").killProcessTree;
let signalProcessTree: typeof import("./kill-tree.js").signalProcessTree;

function expectTaskkillCall(index: number, args: string[]) {
  expect(spawnMock.mock.calls[index]).toStrictEqual([
    "taskkill",
    args,
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  ]);
}

function mockIsProcessGroupLeader(...pids: number[]) {
  spawnSyncMock.mockImplementation((command: string, args: string[]) => {
    if (command === "ps" && args[0] === "-p" && args[2] === "-o" && args[3] === "pgid=") {
      const pid = Number.parseInt(args[1] ?? "", 10);
      if (pids.includes(pid)) {
        return { status: 0, stdout: String(pid) };
      }
    }
    return { status: 1, stdout: "" };
  });
}

describe("killProcessTree", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    ({ killProcessTree, signalProcessTree } = await import("./kill-tree.js"));
  });

  beforeEach(() => {
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(() => {
      throw new Error("proc unavailable");
    });
    spawnMock.mockClear();
    spawnSyncMock.mockClear();
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

    await withMockedPlatform("win32", async () => {
      killProcessTree(4242, { graceMs: 25 });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expectTaskkillCall(0, ["/T", "/PID", "4242"]);

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

    await withMockedPlatform("win32", async () => {
      killProcessTree(5252, { graceMs: 10 });

      await vi.advanceTimersByTimeAsync(10);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(0, ["/T", "/PID", "5252"]);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "5252"]);
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

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(3333);
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

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(4444);
      killProcessTree(4444, { graceMs: 5 });

      await vi.advanceTimersByTimeAsync(5);

      expect(killSpy).toHaveBeenCalledWith(-4444, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-4444, "SIGKILL");
    });
  });

  it("on Unix force-kills synchronously without SIGTERM or delayed escalation", async () => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(4949);
      killProcessTree(4949, { force: true });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-4949, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(-4949, "SIGTERM");
    });
  });

  it("on Unix force-kills a live detached group even after the parent pid exits", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -4545 && signal === 0) {
        return true;
      }
      if (pid === 4545 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(4545);
      killProcessTree(4545, { graceMs: 5 });

      await vi.advanceTimersByTimeAsync(5);

      expect(killSpy).toHaveBeenCalledWith(-4545, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-4545, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(4545, "SIGKILL");
    });
  });

  it("on Unix skips group kill when detached:false to avoid SIGTERMing the parent's own process group (#71662)", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 5555 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
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

  it("on Unix uses group kill when the omitted option resolves to a group leader", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -6666 && signal === 0) {
        throw new Error("ESRCH");
      }
      if (pid === 6666 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(6666);
      killProcessTree(6666, { graceMs: 10 });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(-6666, "SIGTERM");
    });
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("ps ENOENT");
      },
    ],
    ["exits non-zero", () => ({ status: 1, stdout: "" })],
    ["returns non-numeric output", () => ({ status: 0, stdout: "not-a-pgid" })],
    ["returns empty output", () => ({ status: 0, stdout: "" })],
  ])("on Unix falls back to single-pid kill when ps %s", async (_label, psResult) => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("darwin", async () => {
      spawnSyncMock.mockImplementation(psResult);
      killProcessTree(8888, { graceMs: 10 });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(8888, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-8888, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-8888, "SIGKILL");
    });
  });

  it("on Unix falls back to single-pid kill when ps returns different PGID", async () => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("linux", async () => {
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        if (command === "ps" && args[0] === "-p" && args[2] === "-o" && args[3] === "pgid=") {
          const pid = Number.parseInt(args[1] ?? "", 10);
          if (pid === 9999) {
            return { status: 0, stdout: "12345\n" };
          }
        }
        return { status: 1, stdout: "" };
      });
      killProcessTree(9999, { graceMs: 10 });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(9999, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-9999, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-9999, "SIGKILL");
    });
  });

  it("on Linux reads process-group ownership from procfs without spawning ps", async () => {
    killSpy.mockImplementation(() => true);
    readFileSyncMock.mockReturnValue("7777 (shell worker) S 1 7777 7777 0");

    await withMockedPlatform("linux", async () => {
      signalProcessTree(7777, "SIGTERM");

      expect(killSpy).toHaveBeenCalledWith(-7777, "SIGTERM");
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });

  it("on Unix sends a single requested tree signal without scheduling escalation", async () => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(7777);
      signalProcessTree(7777, "SIGTERM");

      await vi.advanceTimersByTimeAsync(60_000);

      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-7777, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-7777, "SIGKILL");
    });
  });

  it("on Windows maps requested tree signals to taskkill force mode", async () => {
    await withMockedPlatform("win32", async () => {
      signalProcessTree(8888, "SIGTERM");
      signalProcessTree(8888, "SIGKILL");

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(0, ["/T", "/PID", "8888"]);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "8888"]);
    });
  });

  it("on Windows exposes taskkill completion", async () => {
    const taskkillChild = new EventEmitter();
    spawnMock.mockReturnValueOnce(taskkillChild);

    await withMockedPlatform("win32", async () => {
      const completed = vi.fn();
      signalProcessTree(8989, "SIGKILL", { onComplete: completed });
      await Promise.resolve();
      expect(completed).not.toHaveBeenCalled();

      taskkillChild.emit("close", 0);
      await Promise.resolve();

      expect(completed).toHaveBeenCalledOnce();
      expectTaskkillCall(0, ["/F", "/T", "/PID", "8989"]);
    });
  });

  it("on Windows bounds taskkill completion when no event arrives", async () => {
    const taskkillChild = new EventEmitter();
    spawnMock.mockReturnValueOnce(taskkillChild);

    await withMockedPlatform("win32", async () => {
      const completed = vi.fn();
      signalProcessTree(9090, "SIGKILL", { onComplete: completed });

      await vi.advanceTimersByTimeAsync(2_999);
      expect(completed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(completed).toHaveBeenCalledOnce();
      expectTaskkillCall(0, ["/F", "/T", "/PID", "9090"]);
    });
  });

  it("on Windows force-kills synchronously without delayed taskkill", async () => {
    await withMockedPlatform("win32", async () => {
      killProcessTree(9999, { force: true });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expectTaskkillCall(0, ["/F", "/T", "/PID", "9999"]);
    });
  });

  it("on Windows ignores async taskkill spawn errors", async () => {
    const taskkillChild = new EventEmitter();
    spawnMock.mockReturnValueOnce(taskkillChild);

    await withMockedPlatform("win32", async () => {
      killProcessTree(9191, { force: true });

      expect(() => taskkillChild.emit("error", new Error("spawn ENOENT"))).not.toThrow();
      expectTaskkillCall(0, ["/F", "/T", "/PID", "9191"]);
    });
  });
});
