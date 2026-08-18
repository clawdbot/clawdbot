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
    spawnMock.mockReset();
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

  it("on Windows force-kills immediately when graceful taskkill refuses a live process tree", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4711, { graceMs: 30_000 });

      expectTaskkillCall(0, ["/T", "/PID", "4711"]);
      gracefulTaskkill.emit("close", 128);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4711"]);
    });
  });

  it("on Windows does not force-kill a disappeared or reused PID after taskkill fails", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    let processWasReused = false;
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4712 && signal === 0 && !processWasReused) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4712, { graceMs: 25 });
      gracefulTaskkill.emit("close", 128);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      processWasReused = true;
      await vi.advanceTimersByTimeAsync(25);

      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  it("on Windows force-kills only once when taskkill failure races the grace timer", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4713, { graceMs: 20 });
      gracefulTaskkill.emit("close", 128);
      await vi.advanceTimersByTimeAsync(20);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4713"]);
    });
  });

  it("on Windows waits for the grace timer when graceful taskkill cannot start", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4714, { graceMs: 15 });
      expect(() => gracefulTaskkill.emit("error", new Error("spawn ENOENT"))).not.toThrow();
      gracefulTaskkill.emit("close", -4058);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4714"]);
    });
  });

  it("on Windows keeps an explicitly requested failed tree signal single-shot", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);

    await withMockedPlatform("win32", async () => {
      signalProcessTree(4715, "SIGTERM");
      gracefulTaskkill.emit("close", 128);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expectTaskkillCall(0, ["/T", "/PID", "4715"]);
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

  it("on Unix cleans attached descendants without signaling the parent's process group", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        // The whole captured tree (root + child + grandchild) is alive at the
        // identity recorded during enumeration, so each survives the
        // grace-period re-verification and receives the delayed SIGKILL.
        if (pid === 5555 || pid === 5556 || pid === 5557) {
          return true;
        }
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5555/task/5555/children") {
        return "5556";
      }
      if (filePath === "/proc/5556/task/5556/children") {
        return "5557";
      }
      if (filePath === "/proc/5557/task/5557/children") {
        return "";
      }
      if (filePath === "/proc/5555/stat") {
        return "5555 (root) S 1 5555 5555 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 100 0";
      }
      if (filePath === "/proc/5556/stat") {
        return "5556 (child) S 5555 5556 5555 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 101 0";
      }
      if (filePath === "/proc/5557/stat") {
        return "5557 (grandchild) S 5556 5557 5555 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 102 0";
      }
      throw new Error("unexpected proc path");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5555, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      // Descendants are signaled before the root while group kill remains
      // forbidden because the attached child shares the gateway's group. The
      // grace-period SIGKILL re-verifies each captured identity, so the
      // grandchild that ignored SIGTERM is also force-killed.
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).filter(
          ([, signal]) => signal !== 0,
        ),
      ).toEqual([
        [5557, "SIGTERM"],
        [5556, "SIGTERM"],
        [5555, "SIGTERM"],
        [5557, "SIGKILL"],
        [5556, "SIGKILL"],
        [5555, "SIGKILL"],
      ]);
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).some(
          ([pid]) => typeof pid === "number" && pid < 0,
        ),
      ).toBe(false);
    });
  });

  it("on Unix signals attached descendants before the root through signalProcessTree", async () => {
    killSpy.mockImplementation(() => true);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5575/task/5575/children") {
        return "5576";
      }
      if (filePath === "/proc/5576/task/5576/children") {
        return "";
      }
      if (filePath === "/proc/5575/stat") {
        return "5575 (root) S 1 5575 5575 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 100 0";
      }
      if (filePath === "/proc/5576/stat") {
        return "5576 (child) S 5575 5576 5575 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 101 0";
      }
      throw new Error("unexpected proc path");
    });

    await withMockedPlatform("linux", async () => {
      const completed = vi.fn();
      signalProcessTree(5575, "SIGTERM", { detached: false, onComplete: completed });

      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).filter(
          ([, signal]) => signal !== 0,
        ),
      ).toEqual([
        [5576, "SIGTERM"],
        [5575, "SIGTERM"],
      ]);
      expect(completed).toHaveBeenCalledOnce();
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).some(
          ([pid]) => typeof pid === "number" && pid < 0,
        ),
      ).toBe(false);
    });
  });

  it("on Unix force-kills attached descendants before the root", async () => {
    killSpy.mockImplementation(() => true);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5565/task/5565/children") {
        return "5566";
      }
      if (filePath === "/proc/5566/task/5566/children") {
        return "";
      }
      if (filePath === "/proc/5565/stat") {
        return "5565 (root) S 1 5565 5565 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 100 0";
      }
      if (filePath === "/proc/5566/stat") {
        return "5566 (child) S 5565 5566 5565 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 101 0";
      }
      throw new Error("unexpected proc path");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5565, { force: true, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).filter(
          ([, signal]) => signal !== 0,
        ),
      ).toEqual([
        [5566, "SIGKILL"],
        [5565, "SIGKILL"],
      ]);
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).some(
          ([pid]) => typeof pid === "number" && pid < 0,
        ),
      ).toBe(false);
    });
  });

  it("on macOS signals only the attached root without a reusable process identity", async () => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("darwin", async () => {
      signalProcessTree(5585, "SIGTERM", { detached: false });

      expect(killSpy).toHaveBeenCalledWith(5585, "SIGTERM");
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).some(
          ([pid]) => typeof pid === "number" && pid < 0,
        ),
      ).toBe(false);
    });
  });

  it("on Unix skips recycled-PID escalation when the process instance changed", async () => {
    killSpy.mockImplementation(() => true);
    let rootStatStarttime = "100";
    // proc(5) stat fields after comm: state ppid pgrp sid tty_nr tpgid flags
    // minflt cminflt majflt cmajflt utime stime cutime cstime priority nice
    // num_threads itrealvalue starttime ... -> starttime is index 19.
    const statLine = (pid: number, comm: string, starttime: string, ppid = 1) =>
      `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 0`;
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5590/task/5590/children") {
        return "5591";
      }
      if (filePath === "/proc/5591/task/5591/children") {
        return "";
      }
      if (filePath === "/proc/5590/stat") {
        return statLine(5590, "root", rootStatStarttime);
      }
      if (filePath === "/proc/5591/stat") {
        return statLine(5591, "child", "101", 5590);
      }
      throw new Error("unexpected proc path");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5590, { graceMs: 10, detached: false });

      // The initial SIGTERM pass uses the captured identity, so the root and its
      // one descendant are both terminated once.
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).filter(
          ([, signal]) => signal !== 0,
        ),
      ).toEqual([
        [5591, "SIGTERM"],
        [5590, "SIGTERM"],
      ]);

      // Simulate PID reuse: the root exits, its PID is reassigned, and the new
      // process reports a different start time during the grace escalation.
      rootStatStarttime = "9999";
      await vi.advanceTimersByTimeAsync(10);

      // The recycled root must not receive a delayed SIGKILL because its
      // process-instance identity no longer matches the captured snapshot.
      expect(killSpy).not.toHaveBeenCalledWith(5590, "SIGKILL");
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).some(
          ([pid]) => typeof pid === "number" && pid < 0,
        ),
      ).toBe(false);
    });
  });

  it("on Linux binds each child identity before traversing its own descendants", async () => {
    // Discovery-time PID-reuse race: `/proc/<parent>/children` reports 5621,
    // but the original child exits before its identity can be captured (its
    // `/proc/5621/stat` no longer exists). The collector must bind the child
    // identity BEFORE reading its descendants, so neither 5621 nor any PID
    // reported by a recycled 5621's children file enters the snapshot.
    const statLine = (pid: number, comm: string, starttime: string, ppid = 1) =>
      `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 0`;
    killSpy.mockImplementation(() => true);
    const readOrder: string[] = [];
    readFileSyncMock.mockImplementation((filePath: string) => {
      readOrder.push(filePath);
      if (filePath === "/proc/5620/task/5620/children") {
        return "5621";
      }
      // A recycled 5621 would expose its own descendants; traversal must never
      // reach this because the child identity bind fails first.
      if (filePath === "/proc/5621/task/5621/children") {
        return "5622";
      }
      if (filePath === "/proc/5620/stat") {
        return statLine(5620, "root", "100");
      }
      // 5621 has already exited, so its identity cannot be captured.
      throw new Error("child 5621 exited before identity capture");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5620, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      // The child's identity read happens before any attempt to read its
      // descendants: the recycled children file is never opened.
      const childStatIndex = readOrder.indexOf("/proc/5621/stat");
      const childChildrenIndex = readOrder.indexOf("/proc/5621/task/5621/children");
      expect(childStatIndex).toBeGreaterThanOrEqual(0);
      expect(childChildrenIndex).toBe(-1);
      // Only the verified root is signaled; the exited child never enters the
      // snapshot and its (recycled) subtree is never traversed.
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).filter(
          ([, signal]) => signal !== 0,
        ),
      ).toEqual([
        [5620, "SIGTERM"],
        [5620, "SIGKILL"],
      ]);
      expect(killSpy).not.toHaveBeenCalledWith(5621, expect.anything());
      expect(killSpy).not.toHaveBeenCalledWith(5622, expect.anything());
    });
  });

  it("on Linux rejects a recycled child PID whose replacement no longer belongs to the parent", async () => {
    // PID-reuse-to-unrelated-subtree race: `/proc/<parent>/children` lists 5631,
    // but the original child exits and an unrelated process reuses 5631 before
    // the identity read. The replacement has its own valid identity and its own
    // descendant 5632, but its ppid is no longer the verified parent 5630, so it
    // must not be admitted into the snapshot or traversed.
    const statLine = (pid: number, comm: string, starttime: string, ppid = 1) =>
      `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 0`;
    killSpy.mockImplementation(() => true);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5630/task/5630/children") {
        return "5631";
      }
      if (filePath === "/proc/5631/task/5631/children") {
        return "5632";
      }
      if (filePath === "/proc/5632/task/5632/children") {
        return "";
      }
      if (filePath === "/proc/5630/stat") {
        return statLine(5630, "root", "100");
      }
      // The replacement process reuses 5631 with a fresh starttime but reports a
      // different parent, proving it never belonged to the captured tree.
      if (filePath === "/proc/5631/stat") {
        return statLine(5631, "replacement", "888", 9999);
      }
      if (filePath === "/proc/5632/stat") {
        return statLine(5632, "stranger", "889", 5631);
      }
      throw new Error("unexpected proc path");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5630, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      // Only the verified root is signaled; the recycled child (5631) and the
      // replacement process's descendant (5632) are rejected by the ppid check.
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).filter(
          ([, signal]) => signal !== 0,
        ),
      ).toEqual([
        [5630, "SIGTERM"],
        [5630, "SIGKILL"],
      ]);
      expect(killSpy).not.toHaveBeenCalledWith(5631, expect.anything());
      expect(killSpy).not.toHaveBeenCalledWith(5632, expect.anything());
    });
  });

  it("on Linux revalidates a non-root parent before reading its children", async () => {
    // Parent-reuse race at a non-root level: 5640 (root) -> 5641 (child) is
    // captured. Before the walker reads 5641's children, 5641 exits and its PID
    // is reused by an unrelated process that reports a grandchild 5642. Because
    // 5641's identity changed, its (replacement) children file must never be
    // trusted, so 5642 cannot enter the snapshot.
    const statLine = (pid: number, comm: string, starttime: string, ppid = 1) =>
      `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 0`;
    killSpy.mockImplementation(() => true);
    let child5641Starttime = "200";
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5640/task/5640/children") {
        return "5641";
      }
      if (filePath === "/proc/5641/task/5641/children") {
        return "5642";
      }
      if (filePath === "/proc/5642/task/5642/children") {
        return "";
      }
      if (filePath === "/proc/5640/stat") {
        return statLine(5640, "root", "100");
      }
      if (filePath === "/proc/5641/stat") {
        // The first read (child capture) sees the original starttime; the
        // second read (parent revalidation before its children) sees the
        // recycled replacement's starttime, so the revalidation fails.
        const starttime = child5641Starttime;
        child5641Starttime = "777";
        return statLine(5641, starttime === "200" ? "child" : "replacement", starttime, 5640);
      }
      if (filePath === "/proc/5642/stat") {
        return statLine(5642, "stranger", "778", 5641);
      }
      throw new Error("unexpected proc path");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5640, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      // The recycled 5641 fails its signal-time identity re-check, so only the
      // verified root is signaled; 5641's replacement grandchild (5642) never
      // enters the snapshot because 5641's identity changed before its
      // children were read.
      const realSignals = (
        killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>
      ).filter(([, signal]) => signal !== 0);
      expect(realSignals).toEqual([
        [5640, "SIGTERM"],
        [5640, "SIGKILL"],
      ]);
      expect(realSignals.some(([pid]) => pid === 5641)).toBe(false);
      expect(realSignals.some(([pid]) => pid === 5642)).toBe(false);
    });
  });

  it("on Linux revalidates the root identity before reading its children", async () => {
    // Root-reuse race: 5650 (root) is captured at snapshot entry, but the
    // direct child exits and its PID is reused before the walker reads the
    // root's children file. The replacement process exposes its own child 5651,
    // whose numeric ppid would match 5650; without a root identity re-check the
    // foreign subtree could be admitted and signaled.
    const statLine = (pid: number, comm: string, starttime: string, ppid = 1) =>
      `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 0`;
    killSpy.mockImplementation(() => true);
    let root5650Starttime = "300";
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5650/task/5650/children") {
        return "5651";
      }
      if (filePath === "/proc/5651/task/5651/children") {
        return "";
      }
      if (filePath === "/proc/5650/stat") {
        // The first read (snapshot entry) sees the original starttime; the
        // second read (revalidation before children) sees the recycled
        // replacement's starttime, so the root re-check fails.
        const starttime = root5650Starttime;
        root5650Starttime = "666";
        return statLine(5650, starttime === "300" ? "root" : "replacement", starttime);
      }
      if (filePath === "/proc/5651/stat") {
        return statLine(5651, "stranger", "667", 5650);
      }
      throw new Error("unexpected proc path");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5650, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      // The recycled root fails its children-read re-check, so no foreign
      // descendant is admitted. Because the PID was reused, the captured root
      // identity no longer matches at signal time either, so the snapshot is
      // not signaled at all (fail-closed) rather than risking a signal to the
      // replacement process.
      const realSignals = (
        killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>
      ).filter(([, signal]) => signal !== 0);
      expect(realSignals).toEqual([]);
      expect(realSignals.some(([pid]) => pid === 5651)).toBe(false);
    });
  });

  it("on Linux stops traversing once the PID cap is reached mid-list", async () => {
    // Bounds enforcement: a wide child list must stop adding descendants once
    // the 4,096-PID cap is reached, even when the cap is hit inside the loop
    // rather than at visit entry. The walker must not keep probing identities
    // or recursing past the advertised bound.
    const statLine = (pid: number, comm: string, starttime: string, ppid = 1) =>
      `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 0`;
    killSpy.mockImplementation(() => true);
    // The root reports 4,098 children so the 4,096-PID cap (which already
    // counts the root) is exceeded inside the child loop.
    const overCapChildren = Array.from({ length: 4098 }, (_, i) => 6000 + i).join(" ");
    const probedChildStats = new Set<number>();
    let boundedChildrenRequested = false;
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5999/task/5999/children") {
        boundedChildrenRequested = true;
        return overCapChildren;
      }
      if (filePath === "/proc/5999/stat") {
        return statLine(5999, "root", "100");
      }
      // Each child has no further descendants and reports the root as parent.
      const statMatch = filePath.match(/^\/proc\/(\d+)\/stat$/);
      if (statMatch) {
        const pid = Number(statMatch[1]);
        if (pid >= 6000) {
          probedChildStats.add(pid);
          return statLine(pid, "child", String(pid), 5999);
        }
      }
      if (/^\/proc\/\d+\/task\/\d+\/children$/.test(filePath)) {
        return "";
      }
      throw new Error("unexpected proc path");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5999, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      // The PID cap is honored: at most 4,095 children (root fills the 4,096th
      // slot) are ever probed or signaled. Children past the cap are never
      // admitted AND never have their identity probed.
      expect(probedChildStats.size).toBeLessThanOrEqual(4095);
      // The first over-cap child (index 4095 -> PID 10095) must never be probed.
      expect(probedChildStats.has(10095)).toBe(false);
      const signaledChildren = (
        killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>
      )
        .filter(([pid, signal]) => typeof pid === "number" && pid >= 6000 && signal !== 0)
        .map(([pid]) => pid);
      expect(new Set(signaledChildren).size).toBeLessThanOrEqual(4095);
      // The walker did read the root's children list, proving the loop ran but
      // honored the cap once seen.size reached it.
      expect(boundedChildrenRequested).toBe(true);
    });
  });

  it("on Linux rejects a child beyond the advertised depth cap", async () => {
    // Depth-cap boundary: a chain of exactly MAX_UNIX_PROCESS_TREE_DEPTH levels
    // (root at depth 0) must not admit a child one level beyond the cap. The
    // walker must evaluate the child's depth (parent depth + 1), not the
    // parent's, before probing or appending.
    const statLine = (pid: number, comm: string, starttime: string, ppid = 1) =>
      `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 0`;
    killSpy.mockImplementation(() => true);
    // Build a chain: 7000 (root) -> 7001 -> ... -> 7128 (depth 128). 7129 would
    // be depth 129, one beyond the cap, so it must never be probed or signaled.
    const chainPids = Array.from({ length: 129 }, (_, i) => 7000 + i);
    const overCapPid = 7129;
    const probedStats = new Set<number>();
    readFileSyncMock.mockImplementation((filePath: string) => {
      const childrenMatch = filePath.match(/^\/proc\/(\d+)\/task\/\d+\/children$/);
      if (childrenMatch) {
        const pid = Number(childrenMatch[1]);
        const idx = chainPids.indexOf(pid);
        if (idx >= 0 && idx < chainPids.length - 1) {
          return String(chainPids[idx + 1]);
        }
        if (idx === chainPids.length - 1) {
          // The depth-128 parent would expose the over-cap child.
          return String(overCapPid);
        }
        return "";
      }
      const statMatch = filePath.match(/^\/proc\/(\d+)\/stat$/);
      if (statMatch) {
        const pid = Number(statMatch[1]);
        probedStats.add(pid);
        const idx = chainPids.indexOf(pid);
        if (idx === 0) {
          return statLine(pid, "root", String(100 + idx));
        }
        if (idx > 0) {
          return statLine(pid, "desc", String(100 + idx), chainPids[idx - 1]);
        }
        if (pid === overCapPid) {
          return statLine(pid, "overcap", "999", chainPids[chainPids.length - 1]);
        }
      }
      throw new Error("unexpected proc path");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(7000, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      // The over-cap level-129 child is never probed and never signaled.
      expect(probedStats.has(overCapPid)).toBe(false);
      const realSignals = (
        killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>
      ).filter(([pid, signal]) => pid === overCapPid && signal !== 0);
      expect(realSignals).toHaveLength(0);
    });
  });

  it("on Unix force-escalates one attached snapshot without rebuilding it", async () => {
    const statLine = (pid: number, comm: string, starttime: string, ppid = 1) =>
      `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 0`;
    killSpy.mockImplementation(() => true);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5597/task/5597/children") {
        return "5598";
      }
      if (filePath === "/proc/5598/task/5598/children") {
        return "";
      }
      if (filePath === "/proc/5597/stat") {
        return statLine(5597, "root", "100");
      }
      if (filePath === "/proc/5598/stat") {
        return statLine(5598, "child", "101", 5597);
      }
      throw new Error("unexpected proc path");
    });

    await withMockedPlatform("linux", async () => {
      const termination = killProcessTree(5597, { graceMs: 10, detached: false });
      termination?.force();
      await vi.advanceTimersByTimeAsync(10);

      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).filter(
          ([, signal]) => signal !== 0,
        ),
      ).toEqual([
        [5598, "SIGTERM"],
        [5597, "SIGTERM"],
        [5598, "SIGKILL"],
        [5597, "SIGKILL"],
      ]);
    });
  });

  it("on Unix skips an attached descendant without an identity during escalation", async () => {
    const statLine = (pid: number, comm: string, starttime: string, ppid = 1) =>
      `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 0`;
    killSpy.mockImplementation(() => true);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5592/task/5592/children") {
        return "5593";
      }
      if (filePath === "/proc/5593/task/5593/children") {
        return "";
      }
      if (filePath === "/proc/5592/stat") {
        return statLine(5592, "root", "100");
      }
      throw new Error("child identity unavailable");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5592, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).not.toHaveBeenCalledWith(5593, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(5593, "SIGKILL");
      expect(killSpy).toHaveBeenCalledWith(5592, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(5592, "SIGKILL");
    });
  });

  it("on Linux skips attached-tree signaling when the root identity is unavailable", async () => {
    killSpy.mockImplementation(() => true);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5594/task/5594/children") {
        return "";
      }
      throw new Error("root identity unavailable");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5594, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(5594, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(5594, "SIGKILL");
    });
  });

  it("on Unix keeps an attached descendant snapshot after its root exits", async () => {
    const statLine = (pid: number, comm: string, starttime: string, ppid = 1) =>
      `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 0`;
    let rootAlive = true;
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && pid === 5595) {
        if (!rootAlive) {
          throw new Error("ESRCH");
        }
        return true;
      }
      return true;
    }) as typeof process.kill);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5595/task/5595/children") {
        return "5596";
      }
      if (filePath === "/proc/5596/task/5596/children") {
        return "";
      }
      if (filePath === "/proc/5595/stat") {
        return statLine(5595, "root", "100");
      }
      if (filePath === "/proc/5596/stat") {
        return statLine(5596, "child", "101", 5595);
      }
      throw new Error("unexpected proc path");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5595, { graceMs: 10, detached: false });
      rootAlive = false;
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(5596, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(5595, "SIGKILL");
    });
  });

  it("on Unix force-kills only the verified root when attached descendants cannot be enumerated", async () => {
    killSpy.mockImplementation(() => true);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5555/stat") {
        return "5555 (root) S 1 5555 5555 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 100 0";
      }
      throw new Error("descendant enumeration unavailable");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5555, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(5555, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(5555, "SIGKILL");
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).some(
          ([pid]) => typeof pid === "number" && pid < 0,
        ),
      ).toBe(false);
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
