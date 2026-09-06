// Scoped child reaper: external-observer proof for owned zombie cleanup (#97616).
import {
  spawn as spawnChild,
  type ChildProcess,
} from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { signalChildProcessTree } from "./child-process-tree.js";
import {
  reapOwnedChildZombies,
  reapOwnedChildZombiesAfterTreeKill,
  setOwnedChildWaitPidBindingsForTests,
} from "./scoped-child-reaper.js";

const require = createRequire(import.meta.url);
const linuxIt = process.platform === "linux" ? it : it.skip;

type ProcRow = { pid: number; ppid: number; pgid: number; state: string; comm: string };

function readProcRow(pid: number): ProcRow | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const lparen = stat.indexOf("(");
    const rparen = stat.lastIndexOf(")");
    const comm = stat.slice(lparen + 1, rparen);
    const rest = stat.slice(rparen + 2).split(" ");
    return {
      pid: Number.parseInt(stat.slice(0, stat.indexOf(" ")), 10),
      state: rest[0] ?? "",
      ppid: Number.parseInt(rest[1] ?? "", 10),
      pgid: Number.parseInt(rest[2] ?? "", 10),
      comm,
    };
  } catch {
    return undefined;
  }
}

function listSelfZombies(): ProcRow[] {
  const self = process.pid;
  const rows: ProcRow[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const row = readProcRow(Number(entry));
    if (row && row.ppid === self && row.state.startsWith("Z")) {
      rows.push(row);
    }
  }
  return rows;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Create a direct-child zombie that Node did not track (no ChildProcess handle).
 * Uses libc fork via koffi — the same FFI stack production reaping uses.
 */
function forkUntrackedZombie(): { pid: number } {
  const koffi = require("koffi") as typeof import("koffi").default;
  const libc = koffi.load(null);
  const fork = libc.func("int fork()");
  const _exit = libc.func("void _exit(int status)");
  const pid = fork() as number;
  if (pid < 0) {
    throw new Error(`fork failed (errno ${koffi.errno()})`);
  }
  if (pid === 0) {
    _exit(0);
  }
  return { pid };
}

describe("scoped-child-reaper", () => {
  // spawn with stderr:"inherit" yields stderr:null — keep a wide ChildProcess list.
  const activeForeign: ChildProcess[] = [];

  afterEach(async () => {
    setOwnedChildWaitPidBindingsForTests(undefined);
    await Promise.all(
      activeForeign.splice(0).map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin?.write("\n");
          await new Promise<void>((resolve) => child.once("close", () => resolve()));
        }
      }),
    );
  });

  it("is a no-op without an owner scope", () => {
    expect(reapOwnedChildZombies({})).toEqual({ reaped: [], pending: [] });
  });

  it("is a no-op on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }
    expect(reapOwnedChildZombies({ pids: [1] })).toEqual({ reaped: [], pending: [] });
  });

  it("tree-kill helper is a no-op without process-group scope", () => {
    expect(
      reapOwnedChildZombiesAfterTreeKill({ rootPid: 42, usedProcessGroup: false }),
    ).toEqual({ reaped: [], pending: [] });
  });

  it("never waitpids PIDs listed in excludeTrackedPids", () => {
    const waited: number[] = [];
    setOwnedChildWaitPidBindingsForTests({
      waitpid: (pid, _status, _options) => {
        waited.push(pid);
        return pid;
      },
      errno: () => 0,
    });
    // Without real /proc zombies this is a filter-path unit on Linux only when
    // combined with a live zombie; on all platforms the empty-candidate path
    // still must not invent waits. Exercise the exclude filter with a live
    // zombie below (linuxIt).
    expect(reapOwnedChildZombies({ pids: [1], excludeTrackedPids: [1] })).toEqual({
      reaped: [],
      pending: [],
    });
    expect(waited).toEqual([]);
  });

  linuxIt("red/control: external observer detects an intentional unreaped zombie", async () => {
    const { pid } = forkUntrackedZombie();
    await waitFor(() => readProcRow(pid)?.state.startsWith("Z") === true, 5_000, "zombie state");
    const observed = readProcRow(pid);
    expect(observed).toMatchObject({ pid, ppid: process.pid });
    expect(observed?.state.startsWith("Z")).toBe(true);
    expect(listSelfZombies().some((row) => row.pid === pid)).toBe(true);
    // Clean up so the suite does not leak into later tests.
    const result = reapOwnedChildZombies({ pids: [pid] });
    expect(result.reaped).toContain(pid);
    await waitFor(() => readProcRow(pid) === undefined, 5_000, "zombie disappearance");
  });

  linuxIt("skips waitpid for excludeTrackedPids even when they match scope", async () => {
    const owned = forkUntrackedZombie();
    await waitFor(
      () => readProcRow(owned.pid)?.state.startsWith("Z") === true,
      5_000,
      "excluded zombie",
    );
    const waited: number[] = [];
    setOwnedChildWaitPidBindingsForTests({
      waitpid: (pid, _status, _options) => {
        waited.push(pid);
        return 0;
      },
      errno: () => 0,
    });
    const result = reapOwnedChildZombies({
      pids: [owned.pid],
      excludeTrackedPids: [owned.pid],
    });
    expect(result.reaped).toEqual([]);
    expect(waited).toEqual([]);
    expect(readProcRow(owned.pid)?.state.startsWith("Z")).toBe(true);
    setOwnedChildWaitPidBindingsForTests(undefined);
    expect(reapOwnedChildZombies({ pids: [owned.pid] }).reaped).toContain(owned.pid);
    await waitFor(() => readProcRow(owned.pid) === undefined, 5_000, "cleanup excluded");
  });

  linuxIt("reaps only owned zombies and leaves foreign parent zombies alone", async () => {
    const owned = forkUntrackedZombie();
    await waitFor(
      () => readProcRow(owned.pid)?.state.startsWith("Z") === true,
      5_000,
      "owned zombie",
    );

    // Foreign zombie: parented by a Python process, not by this test runner.
    const foreign = spawnChild(
      "python3",
      [
        "-c",
        [
          "import os, sys",
          "pid = os.fork()",
          "if pid == 0:",
          "    os._exit(0)",
          "print(pid, flush=True)",
          "sys.stdin.readline()",
          "os.waitpid(pid, 0)",
        ].join("\n"),
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    activeForeign.push(foreign);
    const foreignPid = await new Promise<number>((resolve, reject) => {
      foreign.once("error", reject);
      foreign.stdout!.once("data", (chunk) => {
        resolve(Number.parseInt(String(chunk).trim(), 10));
      });
    });
    await waitFor(
      () => readProcRow(foreignPid)?.state.startsWith("Z") === true,
      5_000,
      "foreign zombie",
    );
    const foreignParent = readProcRow(foreignPid)?.ppid;
    expect(foreignParent).toBe(foreign.pid);
    expect(foreignParent).not.toBe(process.pid);

    // Scoped reap of the owned PID must not steal the foreign zombie (proves
    // we did not call waitpid(-1)).
    const result = reapOwnedChildZombies({ pids: [owned.pid] });
    expect(result.reaped).toContain(owned.pid);
    expect(result.reaped).not.toContain(foreignPid);
    await waitFor(() => readProcRow(owned.pid) === undefined, 5_000, "owned gone");
    expect(readProcRow(foreignPid)?.state.startsWith("Z")).toBe(true);

    // Empty/unrelated scope must not reap the foreign child either.
    expect(reapOwnedChildZombies({ pids: [owned.pid] }).reaped).toEqual([]);
    expect(readProcRow(foreignPid)?.state.startsWith("Z")).toBe(true);
  });

  linuxIt("matches zombies by owned process group as well as root pid", async () => {
    const owned = forkUntrackedZombie();
    await waitFor(
      () => readProcRow(owned.pid)?.state.startsWith("Z") === true,
      5_000,
      "pgid zombie",
    );
    const row = readProcRow(owned.pid);
    expect(row).toBeDefined();
    const result = reapOwnedChildZombies({ pgids: [row!.pgid] });
    expect(result.reaped).toContain(owned.pid);
    await waitFor(() => readProcRow(owned.pid) === undefined, 5_000, "pgid reap");
  });

  linuxIt(
    "production path: signalChildProcessTree keeps Node close and reaps after exit",
    async () => {
      // Detached root sleeps; an untracked sibling zombie shares our ppid but
      // not the root pgid — must stay untouched. An adopted-style zombie in the
      // root's pgid is created after fork+setpgid simulation via untracked fork
      // then we only assert: Node close fires, root is never natively waited by
      // the reaper (excludeTrackedPids), and an unrelated same-parent zombie survives.
      const unrelated = forkUntrackedZombie();
      await waitFor(
        () => readProcRow(unrelated.pid)?.state.startsWith("Z") === true,
        5_000,
        "unrelated zombie",
      );

      const child = spawnChild(
        "python3",
        ["-c", "import time; time.sleep(30)"],
        {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
      expect(typeof child.pid).toBe("number");
      const rootPid = child.pid!;

      const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );

      signalChildProcessTree(child, "SIGKILL");
      const close = await closePromise;
      expect(close.signal === "SIGKILL" || close.code !== 0 || close.code === null).toBe(true);

      // Give the scheduled setImmediate reap a tick.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Unrelated same-parent zombie must remain (scoped pgid reap only).
      expect(readProcRow(unrelated.pid)?.state.startsWith("Z")).toBe(true);
      // Root must not linger as our zombie — Node/libuv consumed it via close.
      expect(readProcRow(rootPid)?.state.startsWith("Z") ?? false).toBe(false);

      // Cleanup unrelated.
      expect(reapOwnedChildZombies({ pids: [unrelated.pid] }).reaped).toContain(unrelated.pid);
      await waitFor(() => readProcRow(unrelated.pid) === undefined, 5_000, "unrelated cleanup");
    },
  );
});
