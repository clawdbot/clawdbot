import {
  getProcessStartTime as defaultGetProcessStartTime,
  isPidDefinitelyDead as defaultIsPidDefinitelyDead,
} from "../shared/pid-alive.js";

export type LockFileOwnerPayload = {
  pid?: number;
  createdAt?: string;
  starttime?: number;
};

export function readLockFileOwnerPayload(
  payload: Record<string, unknown> | null,
): LockFileOwnerPayload | null {
  if (!payload) {
    return null;
  }
  return {
    pid: typeof payload.pid === "number" ? payload.pid : undefined,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
    starttime: typeof payload.starttime === "number" ? payload.starttime : undefined,
  };
}

export function shouldRemoveDeadOwnerOrExpiredLock(params: {
  payload: Record<string, unknown> | null;
  staleMs: number;
  nowMs?: number;
  isPidDefinitelyDead?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => number | null;
}): boolean {
  const payload = readLockFileOwnerPayload(params.payload);
  if (payload?.pid) {
    // Timestamp age alone cannot prove the owner stopped writing. Only a
    // mismatched process start time proves PID reuse while the PID is alive.
    if (payload.starttime !== undefined) {
      const currentStarttime = (params.getProcessStartTime ?? defaultGetProcessStartTime)(
        payload.pid,
      );
      if (currentStarttime !== null && currentStarttime !== payload.starttime) {
        return true;
      }
    }
    return (params.isPidDefinitelyDead ?? defaultIsPidDefinitelyDead)(payload.pid);
  }
  if (payload?.createdAt) {
    const createdAt = Date.parse(payload.createdAt);
    if (!Number.isFinite(createdAt) || (params.nowMs ?? Date.now()) - createdAt > params.staleMs) {
      return true;
    }
  }
  return false;
}
