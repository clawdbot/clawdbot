import fs from "node:fs";
import path from "node:path";

export function resolveEmbeddedSessionFileKey(sessionFile: string): string {
  const resolvedSessionFile = path.resolve(sessionFile);
  const realpathSync = fs.realpathSync.native ?? fs.realpathSync;
  try {
    return realpathSync(resolvedSessionFile);
  } catch {
    // New transcript files often do not exist yet. Canonicalize the existing
    // parent so aliases still collapse before the first write creates the file.
  }
  const sessionDir = path.dirname(resolvedSessionFile);
  try {
    return path.join(realpathSync(sessionDir), path.basename(resolvedSessionFile));
  } catch {
    return resolvedSessionFile;
  }
}
