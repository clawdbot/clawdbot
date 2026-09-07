import type { ChildProcess } from "node:child_process";
import { vi } from "vitest";
import { waitForChildClose } from "../../test/helpers/process-wait.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";

/** Reap only descendants of the fixture's still-live child handles, including detached workers. */
export function createManagedServiceBoundaryCleanup(
  children: () => Array<ChildProcess | undefined>,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= cleanup());

  async function cleanup() {
    const { execFileSync } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const active = children().filter((child): child is ChildProcess =>
      Boolean(child && child.exitCode === null && child.signalCode === null),
    );
    if (!active.length) {
      return;
    }
    const rows = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 1_000,
    })
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, parentPid] = line.trim().split(/\s+/).map(Number);
        return { pid: pid ?? 0, parentPid: parentPid ?? 0 };
      });
    const owned = new Set(active.map((child) => child.pid));
    const descendants: Array<{ pid: number; identity: number | null }> = [];
    for (let previousSize = 0; previousSize !== owned.size;) {
      previousSize = owned.size;
      for (const row of rows) {
        if (owned.has(row.parentPid) && !owned.has(row.pid)) {
          owned.add(row.pid);
          descendants.push({ pid: row.pid, identity: getFileLockProcessStartTime(row.pid) });
        }
      }
    }
    const closed = active.map((child) => waitForChildClose(child));
    for (const { pid, identity } of descendants.toReversed()) {
      if (identity !== null && getFileLockProcessStartTime(pid) === identity) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    for (const child of active) {
      child.kill("SIGKILL");
    }
    await Promise.all(closed);
  }
}
