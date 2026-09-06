import fs from "node:fs";
import path from "node:path";
import { resolveRealpathOrAbsolute as canonicalizePathForComparison } from "../../infra/boundary-path.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { isMigrationArchiveArtifactName } from "./artifacts.js";
import { listDurableSqliteTargetPathsForSessionStorePath } from "./session-sqlite-target.js";

export type SessionPhysicalDiskUsage = {
  databaseMainBytes: number;
  databaseWalBytes: number;
  sessionFilesBytes: number;
  totalBytes: number;
};

export type SessionsDirFileStat = {
  path: string;
  canonicalPath: string;
  name: string;
  size: number;
  mtimeMs: number;
};

const SESSIONS_DIR_STAT_CONCURRENCY = 8;

export async function readSessionsDirFiles(sessionsDir: string): Promise<SessionsDirFileStat[]> {
  const dirEntries = await fs.promises
    .readdir(sessionsDir, { withFileTypes: true })
    .catch(() => []);
  // Skip rollback archives before concurrent stats so retained bytes cannot evict live sessions.
  const tasks = dirEntries
    .filter((dirent) => dirent.isFile() && !isMigrationArchiveArtifactName(dirent.name))
    .map((dirent) => async (): Promise<SessionsDirFileStat | null> => {
      const filePath = path.join(sessionsDir, dirent.name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        return null;
      }
      return {
        path: filePath,
        canonicalPath: canonicalizePathForComparison(filePath),
        name: dirent.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    });
  const { results } = await runTasksWithConcurrency({
    tasks,
    limit: SESSIONS_DIR_STAT_CONCURRENCY,
  });
  return results.filter((file): file is SessionsDirFileStat => Boolean(file));
}

async function readSqliteDatabaseFiles(
  databasePaths: readonly string[],
): Promise<SessionsDirFileStat[]> {
  const files: SessionsDirFileStat[] = [];
  for (const databasePath of databasePaths) {
    for (const filePath of [databasePath, `${databasePath}-wal`]) {
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      files.push({
        path: filePath,
        canonicalPath: canonicalizePathForComparison(filePath),
        name: path.basename(filePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  return files;
}

/** Measures current physical session artifacts plus the agent SQLite main file and WAL. */
export async function readSessionPhysicalDiskUsage(
  storePath: string,
): Promise<SessionPhysicalDiskUsage> {
  const sessionsDirFiles = await readSessionsDirFiles(path.dirname(storePath));
  const promptBlobFiles = await readSessionPromptBlobFiles(path.dirname(storePath));
  // Owner inspection may create SQLite SHM files. Preserve its original position
  // after the artifact inventory so a measurement cannot count its own side effects.
  const databaseFiles = await readSqliteDatabaseFiles(
    listDurableSqliteTargetPathsForSessionStorePath(storePath),
  );
  const databaseMainPaths = new Set(
    databaseFiles.filter((file) => !file.path.endsWith("-wal")).map((file) => file.canonicalPath),
  );
  const databaseWalPaths = new Set(
    databaseFiles.filter((file) => file.path.endsWith("-wal")).map((file) => file.canonicalPath),
  );
  const uniqueFiles = new Map<string, SessionsDirFileStat>();
  for (const file of [...sessionsDirFiles, ...promptBlobFiles, ...databaseFiles]) {
    uniqueFiles.set(file.canonicalPath, file);
  }
  const databaseMainBytes = [...databaseMainPaths].reduce(
    (sum, databasePath) => sum + (uniqueFiles.get(databasePath)?.size ?? 0),
    0,
  );
  const databaseWalBytes = [...databaseWalPaths].reduce(
    (sum, databasePath) => sum + (uniqueFiles.get(databasePath)?.size ?? 0),
    0,
  );
  const totalBytes = [...uniqueFiles.values()].reduce((sum, file) => sum + file.size, 0);
  return {
    databaseMainBytes,
    databaseWalBytes,
    sessionFilesBytes: totalBytes - databaseMainBytes - databaseWalBytes,
    totalBytes,
  };
}

export async function readSessionPromptBlobFiles(
  sessionsDir: string,
): Promise<SessionsDirFileStat[]> {
  const root = path.join(sessionsDir, "skills-prompts", "sha256");
  const prefixEntries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  const files: SessionsDirFileStat[] = [];
  for (const prefixEntry of prefixEntries) {
    if (!prefixEntry.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefixEntry.name)) {
      continue;
    }
    const prefixDir = path.join(root, prefixEntry.name);
    const blobEntries = await fs.promises
      .readdir(prefixDir, { withFileTypes: true })
      .catch(() => []);
    for (const blobEntry of blobEntries) {
      if (
        !blobEntry.isFile() ||
        (!/^[a-f0-9]{64}\.txt$/u.test(blobEntry.name) &&
          !isSessionPromptBlobTempArtifactName(blobEntry.name))
      ) {
        continue;
      }
      const filePath = path.join(prefixDir, blobEntry.name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      files.push({
        path: filePath,
        canonicalPath: canonicalizePathForComparison(filePath),
        name: blobEntry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  return files;
}

export function isSessionPromptBlobTempArtifactName(name: string): boolean {
  return /^[a-f0-9]{64}\.txt\.(?:\d+\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u.test(
    name,
  );
}
