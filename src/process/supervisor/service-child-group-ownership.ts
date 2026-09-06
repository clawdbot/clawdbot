import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";

type GroupMember = { pid: number; pgid: number; state: string };

function* readProcessGroupMembers(timeoutMs: number): Generator<GroupMember> {
  if (process.platform === "linux") {
    const deadline = Date.now() + timeoutMs;
    for (const name of readdirSync("/proc")) {
      if (Date.now() >= deadline) {
        throw new Error("Process group census exceeded its deadline");
      }
      if (!/^\d+$/.test(name)) {
        continue;
      }
      const pid = Number(name);
      let stat: string;
      try {
        stat = readFileSync(`/proc/${name}/stat`, "utf8");
      } catch (error) {
        // Foreign processes may disappear between enumeration and their stat read.
        if (pid !== process.pid && ["ENOENT", "ESRCH"].includes(extractErrorCode(error) ?? "")) {
          continue;
        }
        throw error;
      }
      // comm can contain spaces, newlines and parentheses; pgrp follows PPID
      // after its final closing parenthesis (Linux procfs stat fields 1..5).
      const match = /^(\d+) \([\s\S]*\) (\S) \d+ (\d+)(?:\s|$)/.exec(stat);
      if (!match || Number(match[1]) !== pid || Date.now() >= deadline) {
        throw new Error("Process group census is unavailable");
      }
      yield { pid, pgid: Number(match[3]), state: match[2]! };
    }
    if (Date.now() >= deadline) {
      throw new Error("Process group census exceeded its deadline");
    }
    return;
  }
  const census = spawnSync("/bin/ps", ["-A", "-o", "pid=,pgid=,stat="], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (census.error || census.status !== 0) {
    throw new Error("Process group census is unavailable");
  }
  for (const line of census.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) {
      throw new Error("Process group census is unavailable");
    }
    const pid = Number(match[1]);
    if (pid !== census.pid) {
      yield { pid, pgid: Number(match[2]), state: match[3]! };
    }
  }
}

/** Advisory retirement timing only; the host owns kernel group-disappearance proof. */
export function hasLiveOwnedProcessGroupMembers(timeoutMs = 1_000): boolean | undefined {
  let observedOwner = false;
  try {
    for (const { pid, pgid, state } of readProcessGroupMembers(
      Math.max(1, Math.min(1_000, timeoutMs)),
    )) {
      if (pid === process.pid) {
        if (pgid !== process.pid) {
          return undefined;
        }
        observedOwner = true;
      } else if (
        pgid === process.pid &&
        // A zombie leader may retain live Linux threads; share the existing check.
        (!state.startsWith("Z") || (process.platform === "linux" && !isPidDefinitelyDead(pid)))
      ) {
        return true;
      }
    }
  } catch {
    return undefined;
  }
  return observedOwner ? false : undefined;
}
