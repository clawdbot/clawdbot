import fs from "node:fs";
import path from "node:path";

export function toWatchRoot(raw: string): string {
  const normalized = raw.replaceAll("\\", "/");
  const root = path.parse(normalized).root;
  const trimmed = normalized.replace(/\/+$/, "");
  // A missing path can anchor at a drive root; C: would watch the drive's cwd.
  return trimmed.length < root.length ? root : trimmed;
}

export function resolveSkillsWatchPath(raw: string): string {
  if (process.platform !== "win32") {
    return raw;
  }
  const absolute = path.resolve(raw);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep);
  let cursor = root;
  let index = 0;
  // libuv cannot watch 8.3 directory aliases safely. Expand only the ordinary
  // existing prefix: following a symlink here would bypass followSymlinks:false
  // and the refresh owner's separate trusted skill-target resolution.
  for (const part of parts) {
    const next = path.join(cursor, part);
    try {
      if (fs.lstatSync(next).isSymbolicLink()) {
        break;
      }
    } catch {
      break;
    }
    cursor = next;
    index += 1;
  }
  try {
    return path.join(fs.realpathSync.native(cursor), ...parts.slice(index));
  } catch {
    return raw;
  }
}
