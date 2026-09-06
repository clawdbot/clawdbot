import { spawn as startOpenClawCliProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { runQaWindowsTaskkill } from "../../../windows-system-tools.js";

type MatrixQaTaskkillRunner = NonNullable<Parameters<typeof runQaWindowsTaskkill>[0]["runCommand"]>;

export function resolveMatrixQaOpenClawCliEntryPath(cwd: string): string {
  const mjsEntryPath = path.join(cwd, "dist", "index.mjs");
  if (existsSync(mjsEntryPath)) {
    return mjsEntryPath;
  }
  return path.join(cwd, "dist", "index.js");
}

export function killMatrixQaCliChild(
  child: ReturnType<typeof startOpenClawCliProcess>,
  signal: NodeJS.Signals,
  runTaskkill?: MatrixQaTaskkillRunner,
): void {
  if (process.platform === "win32") {
    if (
      child.pid &&
      runQaWindowsTaskkill({
        pid: child.pid,
        signal,
        ...(runTaskkill ? { runCommand: runTaskkill } : {}),
      })
    ) {
      return;
    }
    child.kill(signal);
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if process-group signaling is unavailable.
    }
  }
  child.kill(signal);
}
