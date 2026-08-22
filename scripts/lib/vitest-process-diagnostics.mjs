import { spawnSync } from "node:child_process";
import fs from "node:fs";

const COMMAND_TIMEOUT_MS = 1_000;
const COMMAND_MAX_BUFFER_BYTES = 128 * 1024;
const MAX_PROCESS_TREE_LINES = 32;
const MAX_FD_LINES = 24;
const MAX_LINE_CHARS = 1_000;

function truncateLine(line) {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}...`;
}

function boundedLines(output, limit) {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const visible = lines.slice(0, limit).map(truncateLine);
  if (lines.length > limit) {
    visible.push(`... ${lines.length - limit} more line(s) omitted`);
  }
  return visible;
}

function runDiagnosticCommand(command, args, spawnSyncImpl) {
  const result = spawnSyncImpl(command, args, {
    encoding: "utf8",
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    return { error: result.error.message, stdout: "" };
  }
  if (result.signal) {
    return { error: `terminated by ${result.signal}`, stdout: result.stdout ?? "" };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    return {
      error: `exit ${result.status}${stderr ? `: ${truncateLine(stderr)}` : ""}`,
      stdout: result.stdout ?? "",
    };
  }
  return { error: null, stdout: result.stdout ?? "" };
}

function collectPosixDiagnostics(pid, platform, spawnSyncImpl, fsImpl) {
  const lines = [];
  const columns = "pid=,ppid=,pgid=,etime=,state=,%cpu=,rss=,wchan=,command=";
  const processResult = runDiagnosticCommand(
    "ps",
    ["-o", columns, "-p", String(pid)],
    spawnSyncImpl,
  );
  if (processResult.error) {
    lines.push(`[vitest] process details unavailable: ${processResult.error}`);
    return lines;
  }

  const processLine = boundedLines(processResult.stdout, 1)[0];
  if (!processLine) {
    lines.push(`[vitest] process details unavailable: PID ${pid} was not found`);
    return lines;
  }
  lines.push("[vitest] process: PID PPID PGID ELAPSED STATE CPU% RSS_KB WCHAN COMMAND");
  lines.push(`[vitest] process: ${processLine}`);

  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+/u.exec(processLine);
  const pgid = match?.[3];
  if (!pgid) {
    lines.push("[vitest] process tree unavailable: could not resolve PGID");
  } else {
    const members = runDiagnosticCommand("pgrep", ["-g", pgid], spawnSyncImpl);
    const allMemberPids = members.stdout.split(/\s+/u).filter((value) => /^\d+$/u.test(value));
    const memberPids = allMemberPids.slice(0, MAX_PROCESS_TREE_LINES);
    if (members.error || memberPids.length === 0) {
      lines.push(`[vitest] process tree unavailable: ${members.error ?? "no group members found"}`);
    } else {
      const treeColumns = "pid=,ppid=,pgid=,etime=,state=,%cpu=,rss=,wchan=,comm=";
      const processes = runDiagnosticCommand(
        "ps",
        ["-o", treeColumns, "-p", memberPids.join(",")],
        spawnSyncImpl,
      );
      if (processes.error) {
        lines.push(`[vitest] process tree unavailable: ${processes.error}`);
      } else {
        lines.push(`[vitest] process tree: PGID ${pgid} (${allMemberPids.length} process(es))`);
        for (const line of boundedLines(processes.stdout, MAX_PROCESS_TREE_LINES)) {
          lines.push(`[vitest] process tree: ${line}`);
        }
        if (allMemberPids.length > memberPids.length) {
          lines.push(
            `[vitest] process tree: ... ${allMemberPids.length - memberPids.length} more process(es) omitted`,
          );
        }
      }
    }
  }

  let fds;
  if (platform === "linux" && fsImpl.existsSync(`/proc/${pid}/fd`)) {
    fds = runDiagnosticCommand("ls", ["-l", `/proc/${pid}/fd`], spawnSyncImpl);
  } else if (platform === "darwin") {
    fds = runDiagnosticCommand(
      "lsof",
      ["-nP", "-a", "-p", String(pid), "-d", "0-64"],
      spawnSyncImpl,
    );
  }
  if (!fds) {
    lines.push(`[vitest] fd summary unavailable on ${platform}`);
  } else if (fds.error) {
    lines.push(`[vitest] fd summary unavailable: ${fds.error}`);
  } else {
    lines.push(`[vitest] fd summary: PID ${pid}`);
    for (const line of boundedLines(fds.stdout, MAX_FD_LINES)) {
      lines.push(`[vitest] fd summary: ${line}`);
    }
  }
  return lines;
}

function collectWindowsDiagnostics(pid, spawnSyncImpl) {
  const lines = [`[vitest] process: PID ${pid}; PGID and wait channel are unavailable on win32`];
  const task = runDiagnosticCommand(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/FO", "LIST"],
    spawnSyncImpl,
  );
  if (task.error) {
    lines.push(`[vitest] process details unavailable: ${task.error}`);
  } else {
    for (const line of boundedLines(task.stdout, 12)) {
      lines.push(`[vitest] process: ${line}`);
    }
  }
  lines.push("[vitest] process tree unavailable on win32");
  lines.push("[vitest] fd summary unavailable on win32");
  return lines;
}

/**
 * Collect bounded, best-effort process evidence before a stalled Vitest group is terminated.
 */
export function collectVitestProcessDiagnostics({
  pid,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  fsImpl = fs,
}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return ["[vitest] process diagnostics unavailable: child PID is missing"];
  }
  try {
    const details =
      platform === "win32"
        ? collectWindowsDiagnostics(pid, spawnSyncImpl)
        : collectPosixDiagnostics(pid, platform, spawnSyncImpl, fsImpl);
    return [`[vitest] no-output process diagnostics begin (pid=${pid})`, ...details];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      `[vitest] no-output process diagnostics begin (pid=${pid})`,
      `[vitest] process diagnostics unavailable: ${truncateLine(message)}`,
    ];
  }
}

export function writeVitestProcessDiagnostics(params) {
  const log = params.log ?? console.error;
  for (const line of collectVitestProcessDiagnostics(params)) {
    log(line);
  }
}
