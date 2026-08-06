import { spawn as startOpenClawCliProcess, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveQaWindowsSystem32ExePath } from "../../../windows-system-tools.js";

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
  runTaskkill: typeof spawnSync = spawnSync,
): void {
  if (process.platform === "win32") {
    if (child.pid) {
      const taskkillPath = resolveQaWindowsSystem32ExePath("taskkill.exe");
      const args = ["/PID", String(child.pid), "/T"];
      if (signal === "SIGKILL") {
        args.push("/F");
      }
      const result = runTaskkill(taskkillPath, args, { stdio: "ignore", windowsHide: true });
      if (!result.error && result.status === 0) {
        return;
      }
      if (signal !== "SIGKILL") {
        const forceResult = runTaskkill(taskkillPath, [...args, "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        if (!forceResult.error && forceResult.status === 0) {
          return;
        }
      }
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
