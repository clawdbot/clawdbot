import fs from "node:fs/promises";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { isOpenClawProcessArgv } from "./gateway-process-argv.js";
import { readGatewayProcessArgsSync } from "./gateway-processes.js";
import { readWindowsProcessStartTimeSync } from "./windows-port-pids.js";

export type SessionLockFilePayload = {
  pid?: number;
  createdAt?: string;
  starttime?: number;
  maxHoldMs?: number;
};

export type SessionLockFileInspection = {
  pid: number | null;
  pidAlive: boolean;
  createdAt: string | null;
  ageMs: number | null;
  stale: boolean;
  staleReasons: string[];
};

export type SessionLockOwnerProcessArgsReader = (pid: number) => string[] | null;

const REPORT_ONLY_REASONS = new Set(["too-old", "hold-exceeded"]);

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function readSessionLockProcessStartTime(pid: number): number | null {
  return process.platform === "win32"
    ? readWindowsProcessStartTimeSync(pid, 1_000)
    : getFileLockProcessStartTime(pid);
}

export function parseSessionLockFilePayload(raw: string): SessionLockFilePayload | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(validNumber(value.pid) && value.pid > 0 ? { pid: value.pid } : {}),
      ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
      ...(validNumber(value.starttime) ? { starttime: value.starttime } : {}),
      ...(validNumber(value.maxHoldMs) && value.maxHoldMs > 0
        ? { maxHoldMs: value.maxHoldMs }
        : {}),
    };
  } catch {
    return null;
  }
}

function inspectSessionLockFile(params: {
  payload: SessionLockFilePayload | null;
  staleMs: number;
  nowMs: number;
  heldByThisProcess?: boolean;
  reclaimLockWithoutStarttime?: boolean;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
  respectMaxHold?: boolean;
}): SessionLockFileInspection {
  const { payload } = params;
  const pid = validNumber(payload?.pid) && payload.pid > 0 ? payload.pid : null;
  const pidAlive = pid !== null && isPidAlive(pid);
  const createdAt = typeof payload?.createdAt === "string" ? payload.createdAt : null;
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, params.nowMs - createdAtMs) : null;
  const storedStarttime = validNumber(payload?.starttime) ? payload.starttime : null;
  const currentStarttime =
    pidAlive && pid !== null && storedStarttime !== null
      ? readSessionLockProcessStartTime(pid)
      : null;
  const recycled =
    storedStarttime !== null && currentStarttime !== null && currentStarttime !== storedStarttime;
  const staleReasons: string[] = [];
  if (pid === null) {
    staleReasons.push("missing-pid");
  } else if (!pidAlive) {
    staleReasons.push("dead-pid");
  } else if (recycled) {
    staleReasons.push("recycled-pid");
  }
  if (ageMs === null) {
    staleReasons.push("invalid-createdAt");
  } else if (ageMs > params.staleMs) {
    staleReasons.push("too-old");
  }
  if (params.respectMaxHold && payload?.maxHoldMs && ageMs !== null && ageMs > payload.maxHoldMs) {
    staleReasons.push("hold-exceeded");
  }
  const orphanSelf =
    pid === process.pid &&
    !params.heldByThisProcess &&
    !recycled &&
    (storedStarttime !== null
      ? currentStarttime === storedStarttime
      : params.reclaimLockWithoutStarttime === true);
  if (orphanSelf) {
    staleReasons.push("orphan-self-pid");
  } else if (pidAlive && pid !== null && !recycled && !params.heldByThisProcess) {
    try {
      const args = (params.readOwnerProcessArgs ?? readGatewayProcessArgsSync)(pid);
      if (args?.some((arg) => arg.trim()) && !isOpenClawProcessArgv(args)) {
        staleReasons.push("non-openclaw-owner");
      }
    } catch {
      // Unknown live owners are preserved.
    }
  }
  return { pid, pidAlive, createdAt, ageMs, stale: staleReasons.length > 0, staleReasons };
}

export async function inspectSessionLockFileContention(params: {
  lockPath: string;
  payload: SessionLockFilePayload | null;
  staleMs: number;
  nowMs: number;
  orphanGraceMs: number;
  heldByThisProcess?: boolean;
  reclaimLockWithoutStarttime?: boolean;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
  respectMaxHold?: boolean;
}): Promise<{ inspection: SessionLockFileInspection; report: boolean; removable: boolean }> {
  const inspection = inspectSessionLockFile(params);
  const malformedOnly = inspection.staleReasons.every(
    (reason) => reason === "missing-pid" || reason === "invalid-createdAt",
  );
  let report = inspection.stale && !params.heldByThisProcess;
  if (report && malformedOnly) {
    try {
      report =
        params.nowMs - (await fs.stat(params.lockPath)).mtimeMs >
        Math.min(params.staleMs, params.orphanGraceMs);
    } catch (error) {
      report = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }
  return {
    inspection,
    report,
    removable:
      report && !inspection.staleReasons.every((reason) => REPORT_ONLY_REASONS.has(reason)),
  };
}
