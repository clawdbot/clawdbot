import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX = "openclaw-update-run-handoff-";
export const MANAGED_SERVICE_UPDATE_HANDOFF_STALE_TTL_MS = 24 * 60 * 60_000;

export async function cleanupStaleManagedServiceUpdateHandoffs(params?: {
  tmpDir?: string;
  nowMs?: number;
  ttlMs?: number;
}): Promise<number> {
  const tmpDir = params?.tmpDir ?? os.tmpdir();
  const nowMs = params?.nowMs ?? Date.now();
  const ttlMs = params?.ttlMs ?? MANAGED_SERVICE_UPDATE_HANDOFF_STALE_TTL_MS;
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX)
    ) {
      continue;
    }
    const dir = path.join(tmpDir, entry.name);
    let stats: { mtimeMs: number };
    try {
      stats = await fs.stat(dir);
    } catch {
      continue;
    }
    if (nowMs - stats.mtimeMs < ttlMs) {
      continue;
    }
    try {
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best effort cleanup only.
    }
  }
  return removed;
}
