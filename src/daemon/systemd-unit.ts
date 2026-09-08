/** Renders and parses systemd unit snippets for managed gateway services. */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import type { GatewayServiceRenderArgs } from "./service-types.js";

const SYSTEMD_LINE_BREAKS = /[\r\n]/;

function assertNoSystemdLineBreaks(value: string, label: string): void {
  if (SYSTEMD_LINE_BREAKS.test(value)) {
    throw new Error(`${label} cannot contain CR or LF characters.`);
  }
}

function systemdEscapeArg(value: string): string {
  assertNoSystemdLineBreaks(value, "Systemd unit values");
  if (!/[\s"\\]/.test(value)) {
    return value;
  }
  // systemd ExecStart/Environment parsing consumes one backslash before the next
  // character, so every backslash and quote must be escaped for the value to
  // survive the round-trip byte-for-byte. Escaping only backslash pairs left a
  // lone backslash unescaped, and the reader then swallowed the byte after it.
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function renderEnvLines(env: Record<string, string | undefined> | undefined): string[] {
  if (!env) {
    return [];
  }
  // An explicit empty NODE_OPTIONS blocks inherited supervisor preload/heap flags.
  const entries = Object.entries(env).filter(
    ([key, value]) => typeof value === "string" && (value.trim() || key === "NODE_OPTIONS"),
  );
  if (entries.length === 0) {
    return [];
  }
  return entries.map(([key, value]) => {
    const rawValue = value ?? "";
    assertNoSystemdLineBreaks(key, "Systemd environment variable names");
    assertNoSystemdLineBreaks(rawValue, "Systemd environment variable values");
    return `Environment=${systemdEscapeArg(`${key}=${rawValue.trim()}`)}`;
  });
}

function renderEnvironmentFileLines(environmentFiles: string[] | undefined): string[] {
  if (!environmentFiles) {
    return [];
  }
  return normalizeStringEntries(environmentFiles).map((entry) => {
    assertNoSystemdLineBreaks(entry, "Systemd EnvironmentFile values");
    return `EnvironmentFile=-${systemdEscapeArg(entry)}`;
  });
}

export function buildSystemdUnit({
  description,
  programArguments,
  workingDirectory,
  environment,
  environmentFiles,
}: GatewayServiceRenderArgs): string {
  const execStart = programArguments.map(systemdEscapeArg).join(" ");
  const descriptionValue = description?.trim() || "OpenClaw Gateway";
  assertNoSystemdLineBreaks(descriptionValue, "Systemd Description");
  const descriptionLine = `Description=${descriptionValue}`;
  const workingDirLine = workingDirectory
    ? `WorkingDirectory=${systemdEscapeArg(workingDirectory)}`
    : null;
  const envLines = renderEnvLines(environment);
  const environmentFileLines = renderEnvironmentFileLines(environmentFiles);
  return [
    "[Unit]",
    descriptionLine,
    "After=network-online.target",
    "Wants=network-online.target",
    "StartLimitBurst=5",
    "StartLimitIntervalSec=60",
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=5",
    "RestartPreventExitStatus=78",
    // Cover the gateway's five-minute SIGTERM drain plus its teardown reserve.
    "TimeoutStopSec=330",
    "TimeoutStartSec=30",
    "SuccessExitStatus=0 143",
    // Transient child processes may be selected by the OOM killer before the
    // gateway. Keep the service running when that happens; the child surface is
    // already responsible for reporting the failed command/session.
    "OOMPolicy=continue",
    // Signal only the gateway during drain; systemd still kills remaining
    // children when the gateway exits or TimeoutStopSec expires.
    "KillMode=mixed",
    workingDirLine,
    ...environmentFileLines,
    ...envLines,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function parseSystemdExecStart(value: string): string[] {
  return splitArgsPreservingQuotes(value, { escapeMode: "backslash" });
}

export function parseSystemdEnvAssignments(raw: string): Array<{ key: string; value: string }> {
  return splitArgsPreservingQuotes(raw, {
    escapeMode: "backslash",
    quoteChars: ['"', "'"],
    quoteStart: "item-start",
  }).flatMap((entry) => {
    // The splitter has already removed quotes and consumed escapes.
    const assignment = entry.trim();
    const separator = assignment.indexOf("=");
    return separator <= 0
      ? []
      : [{ key: assignment.slice(0, separator).trim(), value: assignment.slice(separator + 1) }];
  });
}

export function splitSystemdLogicalLines(content: string): string[] {
  const lines: string[] = [];
  let continued = "";
  for (const physicalLine of content.split(/\r?\n/)) {
    // systemd skips physical comments before continuation handling. Keep standalone
    // comments for unit rewrites, but never let their backslashes consume directives.
    if (/^\s*[#;]/u.test(physicalLine)) {
      if (!continued) {
        lines.push(physicalLine);
      }
      continue;
    }
    const line = continued + physicalLine;
    // Only an unmatched final backslash continues; indentation inside quotes is data.
    if (/(?:^|[^\\])(?:\\\\)*\\$/u.test(line)) {
      continued = `${line.slice(0, -1)} `;
    } else {
      lines.push(line);
      continued = "";
    }
  }
  return continued ? [...lines, continued] : lines;
}

export function renderSystemdEnvAssignment(key: string, value: string): string {
  return systemdEscapeArg(`${key}=${value}`);
}
