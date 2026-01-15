import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  LEGACY_GATEWAY_LAUNCH_AGENT_LABELS,
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  LEGACY_GATEWAY_WINDOWS_TASK_NAMES,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "./constants.js";

export type ExtraGatewayService = {
  platform: "darwin" | "linux" | "win32";
  label: string;
  detail: string;
  scope: "user" | "system";
};

export type FindExtraGatewayServicesOptions = {
  deep?: boolean;
};

const EXTRA_MARKERS = ["clawdbot"];
const execFileAsync = promisify(execFile);

export function renderGatewayServiceCleanupHints(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string[] {
  const profile = env.CLAWDBOT_PROFILE;
  switch (process.platform) {
    case "darwin": {
      const label = resolveGatewayLaunchAgentLabel(profile);
      return [`launchctl bootout gui/$UID/${label}`, `rm ~/Library/LaunchAgents/${label}.plist`];
    }
    case "linux": {
      const unit = resolveGatewaySystemdServiceName(profile);
      return [
        `systemctl --user disable --now ${unit}.service`,
        `rm ~/.config/systemd/user/${unit}.service`,
      ];
    }
    case "win32": {
      const task = resolveGatewayWindowsTaskName(profile);
      return [`schtasks /Delete /TN "${task}" /F`];
    }
    default:
      return [];
  }
}

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) throw new Error("Missing HOME");
  return home;
}

function containsMarker(content: string): boolean {
  const lower = content.toLowerCase();
  return EXTRA_MARKERS.some((marker) => lower.includes(marker));
}

function hasGatewayServiceMarker(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    lower.includes("clawdbot_service_marker") &&
    lower.includes(GATEWAY_SERVICE_MARKER.toLowerCase()) &&
    lower.includes("clawdbot_service_kind") &&
    lower.includes(GATEWAY_SERVICE_KIND.toLowerCase())
  );
}

function isClawdbotGatewayLaunchdService(label: string, contents: string): boolean {
  if (hasGatewayServiceMarker(contents)) return true;
  const lowerContents = contents.toLowerCase();
  if (!lowerContents.includes("gateway")) return false;
  return label.startsWith("com.clawdbot.");
}

function isClawdbotGatewaySystemdService(name: string, contents: string): boolean {
  if (hasGatewayServiceMarker(contents)) return true;
  if (!name.startsWith("clawdbot-gateway")) return false;
  return contents.toLowerCase().includes("gateway");
}

function isClawdbotGatewayTaskName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  const defaultName = resolveGatewayWindowsTaskName().toLowerCase();
  return normalized === defaultName || normalized.startsWith("clawdbot gateway");
}

function tryExtractPlistLabel(contents: string): string | null {
  const match = contents.match(/<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/i);
  if (!match) return null;
  return match[1]?.trim() || null;
}

function isIgnoredLaunchdLabel(label: string): boolean {
  return (
    label === resolveGatewayLaunchAgentLabel() || LEGACY_GATEWAY_LAUNCH_AGENT_LABELS.includes(label)
  );
}

function isIgnoredSystemdName(name: string): boolean {
  return (
    name === resolveGatewaySystemdServiceName() ||
    LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES.includes(name)
  );
}

async function scanLaunchdDir(params: {
  dir: string;
  scope: "user" | "system";
}): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(params.dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".plist")) continue;
    const labelFromName = entry.replace(/\.plist$/, "");
    if (isIgnoredLaunchdLabel(labelFromName)) continue;
    const fullPath = path.join(params.dir, entry);
    let contents = "";
    try {
      contents = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    if (!containsMarker(contents)) continue;
    const label = tryExtractPlistLabel(contents) ?? labelFromName;
    if (isIgnoredLaunchdLabel(label)) continue;
    if (isClawdbotGatewayLaunchdService(label, contents)) continue;
    results.push({
      platform: "darwin",
      label,
      detail: `plist: ${fullPath}`,
      scope: params.scope,
    });
  }

  return results;
}

