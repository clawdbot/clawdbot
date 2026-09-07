// Shared filesystem helpers for plugin doctor legacy-state migrations.
import fs from "node:fs/promises";

/** Keep archive comparisons bounded without imposing a file-size cutoff. */
const ARCHIVE_COMPARE_CHUNK_BYTES = 64 * 1024;

/** True when the legacy-state path exists and is a regular file. */
export async function legacyStateFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Renames a migrated legacy source to `<path>.migrated`, recording the outcome in the
 * doctor changes/warnings lists. Never throws: a failed archive leaves the source in
 * place so a later doctor run can retry without losing migrated data.
 */
export async function archiveLegacyStateSource(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  try {
    if (await legacyStateFileExists(archivedPath)) {
      // Import commits before archival, so an existing archive must converge
      // instead of re-warning every startup (#102749): identical bytes already
      // preserve the snapshot; differing bytes archive under a free suffix.
      const [sourceStat, archiveStat] = await Promise.all([
        fs.stat(params.filePath),
        fs.stat(archivedPath),
      ]);
      if (
        sourceStat.isFile() &&
        archiveStat.isFile() &&
        sourceStat.size === archiveStat.size &&
        (await areArchiveFilesEqual(params.filePath, archivedPath, sourceStat.size))
      ) {
        await fs.rm(params.filePath, { force: true });
        params.changes.push(
          `Removed already-archived ${params.label} legacy source ${params.filePath}`,
        );
        return;
      }
      const nextArchivePath = await firstFreeArchivePath(params.filePath);
      await fs.rename(params.filePath, nextArchivePath);
      params.changes.push(`Archived ${params.label} legacy source -> ${nextArchivePath}`);
      return;
    }
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived ${params.label} legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving ${params.label} legacy source: ${String(err)}`);
  }
}

/**
 * Compares a legacy source and archive through fixed-size buffers. Opening the
 * paths directly preserves the historical symlink-following behavior, while
 * the comparison never allocates the complete files.
 */
async function areArchiveFilesEqual(
  sourcePath: string,
  archivePath: string,
  expectedSize: number,
): Promise<boolean> {
  let sourceHandle: fs.FileHandle | undefined;
  let archiveHandle: fs.FileHandle | undefined;
  try {
    sourceHandle = await fs.open(sourcePath, "r");
    archiveHandle = await fs.open(archivePath, "r");
    const [sourceStat, archiveStat] = await Promise.all([
      sourceHandle.stat(),
      archiveHandle.stat(),
    ]);
    if (
      !sourceStat.isFile() ||
      !archiveStat.isFile() ||
      sourceStat.size !== expectedSize ||
      archiveStat.size !== expectedSize
    ) {
      return false;
    }

    const sourceBuffer = Buffer.allocUnsafe(Math.min(ARCHIVE_COMPARE_CHUNK_BYTES, expectedSize));
    const archiveBuffer = Buffer.allocUnsafe(Math.min(ARCHIVE_COMPARE_CHUNK_BYTES, expectedSize));
    for (let position = 0; position < expectedSize;) {
      const chunkBytes = Math.min(ARCHIVE_COMPARE_CHUNK_BYTES, expectedSize - position);
      const [sourceComplete, archiveComplete] = await Promise.all([
        readArchiveComparisonChunk(sourceHandle, sourceBuffer, position, chunkBytes),
        readArchiveComparisonChunk(archiveHandle, archiveBuffer, position, chunkBytes),
      ]);
      if (!sourceComplete || !archiveComplete) {
        return false;
      }
      if (!sourceBuffer.subarray(0, chunkBytes).equals(archiveBuffer.subarray(0, chunkBytes))) {
        return false;
      }
      position += chunkBytes;
    }

    const [sourceFinalStat, archiveFinalStat] = await Promise.all([
      sourceHandle.stat(),
      archiveHandle.stat(),
    ]);
    return (
      sourceFinalStat.isFile() &&
      archiveFinalStat.isFile() &&
      sourceFinalStat.size === expectedSize &&
      archiveFinalStat.size === expectedSize
    );
  } finally {
    await Promise.all([sourceHandle?.close(), archiveHandle?.close()]);
  }
}

async function readArchiveComparisonChunk(
  handle: fs.FileHandle,
  buffer: Buffer,
  position: number,
  length: number,
): Promise<boolean> {
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) {
      return false;
    }
    filled += bytesRead;
  }
  return true;
}

async function firstFreeArchivePath(sourcePath: string): Promise<string> {
  for (let index = 2; ; index++) {
    const candidate = `${sourcePath}.migrated.${index}`;
    if (!(await legacyStateFileExists(candidate))) {
      return candidate;
    }
  }
}
