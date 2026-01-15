import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { colorize, isRich, theme } from "../terminal/theme.js";
import { formatGatewayServiceDescription, resolveGatewayWindowsTaskName } from "./constants.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";

const execFileAsync = promisify(execFile);

const formatLine = (label: string, value: string) => {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
};

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.USERPROFILE?.trim() || env.HOME?.trim();
  if (!home) throw new Error("Missing HOME");
  return home;
}

export function resolveTaskScriptPath(env: Record<string, string | undefined>): string {
  const home = resolveHomeDir(env);
  const profile = env.CLAWDBOT_PROFILE?.trim();
  const suffix = profile && profile.toLowerCase() !== "default" ? `-${profile}` : "";
  return path.join(home, `.clawdbot${suffix}`, "gateway.cmd");
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

export async function readScheduledTaskCommand(env: Record<string, string | undefined>): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
} | null> {
  const scriptPath = resolveTaskScriptPath(env);
  try {
    const content = await fs.readFile(scriptPath, "utf8");
    let workingDirectory = "";
    let commandLine = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("@echo")) continue;
      if (line.toLowerCase().startsWith("rem ")) continue;
      if (line.toLowerCase().startsWith("set ")) {
        const assignment = line.slice(4).trim();
        const index = assignment.indexOf("=");
        if (index > 0) {
          const key = assignment.slice(0, index).trim();
          const value = assignment.slice(index + 1).trim();
          if (key) environment[key] = value;
        }
        continue;
      }
      if (line.toLowerCase().startsWith("cd /d ")) {
        workingDirectory = line.slice("cd /d ".length).trim().replace(/^"|"$/g, "");
        continue;
      }
      commandLine = line;
      break;
    }
    if (!commandLine) return null;
    return {
      programArguments: parseCommandLine(commandLine),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
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
  const entries = parseKeyValueOutput(output, ":");
  const info: ScheduledTaskInfo = {};
  const status = entries.status;
  if (status) info.status = status;
  const lastRunTime = entries["last run time"];
  if (lastRunTime) info.lastRunTime = lastRunTime;
  const lastRunResult = entries["last run result"];
  if (lastRunResult) info.lastRunResult = lastRunResult;
  return info;
}

function buildTaskScript({
  description,
  programArguments,
  workingDirectory,
  environment,
}: {
  description?: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
}): string {
  const lines: string[] = ["@echo off"];
  if (description?.trim()) {
    lines.push(`rem ${description.trim()}`);
  }
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
        typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "",
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
  const description = formatGatewayServiceDescription({
    profile: env.CLAWDBOT_PROFILE,
    version: environment?.CLAWDBOT_SERVICE_VERSION ?? env.CLAWDBOT_SERVICE_VERSION,
  });
  const script = buildTaskScript({
    description,
    programArguments,
    workingDirectory,
    environment,
  });
  await fs.writeFile(scriptPath, script, "utf8");

  const taskName = resolveGatewayWindowsTaskName(env.CLAWDBOT_PROFILE);
  const quotedScript = quoteCmdArg(scriptPath);
  const create = await execSchtasks([
    "/Create",
    "/F",
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/TN",
    taskName,
    "/TR",
    quotedScript,
  ]);
  if (create.code !== 0) {
    throw new Error(`schtasks create failed: ${create.stderr || create.stdout}`.trim());
  }

  await execSchtasks(["/Run", "/TN", taskName]);
  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  stdout.write("\n");
  stdout.write(`${formatLine("Installed Scheduled Task", taskName)}\n`);
  stdout.write(`${formatLine("Task script", scriptPath)}\n`);
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
  const taskName = resolveGatewayWindowsTaskName(env.CLAWDBOT_PROFILE);
  await execSchtasks(["/Delete", "/F", "/TN", taskName]);

  const scriptPath = resolveTaskScriptPath(env);
  try {
    await fs.unlink(scriptPath);
    stdout.write(`${formatLine("Removed task script", scriptPath)}\n`);
  } catch {
    stdout.write(`Task script not found at ${scriptPath}\n`);
  }
}

function isTaskNotRunning(res: { stdout: string; stderr: string; code: number }): boolean {
  const detail = `${res.stderr || res.stdout}`.toLowerCase();
  return detail.includes("not running");
}

export async function stopScheduledTask({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  await assertSchtasksAvailable();
  const taskName = resolveGatewayWindowsTaskName(env?.CLAWDBOT_PROFILE);
  const res = await execSchtasks(["/End", "/TN", taskName]);
  if (res.code !== 0 && !isTaskNotRunning(res)) {
    throw new Error(`schtasks end failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Stopped Scheduled Task", taskName)}\n`);
}

export async function restartScheduledTask({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  await assertSchtasksAvailable();
  const taskName = resolveGatewayWindowsTaskName(env?.CLAWDBOT_PROFILE);
  await execSchtasks(["/End", "/TN", taskName]);
  const res = await execSchtasks(["/Run", "/TN", taskName]);
  if (res.code !== 0) {
    throw new Error(`schtasks run failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Restarted Scheduled Task", taskName)}\n`);
}

export async function isScheduledTaskInstalled(args: {
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  await assertSchtasksAvailable();
  const taskName = resolveGatewayWindowsTaskName(args.env?.CLAWDBOT_PROFILE);
  const res = await execSchtasks(["/Query", "/TN", taskName]);
  return res.code === 0;
}

export async function readScheduledTaskRuntime(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    return {
      status: "unknown",
      detail: String(err),
    };
  }
  const taskName = resolveGatewayWindowsTaskName(env.CLAWDBOT_PROFILE);
  const res = await execSchtasks(["/Query", "/TN", taskName, "/V", "/FO", "LIST"]);
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
  const status = statusRaw === "running" ? "running" : statusRaw ? "stopped" : "unknown";
  return {
    status,
    state: parsed.status,
    lastRunTime: parsed.lastRunTime,
    lastRunResult: parsed.lastRunResult,
  };
}
