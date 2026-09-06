import { spawnSync } from "node:child_process";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";

/** Advisory retirement timing only; the host owns kernel group-disappearance proof. */
export function hasLiveOwnedProcessGroupMembers(timeoutMs = 1_000): boolean | undefined {
  const census = spawnSync("/bin/ps", ["-A", "-o", "pid=,pgid=,stat="], {
    encoding: "utf8",
    timeout: Math.max(1, Math.min(1_000, timeoutMs)),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (census.error || census.status !== 0) {
    return undefined;
  }
  let observedOwner = false;
  for (const line of census.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) {
      return undefined;
    }
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const state = match[3]!;
    if (pid === process.pid) {
      if (pgid !== process.pid) {
        return undefined;
      }
      observedOwner = true;
    } else if (
      pid !== census.pid &&
      pgid === process.pid &&
      // BusyBox omits procps's thread marker; use the shared Linux thread check.
      (!state.startsWith("Z") || (process.platform === "linux" && !isPidDefinitelyDead(pid)))
    ) {
      return true;
    }
  }
  return observedOwner ? false : undefined;
}