async function scanSystemdDir(params: {
  dir: string;
  scope: "user" | "system";
}): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(params.dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".service")) continue;
    const name = entry.replace(/\.service$/, "");
    if (isIgnoredSystemdName(name)) continue;
    const fullPath = path.join(params.dir, entry);
    let contents = "";
    try {
      contents = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    if (!containsMarker(contents)) continue;
    if (isClawdbotGatewaySystemdService(name, contents)) continue;
    results.push({
      platform: "linux",
      label: entry,
      detail: `unit: ${fullPath}`,
      scope: params.scope,
    });
  }

  return results;
}

type ScheduledTaskInfo = {
  name: string;
  taskToRun?: string;
};

function parseSchtasksList(output: string): ScheduledTaskInfo[] {
  const tasks: ScheduledTaskInfo[] = [];
  let current: ScheduledTaskInfo | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current) {
        tasks.push(current);
        current = null;
      }
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!value) continue;
    if (key === "taskname") {
      if (current) tasks.push(current);
      current = { name: value };
      continue;
    }
    if (!current) continue;
    if (key === "task to run") {
      current.taskToRun = value;
    }
  }

  if (current) tasks.push(current);
  return tasks;
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

export async function findExtraGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions = {},
): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const seen = new Set<string>();
  const push = (svc: ExtraGatewayService) => {
    const key = `${svc.platform}:${svc.label}:${svc.detail}:${svc.scope}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(svc);
  };

  if (process.platform === "darwin") {
    try {
      const home = resolveHomeDir(env);
      const userDir = path.join(home, "Library", "LaunchAgents");
      for (const svc of await scanLaunchdDir({
        dir: userDir,
        scope: "user",
      })) {
        push(svc);
      }
      if (opts.deep) {
        for (const svc of await scanLaunchdDir({
          dir: path.join(path.sep, "Library", "LaunchAgents"),
          scope: "system",
        })) {
          push(svc);
        }
        for (const svc of await scanLaunchdDir({
          dir: path.join(path.sep, "Library", "LaunchDaemons"),
          scope: "system",
        })) {
          push(svc);
        }
      }
    } catch {
      return results;
    }
    return results;
  }

  if (process.platform === "linux") {
    try {
      const home = resolveHomeDir(env);
      const userDir = path.join(home, ".config", "systemd", "user");
      for (const svc of await scanSystemdDir({
        dir: userDir,
        scope: "user",
      })) {
        push(svc);
      }
      if (opts.deep) {
        for (const dir of [
          "/etc/systemd/system",
          "/usr/lib/systemd/system",
          "/lib/systemd/system",
        ]) {
          for (const svc of await scanSystemdDir({
            dir,
            scope: "system",
          })) {
            push(svc);
          }
        }
      }
    } catch {
      return results;
    }
    return results;
  }

  if (process.platform === "win32") {
    if (!opts.deep) return results;
    const res = await execSchtasks(["/Query", "/FO", "LIST", "/V"]);
    if (res.code !== 0) return results;
    const tasks = parseSchtasksList(res.stdout);
    for (const task of tasks) {
      const name = task.name.trim();
      if (!name) continue;
      if (isClawdbotGatewayTaskName(name)) continue;
      if (LEGACY_GATEWAY_WINDOWS_TASK_NAMES.includes(name)) continue;
      const lowerName = name.toLowerCase();
      const lowerCommand = task.taskToRun?.toLowerCase() ?? "";
      const matches = EXTRA_MARKERS.some(
        (marker) => lowerName.includes(marker) || lowerCommand.includes(marker),
      );
      if (!matches) continue;
      push({
        platform: "win32",
        label: name,
        detail: task.taskToRun ? `task: ${name}, run: ${task.taskToRun}` : name,
        scope: "system",
      });
    }
    return results;
  }

  return results;
}
