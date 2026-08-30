import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inspectLinuxProcessGroupStats } from "./posix-process-stat.js";

type QaLinuxProcessGroupInspection = ReturnType<typeof inspectLinuxProcessGroupStats>;
export type QaLinuxProcessGroupInspector = (
  processGroupId: number,
) => QaLinuxProcessGroupInspection | null;

export function inspectLinuxProcessGroup(
  processGroupId: number,
): QaLinuxProcessGroupInspection | null {
  if (process.platform !== "linux") {
    return null;
  }
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return null;
  }
  const stats: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }
    try {
      stats.push(readFileSync(path.join("/proc", entry.name, "stat"), "utf8"));
    } catch (error) {
      // Exit can race either opening stat (ENOENT) or reading its open fd (ESRCH).
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return null;
      }
    }
  }
  return inspectLinuxProcessGroupStats(processGroupId, stats);
}

export function isQaPosixProcessGroupAlive(
  processGroupId: number,
  inspectLinuxProcessGroupFn: QaLinuxProcessGroupInspector = inspectLinuxProcessGroup,
) {
  try {
    process.kill(-processGroupId, 0);
    // Reaping can remove the last zombie between kill(0) and /proc. Resolve an
    // inconclusive snapshot with a fresh existence probe, never the stale one.
    return (
      process.platform !== "linux" ||
      (inspectLinuxProcessGroupFn(processGroupId)?.alive ?? process.kill(-processGroupId, 0))
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function signalQaPosixProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): Error | undefined {
  try {
    process.kill(-processGroupId, signal);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return undefined;
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
