import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Finds the checkout containing a directory, including linked worktrees. */
export function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);
  while (dir !== root) {
    if (
      existsSync(path.join(dir, ".git")) ||
      (existsSync(path.join(dir, "package.json")) &&
        existsSync(path.join(dir, "pnpm-workspace.yaml")))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

/** Resolves the repository root by walking upward from the caller module. */
export function resolveRepoRoot(importMetaUrl) {
  const callerDir = path.dirname(fileURLToPath(importMetaUrl));
  return findRepoRoot(callerDir) ?? path.resolve(callerDir, "..", "..");
}
