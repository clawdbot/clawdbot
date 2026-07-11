// Host directory browsing for the new-session folder picker. operator.admin
// only (see core-descriptors): listing arbitrary host paths carries the same
// trust as starting a session with an explicit cwd.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  validateFsListDirParams,
  type FsDirEntry,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./types.js";

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

export const fsHandlers: GatewayRequestHandlers = {
  "fs.listDir": async ({ params, respond }) => {
    if (!validateFsListDirParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid fs parameters"));
      return;
    }
    const home = os.homedir();
    const requested = params.path?.trim() || home;
    if (!path.isAbsolute(requested)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "fs.listDir path must be absolute"),
      );
      return;
    }
    const resolved = path.resolve(requested);
    try {
      const entries = await listDirEntries(resolved);
      const parent = path.dirname(resolved);
      respond(
        true,
        {
          path: resolved,
          ...(parent !== resolved ? { parent } : {}),
          home,
          entries,
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(error)));
    }
  },
};
