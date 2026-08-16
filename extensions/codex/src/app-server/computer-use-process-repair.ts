// macOS process inspection and scoped stale-child repair for Codex Computer Use.
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { describeControlFailure } from "./capabilities.js";

const COMPUTER_USE_PROCESS_LIST_TIMEOUT_MS = 2_000;
const COMPUTER_USE_PROCESS_LIST_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

type ProcessInfo = {
  pid: number;
  ppid: number;
  command: string;
};

export type CodexComputerUseRepairStatus = {
  attempted: boolean;
  killedPids: number[];
  message: string;
  warnings: string[];
};

export function scopedRepairUnavailableStatus(): CodexComputerUseRepairStatus {
  return {
    attempted: false,
    killedPids: [],
    warnings: [
      "Computer Use auto-repair skipped because no scoped Codex app-server process was available.",
    ],
    message: "Computer Use stale child repair requires a scoped local app-server PID.",
  };
}

export async function killStaleComputerUseMcpChildren(
  options: { ancestorPid?: number } = {},
): Promise<CodexComputerUseRepairStatus> {
  if (process.platform !== "darwin") {
    return {
      attempted: true,
      killedPids: [],
      warnings: [
        `Computer Use stale child repair is currently macOS-only, not ${process.platform}.`,
      ],
      message: "Computer Use stale child repair skipped on this platform.",
    };
  }
  if (
    !options.ancestorPid ||
    !Number.isSafeInteger(options.ancestorPid) ||
    options.ancestorPid <= 0
  ) {
    return scopedRepairUnavailableStatus();
  }

  let stdout: string;
  try {
    const result = await runExec("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      logOutput: false,
      maxBuffer: COMPUTER_USE_PROCESS_LIST_MAX_BUFFER_BYTES,
      // A partial process table cannot prove ancestry, so timeout remains a
      // no-kill result and the next health probe can retry from a fresh snapshot.
      timeoutMs: COMPUTER_USE_PROCESS_LIST_TIMEOUT_MS,
    });
    stdout = result.stdout;
  } catch (error) {
    return {
      attempted: true,
      killedPids: [],
      warnings: [
        `Could not list processes for Computer Use repair: ${describeControlFailure(error)}`,
      ],
      message: "Computer Use stale child repair could not inspect running processes.",
    };
  }

  const killedPids: number[] = [];
  const warnings: string[] = [];
  const processInfos = parsePsOutput(stdout);
  for (const processInfo of processInfos) {
    if (!isStaleComputerUseMcpChild(processInfo.command)) {
      continue;
    }
    if (!isDescendantOfPid(processInfo.pid, options.ancestorPid, processInfos)) {
      continue;
    }
    try {
      process.kill(processInfo.pid, "SIGTERM");
      killedPids.push(processInfo.pid);
    } catch (error) {
      warnings.push(
        `Could not terminate stale Computer Use MCP child pid ${processInfo.pid}: ${describeControlFailure(error)}`,
      );
    }
  }
  return {
    attempted: true,
    killedPids,
    warnings,
    message:
      killedPids.length === 0
        ? "No stale Computer Use MCP children were found under the scoped Codex app-server process."
        : `Terminated ${killedPids.length} stale Computer Use MCP child process${killedPids.length === 1 ? "" : "es"} under the scoped Codex app-server process.`,
  };
}

function parsePsOutput(stdout: string): ProcessInfo[] {
  return stdout
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      if (!match) {
        return [];
      }
      return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }];
    })
    .filter(
      (processInfo) =>
        Number.isSafeInteger(processInfo.pid) &&
        processInfo.pid > 0 &&
        Number.isSafeInteger(processInfo.ppid) &&
        processInfo.ppid >= 0,
    );
}

function isStaleComputerUseMcpChild(command: string): boolean {
  return command.includes("SkyComputerUseClient") && /(?:^|\s)mcp(?:\s|$)/u.test(command);
}

function isDescendantOfPid(pid: number, ancestorPid: number, processInfos: ProcessInfo[]): boolean {
  const parents = new Map(processInfos.map((processInfo) => [processInfo.pid, processInfo.ppid]));
  const seen = new Set<number>();
  let current = pid;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = parents.get(current);
    if (!parent || parent <= 0) {
      return false;
    }
    if (parent === ancestorPid) {
      return true;
    }
    current = parent;
  }
  return false;
}
