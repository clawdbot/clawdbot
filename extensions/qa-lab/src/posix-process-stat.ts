// Qa Lab parses Linux process stat snapshots for process-group ownership.
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
