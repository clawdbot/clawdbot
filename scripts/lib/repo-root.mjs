import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolves the repository root by walking upward from the caller module. */
export function resolveRepoRoot(importMetaUrl) {
  let dir = path.dirname(fileURLToPath(importMetaUrl));
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
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..", "..");
}
