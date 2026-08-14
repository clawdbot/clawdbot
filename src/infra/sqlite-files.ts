import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

/** SQLite main database plus every journal-mode sidecar that can contain database pages. */
const SQLITE_DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
// SQLite WAL format: https://sqlite.org/fileformat2.html#walformat defines a 32-byte header.
const SQLITE_WAL_HEADER_BYTES = 32;
const SQLITE_SIDECAR_HASH_BUFFER_BYTES = 1024 * 1024;
const sqliteFilesLog = createSubsystemLogger("state/sqlite");

class SqliteOrphanedSidecarsError extends Error {
  constructor(pathname: string, sidecarPaths: string[], cause: unknown) {
    super(
      `SQLite database is missing at ${pathname}, and orphaned sidecars could not be copied: ${sidecarPaths.join(", ")}. ` +
        "Refusing to open because SQLite could delete orphan WAL or journal state. Preserve the sidecar bytes, restore the main database, and pair it with the matching sidecar before retrying.",
      { cause },
    );
    this.name = "SqliteOrphanedSidecarsError";
  }
}

type CopiedSqliteSidecar = {
  quarantinePath: string;
  sourcePath: string;
};

/** Resolves the main database and all possible journal-mode sidecar paths. */
export function resolveSqliteDatabaseFilePaths(pathname: string): string[] {
  return SQLITE_DATABASE_FILE_SUFFIXES.map((suffix) => `${pathname}${suffix}`);
}

function sha256FileSync(pathname: string): string {
  const descriptor = fs.openSync(pathname, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(SQLITE_SIDECAR_HASH_BUFFER_BYTES);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        return digest.digest("hex");
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function findMatchingOrphanedSidecarCopy(
  sourcePath: string,
  sourceSize: number,
): string | undefined {
  const directory = path.dirname(sourcePath);
  const prefix = `${path.basename(sourcePath)}.orphaned-`;
  const candidates = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => path.join(directory, entry.name))
    .filter((candidate) => fs.statSync(candidate).size === sourceSize);
  if (candidates.length === 0) {
    return undefined;
  }
  const sourceHash = sha256FileSync(sourcePath);
  for (const candidate of candidates) {
    if (sha256FileSync(candidate) === sourceHash) {
      return candidate;
    }
  }
  return undefined;
}

function copyOrphanedSidecar(sourcePath: string, epochMs: number): string {
  const basePath = `${sourcePath}.orphaned-${epochMs}`;
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? basePath : `${basePath}-${suffix}`;
    try {
      fs.copyFileSync(sourcePath, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

/** Preserve durable orphan sidecars before SQLite creates a replacement main database. */
export function quarantineOrphanedSqliteSidecars(pathname: string): void {
  if (fs.existsSync(pathname)) {
    return;
  }
  const sidecars = [
    { path: `${pathname}-wal`, minimumBytes: SQLITE_WAL_HEADER_BYTES },
    { path: `${pathname}-journal`, minimumBytes: 0 },
  ].flatMap((sidecar) => {
    const stat = fs.statSync(sidecar.path, { throwIfNoEntry: false });
    return stat?.isFile() === true && stat.size > sidecar.minimumBytes
      ? [{ path: sidecar.path, size: stat.size }]
      : [];
  });
  if (sidecars.length === 0) {
    return;
  }

  const epochMs = Date.now();
  const copied: CopiedSqliteSidecar[] = [];
  try {
    for (const sidecar of sidecars) {
      if (findMatchingOrphanedSidecarCopy(sidecar.path, sidecar.size)) {
        continue;
      }
      const quarantinePath = copyOrphanedSidecar(sidecar.path, epochMs);
      copied.push({ quarantinePath, sourcePath: sidecar.path });
    }
  } catch (error) {
    throw new SqliteOrphanedSidecarsError(
      pathname,
      sidecars.map((sidecar) => sidecar.path),
      error,
    );
  }
  if (copied.length === 0) {
    return;
  }

  const copies = copied.map(
    ({ sourcePath, quarantinePath }) => `${sourcePath} -> ${quarantinePath}`,
  );
  sqliteFilesLog.warn(
    `SQLite database is missing at ${pathname}; copied orphaned sidecars: ${copies.join(", ")}. ` +
      "Committed frames could not be applied because the main database is missing. The bytes are preserved. Recovery requires restoring the main database and pairing it with the quarantined file.",
    {
      databasePath: pathname,
      copiedSidecars: copied,
    },
  );
}
