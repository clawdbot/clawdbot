// Shared filesystem helpers for plugin doctor legacy-state migrations.
import fs from "node:fs/promises";
import { readFileWindowFully } from "../infra/file-read.js";

const MAX_LEGACY_JSON_STATE_FILE_BYTES = 10 * 1024 * 1024;

/** Reads one small legacy JSON source through the descriptor that was size-checked. */
export async function readLegacyJsonStateFile(filePath: string): Promise<string> {
  const file = await fs.open(filePath, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Error(`Legacy state source is not a regular file: ${filePath}`);
    }
    if (stat.size > MAX_LEGACY_JSON_STATE_FILE_BYTES) {
      throw new Error(
        `Legacy state file is too large: ${stat.size} bytes exceeds ${MAX_LEGACY_JSON_STATE_FILE_BYTES} bytes: ${filePath}`,
      );
    }
    // The descriptor pins the checked file, and the fixed window prevents a
    // concurrent writer from growing the migration read past the safety cap.
    const buffer = Buffer.alloc(stat.size);
    const bytesRead = await readFileWindowFully(file, buffer, 0);
    if (bytesRead !== buffer.length) {
      throw new Error(`Legacy state file shrank while reading: ${filePath}`);
    }
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

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
      const [sourceBytes, archiveBytes] = await Promise.all([
        fs.readFile(params.filePath),
        fs.readFile(archivedPath),
      ]);
      if (sourceBytes.equals(archiveBytes)) {
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

async function firstFreeArchivePath(sourcePath: string): Promise<string> {
  for (let index = 2; ; index++) {
    const candidate = `${sourcePath}.migrated.${index}`;
    if (!(await legacyStateFileExists(candidate))) {
      return candidate;
    }
  }
}
