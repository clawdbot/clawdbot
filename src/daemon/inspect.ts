import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "./constants.js";
import { resolveHomeDir } from "./paths.js";
import { execSchtasks } from "./schtasks-exec.js";
import { parseSystemdExecStart } from "./systemd-unit.js";

export type ExtraGatewayService = {
  platform: "darwin" | "linux" | "win32";
  label: string;
  detail: string;
  scope: "user" | "system";
  marker?: "openclaw" | "clawdbot";
  legacy?: boolean;
};

export type FindExtraGatewayServicesOptions = {
  deep?: boolean;
};

const EXTRA_MARKERS = ["openclaw", "clawdbot"] as const;
const SYSTEMD_REFERENCE_ONLY_KEYS = new Set([
  "after",
  "before",
  "bindsto",
  "conflicts",
  "partof",
  "propagatesreloadto",
  "reloadpropagatedfrom",
  "requisite",
  "requires",
  "upholds",
  "wants",
]);

export function renderGatewayServiceCleanupHints(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string[] {
  const profile = env.OPENCLAW_PROFILE;
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

type Marker = (typeof EXTRA_MARKERS)[number];

function hasGatewaySubcommandArg(args: string[]): boolean {
  return args.some((arg) => {
    const normalized = normalizeLowercaseStringOrEmpty(arg);
    return normalized === "gateway" || /(^|\s)gateway(\s|$)/.test(normalized);
  });
}

export function detectMarkerLineWithGateway(contents: string): Marker | null {
  // Join line continuations (trailing backslash) into single lines
  const lower = normalizeLowercaseStringOrEmpty(contents.replace(/\\\r?\n\s*/g, " "));
  for (const line of lower.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const assignment = trimmed.indexOf("=");
    if (assignment > 0) {
      const key = trimmed.slice(0, assignment).trim();
      if (SYSTEMD_REFERENCE_ONLY_KEYS.has(key)) {
        continue;
      }
      if (
        key === "execstart" &&
        !hasGatewaySubcommandArg(parseSystemdExecStart(trimmed.slice(assignment + 1).trim()))
      ) {
        continue;
      }
      if (key !== "execstart") {
        continue;
      }
    }
    if (!trimmed.includes("gateway")) {
      continue;
    }
    for (const marker of EXTRA_MARKERS) {
      if (trimmed.includes(marker)) {
        return marker;
      }
    }
  }
  return null;
}

function hasGatewayServiceMarker(content: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(content);
  const markerKeys = ["openclaw_service_marker"];
  const kindKeys = ["openclaw_service_kind"];
  const markerValues = [normalizeLowercaseStringOrEmpty(GATEWAY_SERVICE_MARKER)];
  const hasMarkerKey = markerKeys.some((key) => lower.includes(key));
  const hasKindKey = kindKeys.some((key) => lower.includes(key));
  const hasMarkerValue = markerValues.some((value) => lower.includes(value));
  return (
    hasMarkerKey &&
    hasKindKey &&
    hasMarkerValue &&
    lower.includes(normalizeLowercaseStringOrEmpty(GATEWAY_SERVICE_KIND))
  );
}

function extractPlistKeyBlock(
  contents: string,
  key: string,
  tag: "array" | "string",
): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<key>${escapedKey}<\\/key>\\s*<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "i",
  );
  const match = contents.match(pattern);
  return match?.[1]?.trim() || null;
}

