import fs from "node:fs/promises";
import path from "node:path";
import { ensureAbsoluteDirectory } from "../sdk-security-runtime.js";

async function resolveSystemDirectoryAlias(dirPath: string): Promise<string> {
  // macOS exposes /tmp and /var as fixed system symlinks into /private.
  // Canonicalize only those roots before rejecting symlinks below them.
  for (const aliasRoot of ["/tmp", "/var"]) {
    if (dirPath !== aliasRoot && !dirPath.startsWith(`${aliasRoot}${path.sep}`)) {
      continue;
    }
    try {
      const stat = await fs.lstat(aliasRoot);
      if (!stat.isSymbolicLink()) {
        return dirPath;
      }
      return path.join(await fs.realpath(aliasRoot), path.relative(aliasRoot, dirPath));
    } catch {
      return dirPath;
    }
  }
  return dirPath;
}

export async function ensureOutputDirectory(dirPath: string): Promise<void> {
  const result = await ensureAbsoluteDirectory(
    await resolveSystemDirectoryAlias(path.resolve(dirPath)),
    {
      scopeLabel: "output directory",
    },
  );
  if (!result.ok) {
    throw result.error;
  }
}
