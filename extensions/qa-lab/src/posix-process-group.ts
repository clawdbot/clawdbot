import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

function parseLinuxProcessStat(raw: string) {
  const commandStart = raw.indexOf("(");
  const commandEnd = raw.lastIndexOf(")");
  if (commandStart <= 0 || commandEnd <= commandStart) {
    return null;
  }
  const pid = Number.parseInt(raw.slice(0, commandStart).trim(), 10);
  const fields = raw
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const state = fields[0];
  const processGroupId = Number.parseInt(fields[2] ?? "", 10);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !state ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0
  ) {
    return null;
  }
  return {
    command: raw.slice(commandStart + 1, commandEnd),
    pid,
    processGroupId,
    state,
  };
}

function boundProcessGroupDiagnostics(details: string) {
  if (details.length <= 2_048) {
    return details;
  }
  return `${sliceUtf16Safe(details, 0, 2_045)}...`;
}

export function inspectLinuxProcessGroupStats(processGroupId: number, stats: readonly string[]) {
  const members = stats
    .map((raw) => parseLinuxProcessStat(raw))
    .filter(
      (entry): entry is NonNullable<ReturnType<typeof parseLinuxProcessStat>> =>
        entry?.processGroupId === processGroupId,
    )
    .toSorted((left, right) => left.pid - right.pid);
  const diagnostics = members
    .map(
      (member) =>
        `pid=${member.pid} state=${member.state} command=${JSON.stringify(member.command)}`,
    )
    .join(", ");
  return {
    alive:
      members.length === 0
        ? null
        : members.some((entry) => entry.state !== "Z" && entry.state !== "X"),
    diagnostics: boundProcessGroupDiagnostics(`pgid=${processGroupId} members=[${diagnostics}]`),
  };
}

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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (process.platform !== "linux") {
    return true;
  }
  return inspectLinuxProcessGroupFn(processGroupId)?.alive ?? true;
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
