// Shared JSON state helpers for pairing namespaces.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export { createAsyncLock, readJsonIfExists } from "./json-files.js";

/** Resolve pending/paired JSON file locations for one pairing namespace. */
export function resolvePairingPaths(baseDir: string | undefined, subdir: string) {
  const root = baseDir ?? resolveStateDir();
  const dir = path.join(root, subdir);
  return {
    dir,
    pendingPath: path.join(dir, "pending.json"),
    pairedPath: path.join(dir, "paired.json"),
  };
}

/** Coerce persisted pairing maps, treating malformed arrays/scalars as empty state. */
export function coercePairingStateRecord<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, T>;
}

/** Remove pending requests older than the caller's pairing TTL. */
export function pruneExpiredPending<T extends { ts: number; refreshedAtMs?: number }>(
  pendingById: Record<string, T>,
  nowMs: number,
  ttlMs: number,
) {
  for (const [id, req] of Object.entries(pendingById)) {
    // refreshedAtMs is a TTL keepalive: expiry counts from the device's last
    // re-request, while ts stays the creation time for approval ordering.
    if (nowMs - (req.refreshedAtMs ?? req.ts) > ttlMs) {
      delete pendingById[id];
    }
  }
}
