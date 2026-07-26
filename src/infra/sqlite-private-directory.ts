// Creates private SQLite staging directories without pulling higher-level runtime modules.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createPrivateDirectory } from "./permissions.js";

const SQLITE_DIRECTORY_MODE = 0o700;

export async function createPrivateSqliteDirectory(directoryPath: string): Promise<void> {
  if (process.platform !== "win32") {
    await fs.mkdir(directoryPath, { mode: SQLITE_DIRECTORY_MODE });
    return;
  }
  const nativeDirectoryPath = path.toNamespacedPath(path.resolve(directoryPath));
  try {
    await createPrivateDirectory(nativeDirectoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existsError = new Error(`Private SQLite directory already exists: ${directoryPath}`);
      (existsError as NodeJS.ErrnoException).code = "EEXIST";
      throw existsError;
    }
    throw new Error(`Unable to create private Windows SQLite directory: ${directoryPath}`, {
      cause: error,
    });
  }
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
