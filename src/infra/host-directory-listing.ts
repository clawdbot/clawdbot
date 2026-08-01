// Directory-only host browsing shared by the Gateway and node-host runtimes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FsDirEntry, FsListDirResult } from "../../packages/gateway-protocol/src/index.js";

async function listDirEntries(dir: string): Promise<FsDirEntry[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const entries: FsDirEntry[] = [];
  for (const dirent of dirents) {
    const entryPath = path.join(dir, dirent.name);
    let isDirectory = dirent.isDirectory();
    if (dirent.isSymbolicLink()) {
      // Follow symlinks so linked checkouts stay pickable; unreadable targets drop out.
      isDirectory = await fs.stat(entryPath).then(
        (stat) => stat.isDirectory(),
        () => false,
      );
    }
    if (!isDirectory) {
      continue;
    }
    const hidden = dirent.name.startsWith(".");
    entries.push({ name: dirent.name, path: entryPath, ...(hidden ? { hidden: true } : {}) });
  }
  // Deterministic order for prompt-cache-friendly payloads: visible first, then byte-order names.
  entries.sort((a, b) => {
    if (Boolean(a.hidden) !== Boolean(b.hidden)) {
      return a.hidden ? 1 : -1;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return entries;
}

/** Lists one absolute host directory, defaulting to that host's home directory. */
export async function listHostDirectories(requestedPath?: string): Promise<FsListDirResult> {
  const home = os.homedir();
  const requested = requestedPath?.trim() || home;
  if (!path.isAbsolute(requested)) {
    throw new Error("fs.listDir path must be absolute");
  }
  const resolved = path.resolve(requested);
  const entries = await listDirEntries(resolved);
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    ...(parent !== resolved ? { parent } : {}),
    home,
    entries,
  };
}
