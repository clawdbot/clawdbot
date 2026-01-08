import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  GATEWAY_WINDOWS_TASK_NAME,
  LEGACY_GATEWAY_WINDOWS_TASK_NAMES,
} from "./constants.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";

const execFileAsync = promisify(execFile);

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.USERPROFILE?.trim() || env.HOME?.trim();
  if (!home) throw new Error("Missing HOME");
  return home;
}

function resolveTaskScriptPath(
  env: Record<string, string | undefined>,
): string {
  const home = resolveHomeDir(env);
  return path.join(home, ".clawdbot", "gateway.cmd");
}

function resolveLegacyTaskScriptPath(
  env: Record<string, string | undefined>,
): string {
  const home = resolveHomeDir(env);
  return path.join(home, ".clawdis", "gateway.cmd");
}

function quoteCmdArg(value: string): string {
  if (!/[ \t"]/g.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function parseCommandLine(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let escapeNext = false;

  for (const char of value) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

export async function readScheduledTaskCommand(
  env: Record<string, string | undefined>,
): Promise<{ programArguments: string[]; workingDirectory?: string } | null> {
  const scriptPath = resolveTaskScriptPath(env);
  try {
    const content = await fs.readFile(scriptPath, "utf8");
    let workingDirectory = "";
    let commandLine = "";
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("@echo")) continue;
      if (line.toLowerCase().startsWith("rem ")) continue;
      if (line.toLowerCase().startsWith("set ")) continue;
      if (line.toLowerCase().startsWith("cd /d ")) {
        workingDirectory = line
          .slice("cd /d ".length)
          .trim()
          .replace(/^"|"$/g, "");
        continue;
      }
      commandLine = line;
      break;
    }
    if (!commandLine) return null;
    return {
      programArguments: parseCommandLine(commandLine),
      ...(workingDirectory ? { workingDirectory } : {}),
    };
  } catch {
    return null;
  }
}

export type ScheduledTaskInfo = {
  status?: string;
  lastRunTime?: string;
  lastRunResult?: string;
};

export function parseSchtasksQuery(output: string): ScheduledTaskInfo {
  const info: ScheduledTaskInfo = {};
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!value) continue;
    if (key === "status") {
      info.status = value;
    } else if (key === "last run time") {
      info.lastRunTime = value;
    } else if (key === "last run result") {
      info.lastRunResult = value;
    }
  }
  return info;
}

function buildTaskScript({
  programArguments,
  workingDirectory,
  environment,
}: {
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
}): string {
  const lines: string[] = ["@echo off"];
  if (workingDirectory) {
    lines.push(`cd /d ${quoteCmdArg(workingDirectory)}`);
  }
  if (environment) {
    for (const [key, value] of Object.entries(environment)) {
      if (!value) continue;
      lines.push(`set ${key}=${value}`);
    }
  }
  const command = programArguments.map(quoteCmdArg).join(" ");
  lines.push(command);
  return `${lines.join("\r\n")}\r\n`;
}

