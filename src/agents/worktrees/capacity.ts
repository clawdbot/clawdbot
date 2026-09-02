import { statSync, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "../../infra/disk-space.js";
import { isMissingPathError } from "../../infra/errors.js";
import { requireGit } from "./git.js";

const GiB = 1024 ** 3;
export const WORKTREE_SETUP_HEADROOM_BYTES = 4 * GiB;

/** Admission estimates allocations, not a quota on arbitrary repository scripts or other writers. */
export function requireWorktreeDiskSpace(
  demands: readonly { path: string; bytes: number }[],
  purpose: string,
  snapshot = false,
): void {
  const volumes = new Map<
    number,
    { path: string; available: number; total: number; bytes: number }
  >();
  for (const demand of demands) {
    const space = tryReadDiskSpace(demand.path);
    if (!space || space.totalBytes === null) {
      throw new Error(
        `Cannot determine disk space near ${demand.path}; check the volume and retry ${purpose}.`,
      );
    }
    const device = statSync(space.checkedPath).dev;
    const existing = volumes.get(device);
    if (existing) {
      existing.available = Math.min(existing.available, space.availableBytes);
      existing.bytes += demand.bytes;
    } else {
      volumes.set(device, {
        path: space.checkedPath,
        available: space.availableBytes,
        total: space.totalBytes,
        bytes: demand.bytes,
      });
    }
  }
  for (const volume of volumes.values()) {
    // Cleanup must still be possible below the operational reserve, but never without snapshot room.
    const reserve = snapshot
      ? 128 * 1024 ** 2
      : Math.max(4 * GiB, Math.min(volume.total / 10, 16 * GiB));
    const required = reserve + volume.bytes;
    if (!Number.isSafeInteger(Math.ceil(required)) || volume.available < required) {
      throw new Error(
        `Insufficient disk space near ${volume.path} for ${purpose}: ${formatDiskSpaceBytes(volume.available)} available; approximately ${formatDiskSpaceBytes(required)} required including safety reserve. Free caches or archive/remove unused worktrees, then retry.`,
      );
    }
  }
}

export async function estimateWorktreeGitBytes(repoRoot: string, ref: string): Promise<number> {
  const commit = await requireGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref === "-" ? "@{-1}" : ref}^{commit}`,
  ]);
  const sizes = await requireGit(repoRoot, [
    "ls-tree",
    "-r",
    "--format=%(objectsize)",
    commit,
    "--",
  ]);
  let bytes = 0;
  for (const size of sizes.split("\n")) {
    if (!size || size === "-") {
      continue;
    }
    const value = Number(size);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        "Cannot estimate worktree checkout size; inspect the repository objects and retry.",
      );
    }
    bytes += Math.max(4096, Math.ceil(value / 4096) * 4096);
  }
  return bytes;
}

/** Measure without following links; unreadable trees must never be counted as empty. */
export async function directorySizeBytes(root: string, excludeGit = false): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return 0;
    }
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    if (excludeGit && entry.name === ".git") {
      continue;
    }
    const child = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      total += await directorySizeBytes(child, excludeGit);
    } else {
      try {
        total += (await fs.lstat(child)).size;
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
    }
  }
  return total;
}
