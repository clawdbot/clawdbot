// Native task/process inspection and sanitized proof rendering.
import { spawnSync } from "node:child_process";
import os from "node:os";
import { expect } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { execSchtasks } from "./schtasks-exec.js";

export const DIAGNOSTIC_TEXT_LIMIT = 16_384;
const DIAGNOSTIC_PROCESS_LIMIT = 32;
export const TASK_LOGON_INTERACTIVE_TOKEN = 3;
export const TASK_RUNLEVEL_LEAST_PRIVILEGE = 0;

export type ScheduledTaskPrincipal = {
  enabled: boolean;
  lastRunTime: string;
  lastTaskResult: number;
  logonType: number;
  runLevel: number;
  taskState: number;
};

export type WindowsProcessDiagnostic = {
  CommandLine?: string | null;
  ParentProcessId?: number;
  ProcessId?: number;
};

export async function readTaskXml(taskName: string): Promise<string | null> {
  const result = await execSchtasks(["/Query", "/TN", taskName, "/XML"]);
  return result.code === 0
    ? result.stdout.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), "")
    : null;
}

export function readTaskPrincipal(taskName: string): ScheduledTaskPrincipal {
  const encodedTaskName = Buffer.from(taskName, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "$service=New-Object -ComObject 'Schedule.Service'",
    "$service.Connect()",
    "$task=$service.GetFolder('\\').GetTask($taskName)",
    "$principal=$task.Definition.Principal",
    "$result=@{enabled=[bool]$task.Enabled;logonType=[int]$principal.LogonType;runLevel=[int]$principal.RunLevel;taskState=[int]$task.State;lastTaskResult=[int64]$task.LastTaskResult;lastRunTime=$task.LastRunTime.ToUniversalTime().ToString('o')}",
    "[Console]::Out.Write(($result | ConvertTo-Json -Compress))",
  ].join("; ");
  const result = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not inspect Scheduled Task principal for ${taskName}: ${
        result.stderr.trim() || `PowerShell exited ${result.status ?? "without status"}`
      }`,
    );
  }
  const parsed = JSON.parse(result.stdout.trim()) as Partial<ScheduledTaskPrincipal>;
  if (
    typeof parsed.enabled !== "boolean" ||
    typeof parsed.logonType !== "number" ||
    !Number.isInteger(parsed.logonType) ||
    typeof parsed.runLevel !== "number" ||
    !Number.isInteger(parsed.runLevel) ||
    typeof parsed.taskState !== "number" ||
    !Number.isInteger(parsed.taskState) ||
    typeof parsed.lastTaskResult !== "number" ||
    !Number.isInteger(parsed.lastTaskResult) ||
    typeof parsed.lastRunTime !== "string"
  ) {
    throw new Error(`Scheduled Task principal returned invalid data for ${taskName}`);
  }
  return {
    enabled: parsed.enabled,
    lastRunTime: parsed.lastRunTime,
    lastTaskResult: parsed.lastTaskResult,
    logonType: parsed.logonType,
    runLevel: parsed.runLevel,
    taskState: parsed.taskState,
  };
}

export function readRelatedProcessDiagnostics(needles: string[]): {
  error: string | null;
  ok: boolean;
  processes: WindowsProcessDiagnostic[];
  truncated: boolean;
} {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000, windowsHide: true },
  );
  if (result.error) {
    return { error: result.error.message, ok: false, processes: [], truncated: false };
  }
  if (result.status !== 0) {
    return {
      error: result.stderr.trim() || `PowerShell exited ${result.status ?? "without status"}`,
      ok: false,
      processes: [],
      truncated: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "[]");
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      processes: [],
      truncated: false,
    };
  }
  const entries = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (entry): entry is WindowsProcessDiagnostic => typeof entry === "object" && entry !== null,
  );
  const normalizedNeedles = needles.map((needle) => needle.replaceAll("/", "\\").toLowerCase());
  const matching = entries.filter((entry) => {
    const commandLine = (entry.CommandLine ?? "").replaceAll("/", "\\").toLowerCase();
    return normalizedNeedles.some((needle) => commandLine.includes(needle));
  });
  const parentPids = new Set(
    matching
      .map((entry) => entry.ParentProcessId)
      .filter((pid): pid is number => typeof pid === "number"),
  );
  const processes = entries.filter(
    (entry) =>
      matching.includes(entry) ||
      (typeof entry.ProcessId === "number" && parentPids.has(entry.ProcessId)),
  );
  return {
    error: null,
    ok: true,
    processes: processes.slice(0, DIAGNOSTIC_PROCESS_LIMIT),
    truncated: processes.length > DIAGNOSTIC_PROCESS_LIMIT,
  };
}

export function sanitizeDiagnosticText(
  value: string | null | undefined,
  replacements: Array<[string, string]>,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const variantPlaceholders = new Map<string, string>();
  for (const [privateValue, placeholder] of replacements) {
    if (privateValue) {
      for (const variant of new Set([
        privateValue,
        privateValue.replaceAll("/", "\\"),
        privateValue.replaceAll("\\", "/"),
      ])) {
        variantPlaceholders.set(variant.toLowerCase(), placeholder);
      }
    }
  }
  const pattern = Array.from(variantPlaceholders.keys())
    .toSorted((left, right) => right.length - left.length)
    .map((variant) => variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const sanitized = pattern
    ? value.replace(new RegExp(pattern, "giu"), (match) => {
        return variantPlaceholders.get(match.toLowerCase()) ?? match;
      })
    : value;
  return sanitized.length <= DIAGNOSTIC_TEXT_LIMIT
    ? sanitized
    : `${sanitized.slice(0, DIAGNOSTIC_TEXT_LIMIT)}\n[truncated]`;
}

export function sanitizeTaskXml(
  value: string | null,
  replacements: Array<[string, string]>,
): string | null {
  const identityRedacted =
    value?.replace(
      /<(UserId|Author)>([\s\S]*?)<\/\1>/giu,
      (_match, tag: string) => `<${tag}><task-user></${tag}>`,
    ) ?? null;
  if (identityRedacted === null) {
    return null;
  }
  return identityRedacted
    .split(/(<[^>]+>)/gu)
    .map((segment) =>
      segment.startsWith("<") ? segment : (sanitizeDiagnosticText(segment, replacements) ?? ""),
    )
    .join("");
}

export function sanitizeVerboseQuery(
  value: string,
  replacements: Array<[string, string]>,
): string | null {
  return (
    sanitizeDiagnosticText(value, replacements)?.replace(
      /^(\s*(?:HostName|Run As User)\s*:\s*).*$/gimu,
      "$1<redacted>",
    ) ?? null
  );
}

export function resolveDiagnosticReplacements(params: {
  rootDir: string;
  stateDir: string;
}): Array<[string, string]> {
  const username = os.userInfo().username;
  const domain = process.env.USERDOMAIN?.trim();
  return [
    [os.userInfo().homedir, "<account-home>"],
    [params.rootDir, "<integration-root>"],
    [params.stateDir, "<state-dir>"],
    [domain && username ? `${domain}\\${username}` : "", "<task-user>"],
    [process.env.COMPUTERNAME?.trim() ?? "", "<host>"],
    [os.hostname(), "<host>"],
  ];
}

export function assertInteractiveLeastPrivilegeTask(params: {
  principal: ScheduledTaskPrincipal;
  taskXml: string;
}): void {
  expect(params.taskXml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(params.principal.logonType).toBe(TASK_LOGON_INTERACTIVE_TOKEN);
  expect(params.principal.runLevel).toBe(TASK_RUNLEVEL_LEAST_PRIVILEGE);
  const exportedRunLevel = params.taskXml.match(/<RunLevel>([^<]+)<\/RunLevel>/u)?.[1];
  // Task Scheduler may omit the default LeastPrivilege node when exporting XML.
  // If present, it must agree with the effective COM principal checked above.
  expect(exportedRunLevel === undefined || exportedRunLevel === "LeastPrivilege").toBe(true);
}
