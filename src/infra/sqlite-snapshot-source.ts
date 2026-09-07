// Keep source lifetime pinned while the snapshot owner consumes live or private bytes.
import fs, { type BigIntStats } from "node:fs";
import { prepareSqliteReadOnlyLocation } from "./sqlite-readonly-location.js";
import { withSqliteSourceHandleAsync } from "./sqlite-source-handle.js";

type PreparedSqliteReadOnlyLocation = Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>>;

async function prepareSqliteSnapshotSource(
  pathname: string,
): Promise<PreparedSqliteReadOnlyLocation | undefined> {
  const canonicalPath = fs.realpathSync.native(pathname);
  const journalPath = `${canonicalPath}-journal`;
  let journal: BigIntStats;
  try {
    journal = fs.lstatSync(journalPath, { bigint: true });
  } catch (error) {
    // SAFETY: lstatSync on this canonical string path reports Node errno failures.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!journal.isFile()) {
    throw new Error(`SQLite rollback journal must be a regular file: ${journalPath}`);
  }
  return await prepareSqliteReadOnlyLocation(canonicalPath);
}

export async function withSqliteSnapshotSource<T>(
  pathname: string,
  operation: (sourcePath: string) => Promise<T>,
): Promise<T> {
  let prepared = await prepareSqliteSnapshotSource(pathname);
  try {
    try {
      return prepared
        ? await operation(prepared.location)
        : await withSqliteSourceHandleAsync(pathname, () => operation(pathname));
    } catch (error) {
      if (prepared) {
        throw error;
      }
      prepared = await prepareSqliteSnapshotSource(pathname);
      if (!prepared) {
        throw error;
      }
      return await operation(prepared.location);
    }
  } finally {
    prepared?.cleanup();
  }
}
