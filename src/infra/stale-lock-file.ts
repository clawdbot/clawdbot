import { isPidDefinitelyDead as defaultIsPidDefinitelyDead } from "../shared/pid-alive.js";

export type LockFileOwnerPayload = {
  pid?: number;
  createdAt?: string;
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
  };
}

export function shouldRemoveDeadOwnerOrExpiredLock(params: {
  payload: Record<string, unknown> | null;
  staleMs: number;
  nowMs?: number;
  isPidDefinitelyDead?: (pid: number) => boolean;
}): boolean {
  const payload = readLockFileOwnerPayload(params.payload);
  if (payload?.pid) {
    return (params.isPidDefinitelyDead ?? defaultIsPidDefinitelyDead)(payload.pid);
  }
  if (payload?.createdAt) {
    const createdAt = Date.parse(payload.createdAt);
    return !Number.isFinite(createdAt) || (params.nowMs ?? Date.now()) - createdAt > params.staleMs;
  }
  return false;
}
