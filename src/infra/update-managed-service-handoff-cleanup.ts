// Owns cleanup of transient handoff files and released legacy process claims.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** v1 shipped in 2026.8.2. This proves cleanup eligibility, never v2 authority. */
export function canCleanupLegacyManagedHandoff(
  payload: string,
  processState: (identity: { pid: number; startIdentity: string }) => "live" | "dead" | "unknown",
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return false;
  }
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.version === 1 &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startIdentity === "string" &&
    Number.isSafeInteger(Number(value.startIdentity)) &&
    Number(value.startIdentity) >= 0 &&
    String(Number(value.startIdentity)) === value.startIdentity &&
    // The recorded process may be the updater runner, not the surviving helper.
    processState({ pid: value.pid, startIdentity: value.startIdentity }) === "dead"
  );
}

export const MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX = "openclaw-update-run-handoff-";
const MANAGED_SERVICE_UPDATE_HANDOFF_STALE_TTL_MS = 24 * 60 * 60_000;

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
