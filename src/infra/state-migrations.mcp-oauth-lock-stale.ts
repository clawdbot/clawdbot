import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

const LEGACY_LOCK_STALE_MS = 60_000;

function parseLockPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Classify only retired-runtime owners whose age and process identity are provably stale. */
export function isDefinitelyStaleLegacyMcpOAuthLock(params: {
  raw: string;
  nowMs?: number;
  isPidDefinitelyDead?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => number | null;
}): boolean {
  const payload = parseLockPayload(params.raw);
  if (!payload) {
    return false;
  }
  const pid = payload.pid;
  const createdAt = payload.createdAt;
  const starttime = payload.starttime;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof createdAt !== "string" ||
    (starttime !== undefined &&
      (typeof starttime !== "number" || !Number.isSafeInteger(starttime) || starttime < 0))
  ) {
    return false;
  }
  const createdAtMs = Date.parse(createdAt);
  const ageMs = (params.nowMs ?? Date.now()) - createdAtMs;
  if (
    !Number.isFinite(createdAtMs) ||
    new Date(createdAtMs).toISOString() !== createdAt ||
    !Number.isFinite(ageMs) ||
    ageMs < LEGACY_LOCK_STALE_MS
  ) {
    return false;
  }
  return isLockOwnerDefinitelyStale({
    payload,
    isPidDefinitelyDead: params.isPidDefinitelyDead ?? isPidDefinitelyDead,
    getProcessStartTime: params.getProcessStartTime ?? getFileLockProcessStartTime,
  });
}