function extractPlistStringValues(
  contents: string,
  key: string,
  tag: "array" | "string",
): string[] {
  const block = extractPlistKeyBlock(contents, key, tag);
  if (!block) {
    return [];
  }
  if (tag === "string") {
    return [block];
  }
  return Array.from(block.matchAll(/<string>([\s\S]*?)<\/string>/gi))
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function detectLaunchdGatewayExecutionMarker(contents: string): Marker | null {
  const program = extractPlistStringValues(contents, "Program", "string");
  const programArguments = extractPlistStringValues(contents, "ProgramArguments", "array");
  if (!hasGatewaySubcommandArg(programArguments)) {
    return null;
  }
  const launchCommand = normalizeLowercaseStringOrEmpty(
    [...program, ...programArguments].filter(Boolean).join("\n"),
  );
  for (const marker of EXTRA_MARKERS) {
    if (launchCommand.includes(marker)) {
      return marker;
    }
  }
  return null;
}

function isOpenClawGatewayLaunchdService(label: string, contents: string): boolean {
  if (hasGatewayServiceMarker(contents)) {
    return true;
  }
  if (detectLaunchdGatewayExecutionMarker(contents) !== "openclaw") {
    return false;
  }
  return label.startsWith("ai.openclaw.");
}

function isOpenClawGatewaySystemdService(name: string, contents: string): boolean {
  if (hasGatewayServiceMarker(contents)) {
    return true;
  }
  if (!name.startsWith("openclaw-gateway")) {
    return false;
  }
  return normalizeLowercaseStringOrEmpty(contents).includes("gateway");
}

function isOpenClawGatewayTaskName(name: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  if (!normalized) {
    return false;
  }
  const defaultName = normalizeLowercaseStringOrEmpty(resolveGatewayWindowsTaskName());
  return normalized === defaultName || normalized.startsWith("openclaw gateway");
}

function tryExtractPlistLabel(contents: string): string | null {
  const match = contents.match(/<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/i);
  if (!match) {
    return null;
  }
  return match[1]?.trim() || null;
}

function isIgnoredLaunchdLabel(label: string): boolean {
  return label === resolveGatewayLaunchAgentLabel();
}

function isIgnoredSystemdName(name: string): boolean {
  return name === resolveGatewaySystemdServiceName();
}

function isLegacyLabel(label: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(label);
  return lower.includes("clawdbot");
}

async function readDirEntries(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function readUtf8File(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

type ServiceFileEntry = {
  entry: string;
  name: string;
  fullPath: string;
  contents: string;
};

async function collectServiceFiles(params: {
  dir: string;
  extension: string;
  isIgnoredName: (name: string) => boolean;
}): Promise<ServiceFileEntry[]> {
  const out: ServiceFileEntry[] = [];
  const entries = await readDirEntries(params.dir);
  for (const entry of entries) {
    if (!entry.endsWith(params.extension)) {
      continue;
    }
    const name = entry.slice(0, -params.extension.length);
    if (params.isIgnoredName(name)) {
      continue;
    }
    const fullPath = path.join(params.dir, entry);
    const contents = await readUtf8File(fullPath);
    if (contents === null) {
      continue;
    }
    out.push({ entry, name, fullPath, contents });
  }
  return out;
}

async function scanLaunchdDir(params: {
  dir: string;
  scope: "user" | "system";
}): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const candidates = await collectServiceFiles({
    dir: params.dir,
    extension: ".plist",
    isIgnoredName: isIgnoredLaunchdLabel,
  });

  for (const { name: labelFromName, fullPath, contents } of candidates) {
    const label = tryExtractPlistLabel(contents) ?? labelFromName;
    const legacyLabel = isLegacyLabel(labelFromName) || isLegacyLabel(label);
    const executionMarker = detectLaunchdGatewayExecutionMarker(contents);
    const marker =
      hasGatewayServiceMarker(contents) || executionMarker === "openclaw"
        ? "openclaw"
        : executionMarker === "clawdbot" || legacyLabel
          ? "clawdbot"
          : null;
    if (!marker) {
      continue;
    }
    if (isIgnoredLaunchdLabel(label)) {
      continue;
    }
    if (marker === "openclaw" && isOpenClawGatewayLaunchdService(label, contents)) {
      continue;
    }
    results.push({
      platform: "darwin",
      label,
      detail: `plist: ${fullPath}`,
      scope: params.scope,
      marker,
      legacy: marker !== "openclaw" || isLegacyLabel(label),
    });
  }

  return results;
}

async function scanSystemdDir(params: {
  dir: string;
  scope: "user" | "system";
  includeManagedOpenClaw?: boolean;
}): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const candidates = await collectServiceFiles({
    dir: params.dir,
    extension: ".service",
    isIgnoredName: params.includeManagedOpenClaw ? () => false : isIgnoredSystemdName,
  });

  for (const { entry, name, fullPath, contents } of candidates) {
    const marker = hasGatewayServiceMarker(contents)
      ? "openclaw"
      : detectMarkerLineWithGateway(contents);
    if (!marker) {
      continue;
    }
    if (
      !params.includeManagedOpenClaw &&
      marker === "openclaw" &&
      isOpenClawGatewaySystemdService(name, contents)
    ) {
      continue;
    }
    results.push({
      platform: "linux",
      label: entry,
      detail: `unit: ${fullPath}`,
      scope: params.scope,
      marker,
      legacy: marker !== "openclaw",
    });
  }

  return results;
}

export async function findSystemGatewayServices(): Promise<ExtraGatewayService[]> {
  if (process.platform !== "linux") {
    return [];
  }

  const results: ExtraGatewayService[] = [];
  try {
    for (const dir of ["/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"]) {
      results.push(
        ...(await scanSystemdDir({
          dir,
          scope: "system",
          includeManagedOpenClaw: true,
        })),
      );
    }
  } catch {
    return [];
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
    if (idx <= 0) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(line.slice(0, idx));
    const value = line.slice(idx + 1).trim();
    if (!value) {
      continue;
    }
    if (key === "taskname") {
      if (current) {
        tasks.push(current);
      }
      current = { name: value };
      continue;
    }
    if (!current) {
      continue;
    }
    if (key === "task to run") {
      current.taskToRun = value;
    }
  }

  if (current) {
    tasks.push(current);
  }
  return tasks;
}

export async function findExtraGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions = {},
): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const seen = new Set<string>();
  const push = (svc: ExtraGatewayService) => {
    const key = `${svc.platform}:${svc.label}:${svc.detail}:${svc.scope}`;
    if (seen.has(key)) {
      return;
    }
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
    if (!opts.deep) {
      return results;
    }
    const res = await execSchtasks(["/Query", "/FO", "LIST", "/V"]);
    if (res.code !== 0) {
      return results;
    }
    const tasks = parseSchtasksList(res.stdout);
    for (const task of tasks) {
      const name = task.name.trim();
      if (!name) {
        continue;
      }
      if (isOpenClawGatewayTaskName(name)) {
        continue;
      }
      const lowerName = normalizeLowercaseStringOrEmpty(name);
      const lowerCommand = normalizeLowercaseStringOrEmpty(task.taskToRun ?? "");
      let marker: Marker | null = null;
      for (const candidate of EXTRA_MARKERS) {
        if (lowerName.includes(candidate) || lowerCommand.includes(candidate)) {
          marker = candidate;
          break;
        }
      }
      if (!marker) {
        continue;
      }
      push({
        platform: "win32",
        label: name,
        detail: task.taskToRun ? `task: ${name}, run: ${task.taskToRun}` : name,
        scope: "system",
        marker,
        legacy: marker !== "openclaw",
      });
    }
    return results;
  }

  return results;
}
