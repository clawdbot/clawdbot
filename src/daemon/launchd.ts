import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { colorize, isRich, theme } from "../terminal/theme.js";
import {
  formatGatewayServiceDescription,
  GATEWAY_LAUNCH_AGENT_LABEL,
  LEGACY_GATEWAY_LAUNCH_AGENT_LABELS,
  resolveGatewayLaunchAgentLabel,
} from "./constants.js";
import {
  buildLaunchAgentPlist as buildLaunchAgentPlistImpl,
  readLaunchAgentProgramArgumentsFromFile,
} from "./launchd-plist.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";

const execFileAsync = promisify(execFile);

const formatLine = (label: string, value: string) => {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
};

function resolveLaunchAgentLabel(args?: { env?: Record<string, string | undefined> }): string {
  const envLabel = args?.env?.CLAWDBOT_LAUNCHD_LABEL?.trim();
  if (envLabel) return envLabel;
  return resolveGatewayLaunchAgentLabel(args?.env?.CLAWDBOT_PROFILE);
}
function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) throw new Error("Missing HOME");
  return home;
}

function resolveLaunchAgentPlistPathForLabel(
  env: Record<string, string | undefined>,
  label: string,
): string {
  const home = resolveHomeDir(env);
  return path.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export function resolveLaunchAgentPlistPath(env: Record<string, string | undefined>): string {
  const label = resolveLaunchAgentLabel({ env });
  return resolveLaunchAgentPlistPathForLabel(env, label);
}

export function resolveGatewayLogPaths(env: Record<string, string | undefined>): {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
} {
  const home = resolveHomeDir(env);
  const stateOverride = env.CLAWDBOT_STATE_DIR?.trim();
  const profile = env.CLAWDBOT_PROFILE?.trim();
  const suffix = profile && profile.toLowerCase() !== "default" ? `-${profile}` : "";
  const defaultStateDir = path.join(home, `.clawdbot${suffix}`);
  const stateDir = stateOverride ? resolveUserPathWithHome(stateOverride, home) : defaultStateDir;
  const logDir = path.join(stateDir, "logs");
  return {
    logDir,
    stdoutPath: path.join(logDir, "gateway.log"),
    stderrPath: path.join(logDir, "gateway.err.log"),
  };
}

function resolveUserPathWithHome(input: string, home: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, home);
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

export async function readLaunchAgentProgramArguments(
  env: Record<string, string | undefined>,
): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  sourcePath?: string;
} | null> {
  const plistPath = resolveLaunchAgentPlistPath(env);
  return readLaunchAgentProgramArgumentsFromFile(plistPath);
}

export function buildLaunchAgentPlist({
  label = GATEWAY_LAUNCH_AGENT_LABEL,
  comment,
  programArguments,
  workingDirectory,
  stdoutPath,
  stderrPath,
  environment,
}: {
  label?: string;
  comment?: string;
  programArguments: string[];
  workingDirectory?: string;
  stdoutPath: string;
  stderrPath: string;
  environment?: Record<string, string | undefined>;
}): string {
  return buildLaunchAgentPlistImpl({
    label,
    comment,
    programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath,
    environment,
  });
}

async function execLaunchctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("launchctl", args, {
      encoding: "utf8",
      shell: process.platform === "win32",
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

function resolveGuiDomain(): string {
  if (typeof process.getuid !== "function") return "gui/501";
  return `gui/${process.getuid()}`;
}

export type LaunchctlPrintInfo = {
  state?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
};

export function parseLaunchctlPrint(output: string): LaunchctlPrintInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: LaunchctlPrintInfo = {};
  const state = entries.state;
  if (state) info.state = state;
  const pidValue = entries.pid;
  if (pidValue) {
    const pid = Number.parseInt(pidValue, 10);
    if (Number.isFinite(pid)) info.pid = pid;
  }
  const exitStatusValue = entries["last exit status"];
  if (exitStatusValue) {
    const status = Number.parseInt(exitStatusValue, 10);
    if (Number.isFinite(status)) info.lastExitStatus = status;
  }
  const exitReason = entries["last exit reason"];
  if (exitReason) info.lastExitReason = exitReason;
  return info;
}

export async function isLaunchAgentLoaded(args: {
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env: args.env });
  const res = await execLaunchctl(["print", `${domain}/${label}`]);
  return res.code === 0;
}

async function hasLaunchAgentPlist(env: Record<string, string | undefined>): Promise<boolean> {
  const plistPath = resolveLaunchAgentPlistPath(env);
  try {
    await fs.access(plistPath);
    return true;
  } catch {
    return false;
  }
}

export async function readLaunchAgentRuntime(
  env: Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const res = await execLaunchctl(["print", `${domain}/${label}`]);
  if (res.code !== 0) {
    return {
      status: "unknown",
      detail: (res.stderr || res.stdout).trim() || undefined,
      missingUnit: true,
    };
  }
  const parsed = parseLaunchctlPrint(res.stdout || res.stderr || "");
  const plistExists = await hasLaunchAgentPlist(env);
  const state = parsed.state?.toLowerCase();
  const status = state === "running" || parsed.pid ? "running" : state ? "stopped" : "unknown";
  return {
    status,
    state: parsed.state,
    pid: parsed.pid,
    lastExitStatus: parsed.lastExitStatus,
    lastExitReason: parsed.lastExitReason,
    cachedLabel: !plistExists,
  };
}

