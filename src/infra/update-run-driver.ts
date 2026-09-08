import { hostname } from "node:os";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";

export type UpdateRunDriver = {
  host: string;
  pid: number;
  startIdentity: string;
};

export function sameUpdateRunDriver(left: UpdateRunDriver, right: UpdateRunDriver): boolean {
  return (
    left.host === right.host && left.pid === right.pid && left.startIdentity === right.startIdentity
  );
}

export function readUpdateRunDriver(): UpdateRunDriver | undefined {
  const host = hostname();
  const startedAt = getFileLockProcessStartTime(process.pid);
  if (
    !host ||
    host.length > 255 ||
    startedAt === null ||
    !Number.isSafeInteger(startedAt) ||
    startedAt < 0
  ) {
    return undefined;
  }
  return { host, pid: process.pid, startIdentity: String(startedAt) };
}

export function inspectUpdateRunDriver(driver: UpdateRunDriver): "alive" | "dead" | "unknown" {
  // A PID on another host says nothing about this driver's lifetime.
  if (driver.host !== hostname()) {
    return "unknown";
  }
  if (isPidDefinitelyDead(driver.pid)) {
    return "dead";
  }
  const startedAt = getFileLockProcessStartTime(driver.pid);
  if (startedAt === null) {
    return "unknown";
  }
  // A reused PID proves the recorded driver exited. An identical identity after
  // a reboot remains conservatively live; identity coincidence never revokes it.
  return String(startedAt) === driver.startIdentity ? "alive" : "dead";
}
