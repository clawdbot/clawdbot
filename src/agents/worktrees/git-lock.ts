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

function heldByThisProcess(state: LockState): boolean {
  return state.kind === "live" && state.pid === process.pid;
}

async function runLock(record: ManagedWorktreeRecord) {
  return await runGit(record.repoRoot, [
    "worktree",
    "lock",
    "--reason",
    `openclaw pid=${process.pid}`,
    record.path,
  ]);
}

export async function lockWorktreeForProcess(record: ManagedWorktreeRecord): Promise<void> {
  const result = await runLock(record);
  if (result.code === 0) {
    return;
  }
  const state = await lockState(record);
  if (heldByThisProcess(state)) {
    return;
  }
  // A lock naming a dead OpenClaw pid is restart residue: the owner died (crash or
  // update restart) without unlocking, so git refuses every later lock forever and
  // the run would otherwise proceed unprotected. remove()/release() already treat a
  // dead owner as reclaimable, so reclaim it here instead of failing the acquire.
  // Accepted tradeoff: the observe-then-unlock window is the same one those two
  // callers already take, so two processes reclaiming the identical stale lock at
  // once can both believe they won. Closing it needs one reclaim guard shared by all
  // four paths -- this acquire plus service.ts release(), remove(), and
  // isProtectedFromAutoRemoval() (openclaw#114129); today's behavior instead loses
  // the lock every time.
  if (state.kind !== "dead") {
    throw commandError("git worktree lock", result);
  }
  await unlockWorktree(record);
  const retry = await runLock(record);
  if (retry.code !== 0 && !heldByThisProcess(await lockState(record))) {
    throw commandError("git worktree lock", retry);
  }
}

export async function unlockWorktree(record: ManagedWorktreeRecord): Promise<void> {
  const result = await runGit(record.repoRoot, ["worktree", "unlock", record.path]);
  if (result.code !== 0) {
    throw commandError("git worktree unlock", result);
  }
}
