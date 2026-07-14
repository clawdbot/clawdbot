import path from "node:path";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { commandError, listGitWorktrees, runGit } from "./git.js";
import type { ManagedWorktreeRecord } from "./types.js";

const OPENCLAW_LOCK_PATTERN = /^openclaw pid=(\d+)$/;

type LockState =
  | { kind: "none" }
  | { kind: "live"; pid: number }
  | { kind: "dead"; pid: number }
  | { kind: "foreign"; reason: string };

export async function lockState(record: ManagedWorktreeRecord): Promise<LockState> {
  const entry = (await listGitWorktrees(record.repoRoot)).find(
    (candidate) => path.resolve(candidate.path) === path.resolve(record.path),
  );
  if (!entry || entry.lockedReason === undefined) {
    return { kind: "none" };
  }
  const match = OPENCLAW_LOCK_PATTERN.exec(entry.lockedReason);
  if (!match) {
    return { kind: "foreign", reason: entry.lockedReason };
  }
  const pid = Number(match[1]);
  // A cross-user (EPERM) OpenClaw lock is treated as live so a run's checkout is
  // never removed under it; only an ESRCH/zombie owner counts as dead.
  return isPidDefinitelyDead(pid) ? { kind: "dead", pid } : { kind: "live", pid };
}

export async function lockWorktreeForProcess(record: ManagedWorktreeRecord): Promise<void> {
  const result = await runGit(record.repoRoot, [
    "worktree",
    "lock",
    "--reason",
    `openclaw pid=${process.pid}`,
    record.path,
  ]);
  if (result.code !== 0) {
    const state = await lockState(record);
    if (state.kind !== "live" || state.pid !== process.pid) {
      throw commandError("git worktree lock", result);
    }
  }
}

export async function unlockWorktree(record: ManagedWorktreeRecord): Promise<void> {
  const result = await runGit(record.repoRoot, ["worktree", "unlock", record.path]);
  if (result.code !== 0) {
    throw commandError("git worktree unlock", result);
  }
}
