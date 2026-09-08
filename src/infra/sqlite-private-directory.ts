// Creates private SQLite staging directories without pulling higher-level runtime modules.
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveRequiredOsHomeDir } from "./home-dir.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { createPrivateWindowsDirectory } from "./windows-private-directory.js";

const SQLITE_DIRECTORY_MODE = 0o700;

export async function createPrivateSqliteDirectory(directoryPath: string): Promise<void> {
  if (process.platform !== "win32") {
    await fs.mkdir(directoryPath, { mode: SQLITE_DIRECTORY_MODE });
    return;
  }
  createPrivateWindowsDirectory(directoryPath);
}

export function resolvePrivateSqliteSnapshotStagingRoot(): string {
  const appData = process.platform === "win32" ? process.env.LOCALAPPDATA?.trim() : undefined;
  const defaultRoot = process.platform === "win32" ? "AppData/Local" : ".cache";
  const platformRoot = process.platform === "darwin" ? "Library/Caches" : defaultRoot;
  const cacheRoot =
    [process.env.XDG_CACHE_HOME?.trim(), appData].find((root) => root && path.isAbsolute(root)) ??
    path.join(resolveRequiredOsHomeDir(), platformRoot);
  return resolvePreferredOpenClawTmpDir({
    preferredDir: path.join(cacheRoot, "openclaw"),
    tmpdir: () => cacheRoot,
  });
}

export async function createPrivateSqliteTempDirectory(
  rootPath: string,
  prefix: string,
): Promise<string> {
  if (process.platform !== "win32") {
    return await fs.mkdtemp(path.join(rootPath, prefix));
  }
  const directoryPath = path.join(rootPath, `${prefix}${randomUUID()}`);
  await createPrivateSqliteDirectory(directoryPath);
  return directoryPath;
}

export function createPrivateSqliteTempDirectorySync(rootPath: string, prefix: string): string {
  if (process.platform !== "win32") {
    return fsSync.mkdtempSync(path.join(rootPath, prefix));
  }
  const directoryPath = path.join(rootPath, `${prefix}${randomUUID()}`);
  createPrivateWindowsDirectory(directoryPath);
  return directoryPath;
}
