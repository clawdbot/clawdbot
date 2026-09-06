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
  DEFAULT_RETAIN_POLL_MS,
  reapOwnedChildZombies,
  reapOwnedChildZombiesAfterTreeKill,
  retainAdoptedChildZombieCleanup,
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

function findZombieChild(ppid: number): ProcRow | undefined {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const row = readProcRow(Number(entry));
    if (row && row.ppid === ppid && row.state.startsWith("Z")) {
      return row;
    }
  }
  return undefined;
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

function enableChildSubreaper(): void {
  const koffi = require("koffi") as typeof import("koffi").default;
  const libc = koffi.load(null);
  const prctl = libc.func("int prctl(int option, unsigned long arg2)");
  const rc = prctl(36, 1) as number;
  if (rc !== 0) {
    throw new Error(`prctl(PR_SET_CHILD_SUBREAPER) failed (errno ${koffi.errno()})`);
  }
}

describe("scoped-child-reaper", () => {
  const activeForeign: ChildProcess[] = [];
  const retainHandles: Array<{ stop: () => void }> = [];

  afterEach(async () => {
    setOwnedChildWaitPidBindingsForTests(undefined);
    for (const handle of retainHandles.splice(0)) {
      handle.stop();
    }
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

  it("paces retained scans via pollIntervalMs and stops clear timers", async () => {
    expect(DEFAULT_RETAIN_POLL_MS).toBeGreaterThan(0);
    let scheduled = 0;
    const handle = retainAdoptedChildZombieCleanup({
      rootPid: 1,
      maxRetainMs: 500,
      pollIntervalMs: 30,
      schedule: (callback) => {
        scheduled += 1;
        const timer = setTimeout(callback, 30);
        timer.unref?.();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    handle.stop();
    const afterStop = scheduled;
    await new Promise((resolve) => setTimeout(resolve, 80));
    // stop() should prevent further schedule growth from in-flight ticks finishing cleanly
    expect(scheduled).toBeGreaterThanOrEqual(1);
    expect(scheduled).toBeLessThanOrEqual(afterStop + 1);
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
    expect(readProcRow(foreignPid)?.ppid).toBe(foreign.pid);
    expect(readProcRow(foreignPid)?.ppid).not.toBe(process.pid);

    const result = reapOwnedChildZombies({ pids: [owned.pid] });
    expect(result.reaped).toContain(owned.pid);
    expect(result.reaped).not.toContain(foreignPid);
    await waitFor(() => readProcRow(owned.pid) === undefined, 5_000, "owned gone");
    expect(readProcRow(foreignPid)?.state.startsWith("Z")).toBe(true);
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

  linuxIt("retains cleanup across delayed adoption past first root-exit scan", async () => {
    enableChildSubreaper();
    const child = spawnChild(
      "python3",
      [
        "-u",
        "-c",
        [
          "import os, time",
          "mid = os.fork()",
          "if mid == 0:",
          "    z = os.fork()",
          "    if z == 0:",
          "        os._exit(0)",
          "    time.sleep(0.7)",
          "    os._exit(0)",
          "print(f'{os.getpid()} {mid} {os.getpgid(0)}', flush=True)",
          "time.sleep(60)",
        ].join("\n"),
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const line = await new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.stdout!.once("data", (chunk) => resolve(String(chunk).trim()));
    });
    const [rootPid, midPid, pgid] = line.split(/\s+/).map(Number);
    expect(rootPid).toBe(child.pid);
    expect(pgid).toBe(rootPid);

    await waitFor(() => Boolean(findZombieChild(midPid)), 5_000, "zombie under mid");
    const adoptedPid = findZombieChild(midPid)!.pid;
    expect(readProcRow(adoptedPid)).toMatchObject({
      pid: adoptedPid,
      ppid: midPid,
      pgid,
    });

    process.kill(rootPid, "SIGKILL");
    void new Promise<void>((resolve) => child.once("close", () => resolve()));
    await waitFor(() => readProcRow(rootPid) === undefined, 5_000, "root gone");
    await waitFor(
      () =>
        readProcRow(midPid)?.ppid === process.pid &&
        readProcRow(midPid)?.state.startsWith("Z") !== true,
      5_000,
      "mid live under self",
    );
    expect(readProcRow(adoptedPid)?.ppid).toBe(midPid);

    const first = reapOwnedChildZombiesAfterTreeKill({
      rootPid: pgid,
      usedProcessGroup: true,
      excludeTrackedPids: [rootPid],
    });
    expect(first.reaped).not.toContain(adoptedPid);

    retainHandles.push(
      retainAdoptedChildZombieCleanup({
        rootPid: pgid,
        excludeTrackedPids: [rootPid],
        maxRetainMs: 10_000,
      }),
    );

    await waitFor(() => {
      const row = readProcRow(adoptedPid);
      return row === undefined || row.ppid === process.pid;
    }, 5_000, "delayed adoption to self");
    const adopted = readProcRow(adoptedPid);
    if (adopted) {
      expect(adopted).toMatchObject({ pid: adoptedPid, ppid: process.pid, pgid });
      expect(adopted.state.startsWith("Z")).toBe(true);
    }
    await waitFor(() => readProcRow(adoptedPid) === undefined, 5_000, "delayed adopted reaped");
    if (readProcRow(midPid)?.state.startsWith("Z")) {
      reapOwnedChildZombies({ pgids: [pgid], pids: [midPid] });
    }
  });

  linuxIt(
    "production path: adopted descendant removed; Node close; unrelated preserved",
    async () => {
      enableChildSubreaper();
      const unrelated = forkUntrackedZombie();
      await waitFor(
        () => readProcRow(unrelated.pid)?.state.startsWith("Z") === true,
        5_000,
        "unrelated zombie",
      );

      const child = spawnChild(
        "python3",
        [
          "-u",
          "-c",
          [
            "import os, time, signal",
            "mid = os.fork()",
            "if mid == 0:",
            "    signal.signal(signal.SIGTERM, signal.SIG_IGN)",
            "    signal.signal(signal.SIGHUP, signal.SIG_IGN)",
            "    z = os.fork()",
            "    if z == 0:",
            "        os._exit(0)",
            "    time.sleep(0.7)",
            "    os._exit(0)",
            "print(f'root={os.getpid()} mid={mid} pgid={os.getpgid(0)}', flush=True)",
            "time.sleep(60)",
          ].join("\n"),
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const metaLine = await new Promise<string>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.once("data", (chunk) => resolve(String(chunk).trim()));
      });
      const meta = Object.fromEntries(
        metaLine.split(/\s+/).map((part) => {
          const [k, v] = part.split("=");
          return [k, Number(v)];
        }),
      ) as { root: number; mid: number; pgid: number };
      expect(meta.root).toBe(child.pid);

      await waitFor(() => Boolean(findZombieChild(meta.mid)), 5_000, "prod grandchild zombie");
      const adoptedPid = findZombieChild(meta.mid)!.pid;
      expect(readProcRow(adoptedPid)).toMatchObject({
        pid: adoptedPid,
        ppid: meta.mid,
        pgid: meta.pgid,
      });

      let close: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      child.once("close", (code, signal) => {
        close = { code, signal };
      });
      signalChildProcessTree(child, "SIGTERM");
      await waitFor(() => readProcRow(adoptedPid) === undefined, 8_000, "adopted descendant reaped");
      await waitFor(() => close !== undefined, 8_000, "node close");
      expect(
        close?.signal === "SIGTERM" || close?.code === null || (close?.code ?? 0) !== 0,
      ).toBe(true);

      expect(readProcRow(unrelated.pid)?.state.startsWith("Z")).toBe(true);
      expect(readProcRow(meta.root)?.state.startsWith("Z") ?? false).toBe(false);

      expect(reapOwnedChildZombies({ pids: [unrelated.pid] }).reaped).toContain(unrelated.pid);
      await waitFor(() => readProcRow(unrelated.pid) === undefined, 5_000, "unrelated cleanup");
    },
  );
});