async function execSchtasks(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("schtasks", args, {
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string"
          ? e.stderr
          : typeof e.message === "string"
            ? e.message
            : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

async function assertSchtasksAvailable() {
  const res = await execSchtasks(["/Query"]);
  if (res.code === 0) return;
  const detail = res.stderr || res.stdout;
  throw new Error(`schtasks unavailable: ${detail || "unknown error"}`.trim());
}

export async function installScheduledTask({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
}): Promise<{ scriptPath: string }> {
  await assertSchtasksAvailable();
  const scriptPath = resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  const script = buildTaskScript({
    programArguments,
    workingDirectory,
    environment,
  });
  await fs.writeFile(scriptPath, script, "utf8");

  const quotedScript = quoteCmdArg(scriptPath);
  const create = await execSchtasks([
    "/Create",
    "/F",
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/TN",
    GATEWAY_WINDOWS_TASK_NAME,
    "/TR",
    quotedScript,
  ]);
  if (create.code !== 0) {
    throw new Error(
      `schtasks create failed: ${create.stderr || create.stdout}`.trim(),
    );
  }

  await execSchtasks(["/Run", "/TN", GATEWAY_WINDOWS_TASK_NAME]);
  stdout.write(`Installed Scheduled Task: ${GATEWAY_WINDOWS_TASK_NAME}\n`);
  stdout.write(`Task script: ${scriptPath}\n`);
  return { scriptPath };
}

export async function uninstallScheduledTask({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSchtasksAvailable();
  await execSchtasks(["/Delete", "/F", "/TN", GATEWAY_WINDOWS_TASK_NAME]);

  const scriptPath = resolveTaskScriptPath(env);
  try {
    await fs.unlink(scriptPath);
    stdout.write(`Removed task script: ${scriptPath}\n`);
  } catch {
    stdout.write(`Task script not found at ${scriptPath}\n`);
  }
}

function isTaskNotRunning(res: {
  stdout: string;
  stderr: string;
  code: number;
}): boolean {
  const detail = `${res.stderr || res.stdout}`.toLowerCase();
  return detail.includes("not running");
}

export async function stopScheduledTask({
  stdout,
}: {
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSchtasksAvailable();
  const res = await execSchtasks(["/End", "/TN", GATEWAY_WINDOWS_TASK_NAME]);
  if (res.code !== 0 && !isTaskNotRunning(res)) {
    throw new Error(`schtasks end failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`Stopped Scheduled Task: ${GATEWAY_WINDOWS_TASK_NAME}\n`);
}

export async function restartScheduledTask({
  stdout,
}: {
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSchtasksAvailable();
  await execSchtasks(["/End", "/TN", GATEWAY_WINDOWS_TASK_NAME]);
  const res = await execSchtasks(["/Run", "/TN", GATEWAY_WINDOWS_TASK_NAME]);
  if (res.code !== 0) {
    throw new Error(`schtasks run failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`Restarted Scheduled Task: ${GATEWAY_WINDOWS_TASK_NAME}\n`);
}

export async function isScheduledTaskInstalled(): Promise<boolean> {
  await assertSchtasksAvailable();
  const res = await execSchtasks(["/Query", "/TN", GATEWAY_WINDOWS_TASK_NAME]);
  return res.code === 0;
}

export async function readScheduledTaskRuntime(): Promise<GatewayServiceRuntime> {
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    return {
      status: "unknown",
      detail: String(err),
    };
  }
  const res = await execSchtasks([
    "/Query",
    "/TN",
    GATEWAY_WINDOWS_TASK_NAME,
    "/V",
    "/FO",
    "LIST",
  ]);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    const missing = detail.toLowerCase().includes("cannot find the file");
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseSchtasksQuery(res.stdout || "");
  const statusRaw = parsed.status?.toLowerCase();
  const status =
    statusRaw === "running" ? "running" : statusRaw ? "stopped" : "unknown";
  return {
    status,
    state: parsed.status,
    lastRunTime: parsed.lastRunTime,
    lastRunResult: parsed.lastRunResult,
  };
}
export type LegacyScheduledTask = {
  name: string;
  scriptPath: string;
  installed: boolean;
  scriptExists: boolean;
};

export async function findLegacyScheduledTasks(
  env: Record<string, string | undefined>,
): Promise<LegacyScheduledTask[]> {
  const results: LegacyScheduledTask[] = [];
  let schtasksAvailable = true;
  try {
    await assertSchtasksAvailable();
  } catch {
    schtasksAvailable = false;
  }

  for (const name of LEGACY_GATEWAY_WINDOWS_TASK_NAMES) {
    const scriptPath = resolveLegacyTaskScriptPath(env);
    let installed = false;
    if (schtasksAvailable) {
      const res = await execSchtasks(["/Query", "/TN", name]);
      installed = res.code === 0;
    }
    let scriptExists = false;
    try {
      await fs.access(scriptPath);
      scriptExists = true;
    } catch {
      // ignore
    }
    if (installed || scriptExists) {
      results.push({ name, scriptPath, installed, scriptExists });
    }
  }

  return results;
}

export async function uninstallLegacyScheduledTasks({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<LegacyScheduledTask[]> {
  const tasks = await findLegacyScheduledTasks(env);
  if (tasks.length === 0) return tasks;

  let schtasksAvailable = true;
  try {
    await assertSchtasksAvailable();
  } catch {
    schtasksAvailable = false;
  }

  for (const task of tasks) {
    if (schtasksAvailable && task.installed) {
      await execSchtasks(["/Delete", "/F", "/TN", task.name]);
    } else if (!schtasksAvailable && task.installed) {
      stdout.write(
        `schtasks unavailable; unable to remove legacy task: ${task.name}\n`,
      );
    }

    try {
      await fs.unlink(task.scriptPath);
      stdout.write(`Removed legacy task script: ${task.scriptPath}\n`);
    } catch {
      stdout.write(`Legacy task script not found at ${task.scriptPath}\n`);
    }
  }

  return tasks;
}
