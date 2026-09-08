import { spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import path from "node:path";

const MAX_CHILD_PROCESSES = 8;
const MAX_COMMAND_LENGTH = 64;

/** Inspect names, never argv or environment, only when finalization is already stalled. */
export function inspectUpdateFinalizationChildren(): {
  childProcesses: { pid: number; parentPid: number; command: string | null }[];
  childProcessInspection: "complete" | "unavailable";
  childProcessesTruncated: boolean;
} {
  const windows = process.platform === "win32";
  const inspector = windows
    ? path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "/bin/ps";
  const args = windows
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1} {2}" -f $_.ProcessId,$_.ParentProcessId,$_.Name }',
      ]
    : // Darwin's comm can include argv copied into a mutable process title.
      ["-axo", process.platform === "linux" ? "pid=,ppid=" : "pid=,ppid=,ucomm="];
  const result = spawnSync(inspector, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    return {
      childProcesses: [],
      childProcessInspection: "unavailable",
      childProcessesTruncated: false,
    };
  }
  const processes = result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(.+?))?\s*$/u.exec(line);
    if (!match) {
      return [];
    }
    const [, pid, parentPid, command = ""] = match;
    if (!pid || !parentPid || (process.platform !== "linux" && !command)) {
      return [];
    }
    return [{ pid: Number(pid), parentPid: Number(parentPid), command }];
  });
  const childrenByParent = new Map<number, typeof processes>();
  for (const child of processes) {
    const children = childrenByParent.get(child.parentPid) ?? [];
    children.push(child);
    childrenByParent.set(child.parentPid, children);
  }
  const parents = new Set([process.pid]);
  const pending = [process.pid];
  const childProcesses: { pid: number; parentPid: number; command: string }[] = [];
  // Follow ancestry, including native grandchildren that are outside the command runner.
  for (const parentPid of pending) {
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (parents.has(child.pid) || child.pid === result.pid) {
        continue;
      }
      parents.add(child.pid);
      pending.push(child.pid);
      childProcesses.push(child);
    }
  }
  return {
    childProcesses: childProcesses
      .toSorted((a, b) => a.pid - b.pid)
      .slice(0, MAX_CHILD_PROCESSES)
      .map((child) => {
        let executable = child.command;
        if (process.platform === "linux") {
          // Linux accounting names are mutable too; query only the bounded selected set.
          try {
            executable = readlinkSync(`/proc/${child.pid}/exe`);
          } catch {
            return { pid: child.pid, parentPid: child.parentPid, command: null };
          }
        }
        return {
          pid: child.pid,
          parentPid: child.parentPid,
          command: (windows ? path.win32 : path.posix)
            .basename(executable)
            .slice(0, MAX_COMMAND_LENGTH),
        };
      }),
    childProcessInspection: "complete",
    childProcessesTruncated: childProcesses.length > MAX_CHILD_PROCESSES,
  };
}
