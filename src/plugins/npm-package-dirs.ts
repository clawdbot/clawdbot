import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";

export async function listNpmPackageDirs(
  npmRoot: string,
  options: {
    includeEntry: (entry: Dirent, scoped: boolean) => boolean;
    sortEntries?: boolean;
  },
): Promise<string[]> {
  const readEntries = async (dir: string): Promise<Dirent[]> => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return options.sortEntries
        ? entries.toSorted((left, right) => left.name.localeCompare(right.name))
        : entries;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
  };
  const nodeModulesDir = path.join(npmRoot, "node_modules");
  const packageDirs: string[] = [];
  for (const entry of await readEntries(nodeModulesDir)) {
    if (!options.includeEntry(entry, false)) {
      continue;
    }
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scopedEntry of await readEntries(entryPath)) {
        if (options.includeEntry(scopedEntry, true)) {
          packageDirs.push(path.join(entryPath, scopedEntry.name));
        }
      }
    } else {
      packageDirs.push(entryPath);
    }
  }
  return packageDirs;
}
