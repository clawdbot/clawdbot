// Scoped child reaper: external-observer proof for owned zombie cleanup (#97616).
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  reapOwnedChildZombies,
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
  const activeForeign: ChildProcessWithoutNullStreams[] = [];

  afterEach(async () => {
    setOwnedChildWaitPidBindingsForTests(undefined);
    await Promise.all(
      activeForeign.splice(0).map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin.write("\n");
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
      foreign.stdout.once("data", (chunk) => {
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
});