export type LegacyLaunchAgent = {
  label: string;
  plistPath: string;
  loaded: boolean;
  exists: boolean;
};

export async function findLegacyLaunchAgents(
  env: Record<string, string | undefined>,
): Promise<LegacyLaunchAgent[]> {
  const domain = resolveGuiDomain();
  const results: LegacyLaunchAgent[] = [];
  for (const label of LEGACY_GATEWAY_LAUNCH_AGENT_LABELS) {
    const plistPath = resolveLaunchAgentPlistPathForLabel(env, label);
    const res = await execLaunchctl(["print", `${domain}/${label}`]);
    const loaded = res.code === 0;
    let exists = false;
    try {
      await fs.access(plistPath);
      exists = true;
    } catch {
      // ignore
    }
    if (loaded || exists) {
      results.push({ label, plistPath, loaded, exists });
    }
  }
  return results;
}

export async function uninstallLegacyLaunchAgents({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<LegacyLaunchAgent[]> {
  const domain = resolveGuiDomain();
  const agents = await findLegacyLaunchAgents(env);
  if (agents.length === 0) return agents;

  const home = resolveHomeDir(env);
  const trashDir = path.join(home, ".Trash");
  try {
    await fs.mkdir(trashDir, { recursive: true });
  } catch {
    // ignore
  }

  for (const agent of agents) {
    await execLaunchctl(["bootout", domain, agent.plistPath]);
    await execLaunchctl(["unload", agent.plistPath]);

    try {
      await fs.access(agent.plistPath);
    } catch {
      continue;
    }

    const dest = path.join(trashDir, `${agent.label}.plist`);
    try {
      await fs.rename(agent.plistPath, dest);
      stdout.write(`${formatLine("Moved legacy LaunchAgent to Trash", dest)}\n`);
    } catch {
      stdout.write(`Legacy LaunchAgent remains at ${agent.plistPath} (could not move)\n`);
    }
  }

  return agents;
}

export async function uninstallLaunchAgent({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const plistPath = resolveLaunchAgentPlistPath(env);
  await execLaunchctl(["bootout", domain, plistPath]);
  await execLaunchctl(["unload", plistPath]);

  try {
    await fs.access(plistPath);
  } catch {
    stdout.write(`LaunchAgent not found at ${plistPath}\n`);
    return;
  }

  const home = resolveHomeDir(env);
  const trashDir = path.join(home, ".Trash");
  const dest = path.join(trashDir, `${label}.plist`);
  try {
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(plistPath, dest);
    stdout.write(`${formatLine("Moved LaunchAgent to Trash", dest)}\n`);
  } catch {
    stdout.write(`LaunchAgent remains at ${plistPath} (could not move)\n`);
  }
}

function isLaunchctlNotLoaded(res: { stdout: string; stderr: string; code: number }): boolean {
  const detail = `${res.stderr || res.stdout}`.toLowerCase();
  return (
    detail.includes("no such process") ||
    detail.includes("could not find service") ||
    detail.includes("not found")
  );
}

export async function stopLaunchAgent({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const res = await execLaunchctl(["bootout", `${domain}/${label}`]);
  if (res.code !== 0 && !isLaunchctlNotLoaded(res)) {
    throw new Error(`launchctl bootout failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Stopped LaunchAgent", `${domain}/${label}`)}\n`);
}

export async function installLaunchAgent({
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
}): Promise<{ plistPath: string }> {
  const { logDir, stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
  await fs.mkdir(logDir, { recursive: true });

  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  for (const legacyLabel of LEGACY_GATEWAY_LAUNCH_AGENT_LABELS) {
    const legacyPlistPath = resolveLaunchAgentPlistPathForLabel(env, legacyLabel);
    await execLaunchctl(["bootout", domain, legacyPlistPath]);
    await execLaunchctl(["unload", legacyPlistPath]);
    try {
      await fs.unlink(legacyPlistPath);
    } catch {
      // ignore
    }
  }

  const plistPath = resolveLaunchAgentPlistPathForLabel(env, label);
  await fs.mkdir(path.dirname(plistPath), { recursive: true });

  const description = formatGatewayServiceDescription({
    profile: env.CLAWDBOT_PROFILE,
    version: environment?.CLAWDBOT_SERVICE_VERSION ?? env.CLAWDBOT_SERVICE_VERSION,
  });
  const plist = buildLaunchAgentPlist({
    label,
    comment: description,
    programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath,
    environment,
  });
  await fs.writeFile(plistPath, plist, "utf8");

  await execLaunchctl(["bootout", domain, plistPath]);
  await execLaunchctl(["unload", plistPath]);
  // launchd can persist "disabled" state even after bootout + plist removal; clear it before bootstrap.
  await execLaunchctl(["enable", `${domain}/${label}`]);
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
  if (boot.code !== 0) {
    throw new Error(`launchctl bootstrap failed: ${boot.stderr || boot.stdout}`.trim());
  }
  await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);

  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  stdout.write("\n");
  stdout.write(`${formatLine("Installed LaunchAgent", plistPath)}\n`);
  stdout.write(`${formatLine("Logs", stdoutPath)}\n`);
  return { plistPath };
}

export async function restartLaunchAgent({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const res = await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
  if (res.code !== 0) {
    throw new Error(`launchctl kickstart failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Restarted LaunchAgent", `${domain}/${label}`)}\n`);
}
