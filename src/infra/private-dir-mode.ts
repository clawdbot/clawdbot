// Shared directory-permission tightening for OpenClaw-owned private roots.
// fs-safe 0.8 no longer repairs existing directory modes; these helpers keep
// OpenClaw's documented behavior of tightening its own directories before
// writing secrets. Every component is opened no-follow and chmodded through
// the pinned descriptor, so a swapped or symlinked directory is never
// mutated — fs-safe rejects those itself.
//
// Residual bound: Node has no dirfd-relative open, so traversal between
// components is by absolute pathname and an already-visited ancestor replaced
// mid-walk by a same-principal process can redirect a later component open.
// That actor already holds write access to the containing directory tree, so
// no privilege boundary is crossed; the final secret write is still validated
// by fs-safe against the real path.
import fsSync, { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const OPEN_DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY;

/** Tighten every existing directory from `rootDir` down to `targetDir`. */
export async function tightenPrivateDirChain(
  rootDir: string,
  targetDir: string,
  mode: number,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const root = path.resolve(rootDir);
  const parent = path.resolve(targetDir);
  const relative = path.relative(root, parent);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return;
  }
  const chain: string[] = [root];
  if (relative) {
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      chain.push(current);
    }
  }
  for (const dir of chain) {
    let handle;
    try {
      handle = await fs.open(dir, OPEN_DIR_FLAGS);
    } catch {
      return; // Missing parents are created by fs-safe at the private mode; symlinked or non-directory components are rejected by it.
    }
    try {
      const stat = await handle.stat();
      if ((stat.mode & 0o777) !== mode) {
        await handle.chmod(mode);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

/** Tighten a single existing directory root. */
export function tightenPrivateDirRootSync(rootDir: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }
  let fd: number | undefined;
  try {
    fd = fsSync.openSync(rootDir, OPEN_DIR_FLAGS);
    const stat = fsSync.fstatSync(fd);
    if ((stat.mode & 0o777) !== mode) {
      fsSync.fchmodSync(fd, mode);
    }
  } catch {
    // Missing, symlinked, or non-directory roots are created or rejected by fs-safe.
  } finally {
    if (fd !== undefined) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // Best-effort close; the descriptor carries no further state.
      }
    }
  }
}
